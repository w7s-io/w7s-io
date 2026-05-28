import type { Context } from "hono";
import { writeAnalyticsEvent } from "../analytics";
import type { Env } from "../env";
import { recordUsageEvent } from "../usage";
import { enforceUsageLimit } from "../usageEnforcement";
import { jsonError, jsonSuccess, parseBearerToken } from "../http";
import { parseGitHubRepository, verifyGitHubRepoAccess } from "../deploy/githubAuth";
import { readDeployArchive } from "../deploy/archive";
import { validateDeployLimits } from "../deploy/deployLimits";
import {
  detectNativeWorkerRoots,
  detectWorkerEntrypoint,
  ENTRYPOINT_CANDIDATES,
  hasNativeWorkerRoot,
  NATIVE_ENTRYPOINT_REQUIREMENT,
  publishIsolateWorker
} from "../deploy/isolatePublisher";
import { hasStaticSite, publishStaticSite } from "../deploy/staticPublisher";
import { readAppManifest } from "../deploy/appManifest";
import { readDeployValues } from "../deploy/deployValues";
import { provisionAppBindings, storeDurableObjectClassRecords } from "../deploy/storageProvisioner";
import {
  buildRpcUploadBindings,
  generateRpcToken,
  hashRpcToken,
  W7S_RPC_BINDING
} from "../deploy/rpcBindings";
import {
  buildQueueUploadBindings,
  W7S_QUEUE_BINDING
} from "../deploy/queueBindings";
import {
  buildWorkflowUploadBindings,
  W7S_WORKFLOW_BINDING
} from "../deploy/workflowBindings";
import { buildAiUploadBindings } from "../deploy/aiBindings";
import { generateBindingToken, hashBindingToken } from "../deploy/tokens";
import { provisionAppQueues } from "../deploy/queueProvisioner";
import {
  attachCustomDomainRoutes,
  planCustomDomainClaims,
  readCustomDomains
} from "../deploy/customDomains";
import { buildDeploymentScriptName, buildStableScriptName, requireSlug, resolveEnvironment, sanitizeScriptPart } from "../names";
import {
  replaceCustomDomainMappings,
  replaceQueueMappings,
  replaceScheduleMappings,
  storeDeploymentRecord,
  type DeploymentRecord
} from "../storage/deployments";
import { enforceAppNotSuspended } from "../appLimits";

type HonoContext = Context<{ Bindings: Env }>;

type DeployWarning = {
  code: "native_backend_skipped";
  target: string;
  message: string;
  requiredEntrypoints: string[];
};

const readHeader = (c: HonoContext, name: string) => c.req.header(name)?.trim() ?? "";

const requireHeader = (c: HonoContext, name: string) => {
  const value = readHeader(c, name);
  if (!value) throw new Error(`Missing ${name} header.`);
  return value;
};

const isZipRequest = (request: Request) => {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("application/zip") || contentType.includes("application/octet-stream");
};

const publicDeploymentUrl = (
  env: Env,
  orgSlug: string,
  repoSlug: string,
  environment: string,
  customDomains: string[]
) => {
  if (customDomains[0]) return `https://${customDomains[0]}/`;
  const baseDomain = env.W7S_BASE_DOMAIN?.trim() || "w7s.cloud";
  const host =
    environment === "production"
      ? `${orgSlug}.${baseDomain}`
      : `${sanitizeScriptPart(environment)}--${orgSlug}.${baseDomain}`;
  if (repoSlug === orgSlug) return `https://${host}/`;
  return `https://${host}/${repoSlug}/`;
};

const scriptTagPart = (value: string) =>
  sanitizeScriptPart(value).replace(/[^a-z0-9-]+/g, "-").slice(0, 48) || "unknown";

const buildScriptTags = (params: {
  environment: string;
  orgSlug: string;
  repoSlug: string;
}) => [
  "w7s",
  `w7s-env-${scriptTagPart(params.environment)}`,
  `w7s-owner-${scriptTagPart(params.orgSlug)}`,
  `w7s-repo-${scriptTagPart(params.repoSlug)}`,
  `w7s-app-${scriptTagPart(`${params.orgSlug}-${params.repoSlug}`)}`
];

const nativeEntrypointError = () =>
  `Native backend deploy requires ${NATIVE_ENTRYPOINT_REQUIREMENT}.`;

