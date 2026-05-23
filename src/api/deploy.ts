import type { Context } from "hono";
import type { Env } from "../env";
import { jsonError, jsonSuccess, parseBearerToken } from "../http";
import { parseGitHubRepository, verifyGitHubRepoAccess } from "../deploy/githubAuth";
import { archiveHasPrefix, readDeployArchive } from "../deploy/archive";
import { detectWorkerEntrypoint, publishIsolateWorker } from "../deploy/isolatePublisher";
import { hasFrontendDist, publishStaticSite } from "../deploy/staticPublisher";
import { attachCustomDomainRoutes, readCustomDomains } from "../deploy/customDomains";
import { buildStableScriptName, requireSlug, resolveEnvironment } from "../names";
import {
  storeCustomDomainMappings,
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

const publicDeploymentUrl = (env: Env, orgSlug: string, repoSlug: string, customDomains: string[]) => {
  if (customDomains[0]) return `https://${customDomains[0]}/`;
  const baseDomain = env.W7S_BASE_DOMAIN?.trim() || "w7s.cloud";
  if (repoSlug === orgSlug) return `https://${orgSlug}.${baseDomain}/`;
  return `https://${orgSlug}.${baseDomain}/${repoSlug}/`;
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
  try {
    archive = await readDeployArchive(c.req.raw);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 400);
  }

  const hasWorker = archiveHasPrefix(archive, "worker/");
  const hasBackend = archiveHasPrefix(archive, "backend/");
  const hasNativeBackend = hasWorker || hasBackend;
  const hasStatic = hasFrontendDist(archive);
  let customDomains: string[];
  try {
    customDomains = readCustomDomains(archive);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 400);
  }
  if (!hasNativeBackend && !hasStatic) {
    return jsonError("Archive must contain worker/, backend/, or frontend/dist.", 400);
  }

  const deployedAt = new Date().toISOString();
  const targets: DeploymentRecord["targets"] = {};

  try {
    if (hasNativeBackend) {
      const entrypoint = detectWorkerEntrypoint(archive);
      if (!entrypoint) {
        return jsonError("Native backend deploy requires worker/index.js, worker/index.mjs, worker/index.ts, worker/index.mts, backend/index.js, backend/index.mjs, backend/index.ts, or backend/index.mts.", 400);
      }
      const scriptName = buildStableScriptName(orgSlug, repoSlug, environment);
      const published = await publishIsolateWorker({
        env: c.env,
        archive,
        scriptName,
        entrypoint
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
        deployedAt
      });
      targets.static = {
        manifestKey: publishedStatic.manifestKey,
        assetPrefix: publishedStatic.manifest.assetPrefix,
        fileCount: Object.keys(publishedStatic.manifest.files).length,
        hasIndex: publishedStatic.manifest.hasIndex
      };
    }

    if (customDomains.length > 0) {
      await attachCustomDomainRoutes(c.env, customDomains);
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
    ...(customDomains.length > 0 ? { customDomains } : {}),
    targets
  };
  await storeDeploymentRecord(c.env, record);
  if (customDomains.length > 0) {
    await storeCustomDomainMappings(c.env, record, customDomains);
  }

  return jsonSuccess({
    deployment: record,
    url: publicDeploymentUrl(c.env, orgSlug, repoSlug, customDomains),
    ...(customDomains.length > 0 ? { customDomains } : {})
  });
};
