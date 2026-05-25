import type { Env } from "../env";
import { responseOutcome, writeAnalyticsEvent } from "../analytics";
import {
  loadCustomDomainMapping,
  loadDeploymentRecordWithCandidates,
  type DeploymentRecord
} from "../storage/deployments";
import { cleanHost, resolveRuntimeHost } from "./host";
import { resolveStaticAssetResponse } from "./static";
import { normalizeSlug } from "../names";
import { landingHtml, type DeployShowcaseTarget } from "../static/landing";
import { dispatchWorker } from "./dispatch";

const isReservedPlatformPath = (path: string) =>
  path === "/api/v1" || path.startsWith("/api/v1/");

const splitRepoPath = (path: string) => {
  const segments = path.split("/").map((segment) => segment.trim()).filter(Boolean);
  const repoSlug = normalizeSlug(segments[0] ?? "");
  if (!repoSlug) return null;
  const trailingSlash = path.endsWith("/") ? "/" : "";
  return {
    repoSlug,
    repoPath: segments.length > 1 ? `/${segments.slice(1).join("/")}${trailingSlash}` : "/"
  };
};

type RouteCandidate = {
  repoSlug: string;
  repoPath: string;
  mount: "repo-prefix" | "org-root" | "custom-domain";
};

const rootRepoPath = (path: string) => path || "/";

const routeCandidates = (path: string, orgSlug: string) => {
  const candidates: RouteCandidate[] = [];
  const repoInfo = splitRepoPath(path);
  if (repoInfo) {
    candidates.push({
      ...repoInfo,
      mount: "repo-prefix"
    });
  }

  if (!repoInfo || repoInfo.repoSlug !== orgSlug) {
    candidates.push({
      repoSlug: orgSlug,
      repoPath: rootRepoPath(path),
      mount: "org-root"
    });
  }

  return candidates;
};

const shouldFallbackFromWorkerToStatic = (request: Request, response: Response) => {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return response.status === 404 || response.status === 405;
};

const isRedirectResponse = (response: Response) =>
  response.status >= 300 && response.status < 400 && response.headers.has("location");

const shouldRedirectStaticRepoRoot = (request: Request, repoPath: string) => {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const url = new URL(request.url);
  return repoPath === "/" && !url.pathname.endsWith("/");
};

const shouldShowDeployShowcase = (request: Request) =>
  request.method === "GET" || request.method === "HEAD";

const displayRequestUrl = (request: Request, host: string) => {
  const url = new URL(request.url);
  url.protocol = "https:";
  url.host = host;
  return url.toString();
};

const deployShowcaseTarget = (request: Request, host: string, orgSlug: string): DeployShowcaseTarget => {
  const path = new URL(request.url).pathname;
  const repoInfo = splitRepoPath(path);
  const repoSlug = repoInfo?.repoSlug ?? orgSlug;
  const deployUrl = `https://${host}${repoInfo ? `/${repoSlug}/` : "/"}`;
  const repository = `${orgSlug}/${repoSlug}`;

  return {
    requestedUrl: displayRequestUrl(request, host),
    deployUrl,
    repository,
    repositoryUrl: `https://github.com/${repository}`,
    isOwnerRoot: !repoInfo
  };
};

const deployShowcaseResponse = (request: Request, host: string, orgSlug: string) =>
  new Response(
    request.method === "HEAD"
      ? null
      : landingHtml(deployShowcaseTarget(request, host, orgSlug)),
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache"
      }
    }
  );

const redirectToDirectoryPath = (request: Request) => {
  const url = new URL(request.url);
  url.pathname = `${url.pathname}/`;
  return Response.redirect(url.toString(), 308);
};

const writeRuntimeAnalytics = (params: {
  env: Env;
  request: Request;
  startedAt: number;
  deployment: DeploymentRecord;
  response: Response;
  source: string;
  mount?: RouteCandidate["mount"];
}) => {
  writeAnalyticsEvent(params.env, {
    event: "runtime_request",
    repository: params.deployment.repository,
    environment: params.deployment.environment,
    orgSlug: params.deployment.orgSlug,
    repoSlug: params.deployment.repoSlug,
    outcome: responseOutcome(params.response.status),
    source: params.mount ? `${params.source}:${params.mount}` : params.source,
    method: params.request.method,
    status: params.response.status,
    durationMs: Date.now() - params.startedAt
  });
  return params.response;
};