const nativeBackendSkippedWarning = (roots: string[]): DeployWarning => {
  const target = roots.join(", ") || "native backend";
  const label = roots.length > 0
    ? roots.map((root) => `${root}/`).join(", ")
    : "A native backend folder";
  return {
    code: "native_backend_skipped",
    target,
    message: `${label} was present, but W7S did not deploy a backend because no supported backend entrypoint was found. The frontend was published normally. Add ${NATIVE_ENTRYPOINT_REQUIREMENT} to deploy a backend.`,
    requiredEntrypoints: [...ENTRYPOINT_CANDIDATES]
  };
};

export const handleDeploy = async (c: HonoContext) => {
  const token = parseBearerToken(c.req.raw);
  if (!token) return jsonError("Missing bearer token.", 401);
  if (!isZipRequest(c.req.raw)) {
    return jsonError("Deploy body must be an application/zip archive.", 415);
  }

  let repositoryHeader: string;
  let commitSha: string;
  let branch: string;
  try {
    repositoryHeader = requireHeader(c, "x-github-repository");
    commitSha = requireHeader(c, "x-github-sha");
    branch = requireHeader(c, "x-github-branch");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 400);
  }

  const repo = parseGitHubRepository(repositoryHeader);
  if (!repo) return jsonError("x-github-repository must be in owner/repo form.", 400);

  const orgSlug = requireSlug(repo.owner, "repository owner");
  const repoSlug = requireSlug(repo.repo, "repository name");
  let environment: string;
  try {
    environment = resolveEnvironment({
      branch,
      queryValue: c.req.query("environment"),
      headerValue: readHeader(c, "x-w7s-environment")
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 400);
  }

  const allowed = await verifyGitHubRepoAccess({
    token,
    owner: repo.owner,
    repo: repo.repo
  });
  if (!allowed) {
    return jsonError("Bearer token is not authorized for this GitHub repository.", 401);
  }

  const limitResponse = await enforceUsageLimit(c.env, {
    metric: "deploy",
    environment,
    orgSlug,
    repoSlug,
    units: 1
  });
  if (limitResponse) return limitResponse;

  const suspensionResponse = await enforceAppNotSuspended(c.env, {
    environment,
    orgSlug,
    repoSlug,
    request: c.req.raw
  });
  if (suspensionResponse) return suspensionResponse;

  let archive;
  let appManifest;
  let deployValues;
  try {
    archive = await readDeployArchive(c.req.raw);
    appManifest = readAppManifest(archive);
    deployValues = readDeployValues(c);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 400);
  }

  const nativeRoots = detectNativeWorkerRoots(archive);
  const hasNativeRoot = hasNativeWorkerRoot(archive);
  const nativeEntrypoint = hasNativeRoot ? detectWorkerEntrypoint(archive) : null;
  const hasNativeBackend = Boolean(nativeEntrypoint);
  const hasStatic = hasStaticSite(archive, {
    allowAssetOnly: hasNativeBackend
  });
  const deploymentWarnings: DeployWarning[] = [];
  let customDomains: string[];
  try {
    customDomains = readCustomDomains(archive);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 400);
  }
  if (!hasNativeBackend && !hasStatic) {
    if (hasNativeRoot) return jsonError(nativeEntrypointError(), 400);
    return jsonError("Archive must contain worker/, backend/, dist/server/, or static frontend output.", 400);
  }
  if (hasNativeRoot && !hasNativeBackend && hasStatic) {
    deploymentWarnings.push(nativeBackendSkippedWarning(nativeRoots));
  }
  if (!hasNativeBackend && appManifest.queues.length > 0) {
    return jsonError("Queues require a native backend deployment.", 400);
  }
  if (!hasNativeBackend && appManifest.schedules.length > 0) {
    return jsonError("Schedules require a native backend deployment.", 400);
  }
  if (!hasNativeBackend && appManifest.workflows.length > 0) {
    return jsonError("Workflows require a native backend deployment.", 400);
  }
  if (!hasNativeBackend && appManifest.bindings.durableObjects.length > 0) {
    return jsonError("Durable Objects require a native backend deployment.", 400);
  }
  if (!hasNativeBackend && appManifest.bindings.hyperdrive.length > 0) {
    return jsonError("Hyperdrive bindings require a native backend deployment.", 400);
  }
  if (!hasNativeBackend && appManifest.bindings.ai.length > 0) {
    return jsonError("AI bindings require a native backend deployment.", 400);
  }

  const deployLimitErrors = validateDeployLimits({
    archive,
    manifest: appManifest,
    customDomains,
    allowAssetOnly: hasNativeBackend
  });
  if (deployLimitErrors.length > 0) {
    return jsonError("Deploy exceeds W7S free-tier shape limits.", 400, {
      limits: deployLimitErrors
    });
  }

  const deployedAt = new Date().toISOString();
  const targets: DeploymentRecord["targets"] = {};
  let attachedCustomDomains: string[] = [];
  let customDomainWarnings: Awaited<ReturnType<typeof planCustomDomainClaims>>["warnings"] = [];
  let blockedCustomDomains: Awaited<ReturnType<typeof planCustomDomainClaims>>["blocked"] = [];
  let deploymentBindings: DeploymentRecord["bindings"];
  let deploymentAi: DeploymentRecord["ai"];
  let deploymentRpc: DeploymentRecord["rpc"];
  let deploymentQueue: DeploymentRecord["queue"];
  let deploymentWorkflow: DeploymentRecord["workflow"];

  try {
    if (hasNativeBackend) {
      const entrypoint = detectWorkerEntrypoint(archive);
      if (!entrypoint) {
        return jsonError(nativeEntrypointError(), 400);
      }
      const usesDurableObjects = appManifest.bindings.durableObjects.length > 0;
      const scriptName = usesDurableObjects
        ? buildStableScriptName(orgSlug, repoSlug, environment)
        : buildDeploymentScriptName(orgSlug, repoSlug, environment, commitSha);
      const scriptTags = buildScriptTags({ environment, orgSlug, repoSlug });
      const provisionedBindings = await provisionAppBindings({
        env: c.env,
        archive,
        manifest: appManifest,
        deployValues,
        orgSlug,
        repoSlug,
        environment
      });
      deploymentBindings = provisionedBindings.deploymentBindings;
      const queues = await provisionAppQueues({
        env: c.env,
        manifest: appManifest,
        orgSlug,
        repoSlug,
        environment
      });
      const rpcToken = generateRpcToken();
      const rpcBindings = buildRpcUploadBindings({
        env: c.env,
        orgSlug,
        repoSlug,
        environment,
        token: rpcToken
      });
      deploymentRpc = {
        binding: W7S_RPC_BINDING,
        tokenHash: await hashRpcToken(rpcToken),
        allow: appManifest.rpc.allow
      };
      const queueToken = generateBindingToken();
      const queueBindings = buildQueueUploadBindings({
        env: c.env,
        token: queueToken
      });
      deploymentQueue = {
        binding: W7S_QUEUE_BINDING,
        tokenHash: await hashBindingToken(queueToken),
        allow: appManifest.queue.allow,
        queues
      };
      const workflowToken = generateBindingToken();
      const workflowBindings = buildWorkflowUploadBindings({
        env: c.env,
        token: workflowToken
      });
      deploymentWorkflow = {
        binding: W7S_WORKFLOW_BINDING,
        tokenHash: await hashBindingToken(workflowToken),
        allow: appManifest.workflow.allow,
        workflows: appManifest.workflows
      };
      const aiDeclaration = appManifest.bindings.ai[0];
      const aiToken = aiDeclaration ? generateBindingToken() : null;
      const aiBindings = aiDeclaration && aiToken
        ? buildAiUploadBindings({
            env: c.env,
            binding: aiDeclaration.binding,
            token: aiToken,
            orgSlug,
            repoSlug,
            environment
          })
        : [];
      if (aiDeclaration && aiToken) {
        deploymentAi = {
          binding: aiDeclaration.binding,
          tokenHash: await hashBindingToken(aiToken)
        };
      }
      const published = await publishIsolateWorker({
        env: c.env,
        archive,
        scriptName,
        entrypoint,
        bindings: [
          ...provisionedBindings.uploadBindings,
          ...rpcBindings,
          ...queueBindings,
          ...workflowBindings,
          ...aiBindings
        ],
        durableObjectMigrations: provisionedBindings.durableObjectMigrations,
        tags: scriptTags
      });
      if (provisionedBindings.durableObjectMigrations) {
        await storeDurableObjectClassRecords({
          env: c.env,
          orgSlug,
          repoSlug,
          environment,
          classNames: provisionedBindings.durableObjectMigrations.classNames
        });
      }
      targets.worker = published;
    }

    if (hasStatic) {
      const publishedStatic = await publishStaticSite({
        env: c.env,
        archive,
        orgSlug,
        repoSlug,
        environment,
        commitSha,
        deployedAt,
        allowAssetOnly: hasNativeBackend
      });
      targets.static = {
        manifestKey: publishedStatic.manifestKey,
        assetPrefix: publishedStatic.manifest.assetPrefix,
        fileCount: Object.keys(publishedStatic.manifest.files).length,
        totalSize: Object.values(publishedStatic.manifest.files).reduce((total, file) => total + file.size, 0),
        hasIndex: publishedStatic.manifest.hasIndex
      };
    }

    if (customDomains.length > 0) {
      const customDomainPlan = await planCustomDomainClaims({
        env: c.env,
        hostnames: customDomains,
        orgSlug,
        repoSlug
      });
      attachedCustomDomains = customDomainPlan.attached;
      customDomainWarnings = customDomainPlan.warnings;
      blockedCustomDomains = customDomainPlan.blocked;
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 500);
  }

  const record: DeploymentRecord = {
    version: 1,
    orgSlug,
    repoSlug,
    environment,
    repository: repo.fullName,
    branch,
    commitSha,
    deployedAt,
    ...(attachedCustomDomains.length > 0 ? { customDomains: attachedCustomDomains } : {}),
    ...(deploymentBindings ? { bindings: deploymentBindings } : {}),
    ...(deploymentAi ? { ai: deploymentAi } : {}),
    ...(deploymentRpc ? { rpc: deploymentRpc } : {}),
    ...(deploymentQueue ? { queue: deploymentQueue } : {}),
    ...(deploymentWorkflow ? { workflow: deploymentWorkflow } : {}),
    ...(appManifest.schedules.length > 0 ? { schedules: appManifest.schedules } : {}),
    targets
  };
  await storeDeploymentRecord(c.env, record);
  await replaceCustomDomainMappings(c.env, record, attachedCustomDomains);
  await replaceQueueMappings(c.env, record, record.queue?.queues ?? []);
  await replaceScheduleMappings(c.env, record, record.schedules ?? []);
  if (attachedCustomDomains.length > 0) {
    try {
      await attachCustomDomainRoutes(c.env, attachedCustomDomains);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : String(error), 500);
    }
  }

  writeAnalyticsEvent(c.env, {
    event: "deploy",
    repository: repo.fullName,
    environment,
    orgSlug,
    repoSlug,
    outcome: "success",
    source: hasNativeBackend && hasStatic ? "fullstack" : hasNativeBackend ? "backend" : "static",
    status: 200,
    count: targets.static?.fileCount ?? 1
  });
  await recordUsageEvent(c.env, {
    metric: "deploy",
    repository: repo.fullName,
    environment,
    orgSlug,
    repoSlug,
    outcome: "success",
    count: 1,
    units: 1
  });
  if (targets.static?.fileCount) {
    await recordUsageEvent(c.env, {
      metric: "static.r2_class_a",
      repository: repo.fullName,
      environment,
      orgSlug,
      repoSlug,
      outcome: "success",
      count: targets.static.fileCount,
      units: targets.static.fileCount,
      source: "w7s"
    });
  }

  return jsonSuccess({
    deployment: {
      ...record,
      ...(record.ai ? { ai: { binding: record.ai.binding } } : {}),
      ...(record.rpc ? { rpc: { binding: record.rpc.binding, allow: record.rpc.allow } } : {}),
      ...(record.queue
        ? {
            queue: {
              binding: record.queue.binding,
              allow: record.queue.allow,
              queues: record.queue.queues
            }
          }
        : {}),
      ...(record.workflow
        ? {
            workflow: {
              binding: record.workflow.binding,
              allow: record.workflow.allow,
              workflows: record.workflow.workflows
            }
          }
        : {})
    },
    url: publicDeploymentUrl(c.env, orgSlug, repoSlug, environment, attachedCustomDomains),
    ...(deploymentWarnings.length > 0 ? { deploymentWarnings } : {}),
    ...(attachedCustomDomains.length > 0 ? { customDomains: attachedCustomDomains } : {}),
    ...(customDomainWarnings.length > 0 ? { customDomainWarnings } : {}),
    ...(blockedCustomDomains.length > 0 ? { blockedCustomDomains } : {})
  });
};
