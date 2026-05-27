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
import { enforceAppNotSuspended, suspendAppForLimits } from "../appLimits";
import { checkBlockedUsageLimit, costGuardExceededMessage } from "../usageEnforcement";
import { recordUsageEvent } from "../usage";

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

type RuntimeExecutionContext = Pick<ExecutionContext, "waitUntil">;
type RuntimeTiming = {
  name: string;
  durationMs: number;
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

const addRuntimeTimingHeader = (
  request: Request,
  response: Response,
  timings?: RuntimeTiming[]
) => {
  if (!timings?.length || request.headers.get("x-w7s-debug") !== "1") return response;
  const debugResponse = new Response(response.body, response);
  debugResponse.headers.set(
    "server-timing",
    timings
      .map((timing) => `${timing.name};dur=${Math.max(0, Math.round(timing.durationMs))}`)
      .join(", ")
  );
  return debugResponse;
};

const writeRuntimeAnalytics = async (params: {
  env: Env;
  request: Request;
  startedAt: number;
  deployment: DeploymentRecord;
  response: Response;
  source: string;
  mount?: RouteCandidate["mount"];
  executionCtx?: RuntimeExecutionContext;
  timings?: RuntimeTiming[];
}) => {
  const durationMs = Date.now() - params.startedAt;
  const outcome = responseOutcome(params.response.status);
  const shouldRecordStaticR2Read =
    params.source.startsWith("static_") &&
    params.response.status >= 200 &&
    params.response.status < 300 &&
    params.response.headers.get("x-w7s-static-cache") === "miss";
  const task = (async () => {
    writeAnalyticsEvent(params.env, {
      event: "runtime_request",
      repository: params.deployment.repository,
      environment: params.deployment.environment,
      orgSlug: params.deployment.orgSlug,
      repoSlug: params.deployment.repoSlug,
      outcome,
      source: params.mount ? `${params.source}:${params.mount}` : params.source,
      method: params.request.method,
      status: params.response.status,
      durationMs
    });
    await recordUsageEvent(params.env, {
      metric: "runtime.request",
      repository: params.deployment.repository,
      environment: params.deployment.environment,
      orgSlug: params.deployment.orgSlug,
      repoSlug: params.deployment.repoSlug,
      outcome,
      count: 1,
      units: 1,
      source: "w7s"
    });
    if (shouldRecordStaticR2Read) {
      await recordUsageEvent(params.env, {
        metric: "static.r2_class_b",
        repository: params.deployment.repository,
        environment: params.deployment.environment,
        orgSlug: params.deployment.orgSlug,
        repoSlug: params.deployment.repoSlug,
        outcome,
        count: 1,
        units: 1,
        source: "w7s"
      });
    }
    const check = await checkBlockedUsageLimit(params.env, {
      metric: "runtime.request",
      environment: params.deployment.environment,
      orgSlug: params.deployment.orgSlug,
      repoSlug: params.deployment.repoSlug,
      units: 1
    });
    if (check?.wouldBlock) {
      const message = costGuardExceededMessage(check);
      await suspendAppForLimits(params.env, {
        environment: params.deployment.environment,
        orgSlug: params.deployment.orgSlug,
        repoSlug: params.deployment.repoSlug,
        reason: message,
        metrics: [
          {
            metric: check.metric,
            status: "exceeded",
            used: check.used,
            limit: check.limit,
            remaining: check.remaining,
            message
          }
        ]
      });
    }
  })().catch((error) => {
    console.error("W7S runtime accounting failed", error);
  });

  if (params.executionCtx) {
    params.executionCtx.waitUntil(task);
  } else {
    await task;
  }
  return addRuntimeTimingHeader(params.request, params.response, params.timings);
};

export const resolveRuntimeRequest = async (
  request: Request,
  env: Env,
  executionCtx?: RuntimeExecutionContext
) => {
  const startedAt = Date.now();
  const timings: RuntimeTiming[] | undefined =
    request.headers.get("x-w7s-debug") === "1" ? [] : undefined;
  let previousTimingAt = startedAt;
  const markTiming = (name: string) => {
    if (!timings) return;
    const now = Date.now();
    timings.push({ name, durationMs: now - previousTimingAt });
    previousTimingAt = now;
  };
  const url = new URL(request.url);
  const requestHost = cleanHost(request.headers.get("host") || url.host);
  const host = resolveRuntimeHost(request, env);
  if (host && isReservedPlatformPath(url.pathname)) return null;

  const customDomain = host
    ? null
    : await loadCustomDomainMapping(env, requestHost);
  markTiming("host");
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
    markTiming("deployment");
    if (!deployment) continue;

    const suspended = await enforceAppNotSuspended(env, {
      environment: deployment.environment,
      orgSlug,
      repoSlug: candidate.repoSlug,
      request
    });
    markTiming("suspension");
    if (suspended) return suspended;

    if (
      candidate.mount === "repo-prefix" &&
      deployment.targets.static &&
      shouldRedirectStaticRepoRoot(request, candidate.repoPath)
    ) {
      return await writeRuntimeAnalytics({
        env,
        request,
        startedAt,
        deployment,
        response: redirectToDirectoryPath(request),
        source: "static_redirect",
        mount: candidate.mount,
        executionCtx,
        timings
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
        return await writeRuntimeAnalytics({
          env,
          request,
          startedAt,
          deployment,
          response: workerResponse,
          source: "worker_redirect",
          mount: candidate.mount,
          executionCtx,
          timings
        });
      }
    }

    const exactStatic = await resolveStaticAssetResponse({
      env,
      request,
      deployment,
      repoPath: candidate.repoPath,
      mode: "exact",
      executionCtx
    });
    markTiming("static_exact");
    if (exactStatic) {
      return await writeRuntimeAnalytics({
        env,
        request,
        startedAt,
        deployment,
        response: exactStatic,
        source: "static_exact",
        mount: candidate.mount,
        executionCtx,
        timings
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
      markTiming("worker");
      if (!shouldFallbackFromWorkerToStatic(request, workerResponse)) {
        return await writeRuntimeAnalytics({
          env,
          request,
          startedAt,
          deployment,
          response: workerResponse,
          source: "worker",
          mount: candidate.mount,
          executionCtx,
          timings
        });
      }
    }

    const fallbackStatic = await resolveStaticAssetResponse({
      env,
      request,
      deployment,
      repoPath: candidate.repoPath,
      mode: "fallback",
      executionCtx
    });
    markTiming("static_fallback");
    if (fallbackStatic) {
      return await writeRuntimeAnalytics({
        env,
        request,
        startedAt,
        deployment,
        response: fallbackStatic,
        source: "static_fallback",
        mount: candidate.mount,
        executionCtx,
        timings
      });
    }

    if (workerTarget) {
      return await writeRuntimeAnalytics({
        env,
        request,
        startedAt,
        deployment,
        response: new Response("Not found.", { status: 404 }),
        source: "not_found",
        mount: candidate.mount,
        executionCtx,
        timings
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
