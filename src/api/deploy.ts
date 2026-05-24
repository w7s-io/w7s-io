import type { Context } from "hono";
import type { Env } from "../env";
import { jsonError, jsonSuccess, parseBearerToken } from "../http";
import { parseGitHubRepository, verifyGitHubRepoAccess } from "../deploy/githubAuth";
import { readDeployArchive } from "../deploy/archive";
import { detectWorkerEntrypoint, hasNativeWorkerRoot, publishIsolateWorker } from "../deploy/isolatePublisher";
import { hasStaticSite, publishStaticSite } from "../deploy/staticPublisher";
import { readAppManifest } from "../deploy/appManifest";
import { readDeployValues } from "../deploy/deployValues";
import { provisionAppBindings } from "../deploy/storageProvisioner";
import {
  buildRpcUploadBindings,
  generateRpcToken,
  hashRpcToken,
  W7S_RPC_BINDING
} from "../deploy/rpcBindings";
import {
  attachCustomDomainRoutes,
  planCustomDomainClaims,
  readCustomDomains
} from "../deploy/customDomains";
import { buildDeploymentScriptName, requireSlug, resolveEnvironment, sanitizeScriptPart } from "../names";
import {
  replaceCustomDomainMappings,
  storeDeploymentRecord,
  type DeploymentRecord
} from "../storage/deployments";

type HonoContext = Context<{ Bindings: Env }>;

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

  const hasNativeBackend = hasNativeWorkerRoot(archive);
  const hasStatic = hasStaticSite(archive, {
    allowAssetOnly: hasNativeBackend
  });
  let customDomains: string[];
  try {
    customDomains = readCustomDomains(archive);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 400);
  }
  if (!hasNativeBackend && !hasStatic) {
    return jsonError("Archive must contain worker/, backend/, dist/server/, or static frontend output.", 400);
  }

  const deployedAt = new Date().toISOString();
  const targets: DeploymentRecord["targets"] = {};
  let attachedCustomDomains: string[] = [];
  let customDomainWarnings: Awaited<ReturnType<typeof planCustomDomainClaims>>["warnings"] = [];
  let blockedCustomDomains: Awaited<ReturnType<typeof planCustomDomainClaims>>["blocked"] = [];
  let deploymentBindings: DeploymentRecord["bindings"];
  let deploymentRpc: DeploymentRecord["rpc"];

  try {
    if (hasNativeBackend) {
      const entrypoint = detectWorkerEntrypoint(archive);
      if (!entrypoint) {
        return jsonError("Native backend deploy requires worker/index.js, worker/index.mjs, worker/index.ts, worker/index.mts, backend/index.js, backend/index.mjs, backend/index.ts, backend/index.mts, dist/server/index.js, or dist/server/index.mjs.", 400);
      }
      const scriptName = buildDeploymentScriptName(orgSlug, repoSlug, environment, commitSha);
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
      const published = await publishIsolateWorker({
        env: c.env,
        archive,
        scriptName,
        entrypoint,
        bindings: [...provisionedBindings.uploadBindings, ...rpcBindings]
      });
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
    ...(deploymentRpc ? { rpc: deploymentRpc } : {}),
    targets
  };
  await storeDeploymentRecord(c.env, record);
  await replaceCustomDomainMappings(c.env, record, attachedCustomDomains);
  if (attachedCustomDomains.length > 0) {
    try {
      await attachCustomDomainRoutes(c.env, attachedCustomDomains);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : String(error), 500);
    }
  }

  return jsonSuccess({
    deployment: {
      ...record,
      ...(record.rpc ? { rpc: { binding: record.rpc.binding, allow: record.rpc.allow } } : {})
    },
    url: publicDeploymentUrl(c.env, orgSlug, repoSlug, environment, attachedCustomDomains),
    ...(attachedCustomDomains.length > 0 ? { customDomains: attachedCustomDomains } : {}),
    ...(customDomainWarnings.length > 0 ? { customDomainWarnings } : {}),
    ...(blockedCustomDomains.length > 0 ? { blockedCustomDomains } : {})
  });
};