export const resolveRuntimeRequest = async (request: Request, env: Env) => {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const requestHost = cleanHost(request.headers.get("host") || url.host);
  const host = resolveRuntimeHost(request, env);
  if (host && isReservedPlatformPath(url.pathname)) return null;

  const customDomain = host
    ? null
    : await loadCustomDomainMapping(env, requestHost);
  if (!host && !customDomain) return null;

  const orgSlug = host?.orgSlug ?? customDomain!.orgSlug;
  const environments = host?.environments ?? [customDomain!.environment];
  const candidates = customDomain
    ? [
        {
          repoSlug: customDomain.repoSlug,
          repoPath: url.pathname || "/",
          mount: "custom-domain" as const
        }
      ]
    : routeCandidates(url.pathname, orgSlug);
  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    const deployment = await loadDeploymentRecordWithCandidates(
      env,
      environments,
      orgSlug,
      candidate.repoSlug
    );
    if (!deployment) continue;

    if (
      candidate.mount === "repo-prefix" &&
      deployment.targets.static &&
      shouldRedirectStaticRepoRoot(request, candidate.repoPath)
    ) {
      return writeRuntimeAnalytics({
        env,
        request,
        startedAt,
        deployment,
        response: redirectToDirectoryPath(request),
        source: "static_redirect",
        mount: candidate.mount
      });
    }

    const workerTarget = deployment.targets.worker;
    let workerResponse: Response | null = null;
    if (customDomain && workerTarget) {
      workerResponse = await dispatchWorker({
        env,
        request,
        repoPath: candidate.repoPath,
        repoSlug: candidate.repoSlug,
        orgSlug,
        scriptName: workerTarget.scriptName
      });
      if (isRedirectResponse(workerResponse)) {
        return writeRuntimeAnalytics({
          env,
          request,
          startedAt,
          deployment,
          response: workerResponse,
          source: "worker_redirect",
          mount: candidate.mount
        });
      }
    }

    const exactStatic = await resolveStaticAssetResponse({
      env,
      request,
      deployment,
      repoPath: candidate.repoPath,
      mode: "exact"
    });
    if (exactStatic) {
      return writeRuntimeAnalytics({
        env,
        request,
        startedAt,
        deployment,
        response: exactStatic,
        source: "static_exact",
        mount: candidate.mount
      });
    }

    if (workerTarget) {
      workerResponse ??= await dispatchWorker({
        env,
        request,
        repoPath: candidate.repoPath,
        repoSlug: candidate.repoSlug,
        orgSlug,
        scriptName: workerTarget.scriptName
      });
      if (!shouldFallbackFromWorkerToStatic(request, workerResponse)) {
        return writeRuntimeAnalytics({
          env,
          request,
          startedAt,
          deployment,
          response: workerResponse,
          source: "worker",
          mount: candidate.mount
        });
      }
    }

    const fallbackStatic = await resolveStaticAssetResponse({
      env,
      request,
      deployment,
      repoPath: candidate.repoPath,
      mode: "fallback"
    });
    if (fallbackStatic) {
      return writeRuntimeAnalytics({
        env,
        request,
        startedAt,
        deployment,
        response: fallbackStatic,
        source: "static_fallback",
        mount: candidate.mount
      });
    }

    if (workerTarget) {
      return writeRuntimeAnalytics({
        env,
        request,
        startedAt,
        deployment,
        response: new Response("Not found.", { status: 404 }),
        source: "not_found",
        mount: candidate.mount
      });
    }
    return null;
  }

  if (host && shouldShowDeployShowcase(request)) {
    const target = deployShowcaseTarget(request, requestHost, orgSlug);
    const response = deployShowcaseResponse(request, requestHost, orgSlug);
    const repoSlug = target.repository.split("/")[1] ?? orgSlug;
    writeAnalyticsEvent(env, {
      event: "runtime_showcase",
      repository: target.repository,
      environment: environments[0] ?? "production",
      orgSlug,
      repoSlug,
      outcome: "success",
      source: target.isOwnerRoot ? "org_root" : "repo_prefix",
      method: request.method,
      status: response.status,
      durationMs: Date.now() - startedAt
    });
    return response;
  }

  return new Response("Deployment not found.", { status: 404 });
};
