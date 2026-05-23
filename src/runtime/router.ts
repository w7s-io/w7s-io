import type { Env } from "../env";
import {
  loadCustomDomainMapping,
  loadDeploymentRecordWithCandidates
} from "../storage/deployments";
import { cleanHost, resolveRuntimeHost } from "./host";
import { resolveStaticAssetResponse } from "./static";
import { normalizeSlug } from "../names";
import { orgDeployHelpHtml } from "../static/deployHelp";

const isReservedPlatformPath = (path: string) =>
  path === "/api/v1" || path.startsWith("/api/v1/");

const splitRepoPath = (path: string) => {
  const segments = path.split("/").map((segment) => segment.trim()).filter(Boolean);
  const repoSlug = normalizeSlug(segments[0] ?? "");
  if (!repoSlug) return null;
  return {
    repoSlug,
    repoPath: segments.length > 1 ? `/${segments.slice(1).join("/")}` : "/"
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

const shouldRedirectStaticRepoRoot = (request: Request, repoPath: string) => {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const url = new URL(request.url);
  return repoPath === "/" && !url.pathname.endsWith("/");
};

const shouldShowOrgDeployHelp = (request: Request, path: string) =>
  (request.method === "GET" || request.method === "HEAD") && path === "/";

const redirectToDirectoryPath = (request: Request) => {
  const url = new URL(request.url);
  url.pathname = `${url.pathname}/`;
  return Response.redirect(url.toString(), 308);
};

const dispatchWorker = async (params: {
  env: Env;
  request: Request;
  repoPath: string;
  repoSlug: string;
  orgSlug: string;
  scriptName: string;
}) => {
  if (!params.env.DISPATCHER) {
    return new Response("DISPATCHER binding is not configured.", { status: 503 });
  }
  const worker = params.env.DISPATCHER.get(params.scriptName);
  const originalUrl = new URL(params.request.url);
  const rewrittenUrl = new URL(params.request.url);
  rewrittenUrl.pathname = params.repoPath || "/";
  const headers = new Headers(params.request.headers);
  headers.set("x-w7s-org-slug", params.orgSlug);
  headers.set("x-w7s-repo-slug", params.repoSlug);
  headers.set("x-w7s-original-path", originalUrl.pathname);
  const body =
    params.request.method === "GET" || params.request.method === "HEAD"
      ? undefined
      : params.request.body;
  try {
    return await worker.fetch(
      new Request(rewrittenUrl.toString(), {
        method: params.request.method,
        headers,
        body
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker dispatch failed.";
    return new Response(message, { status: 502 });
  }
};

export const resolveRuntimeRequest = async (request: Request, env: Env) => {
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
      return redirectToDirectoryPath(request);
    }

    const exactStatic = await resolveStaticAssetResponse({
      env,
      request,
      deployment,
      repoPath: candidate.repoPath,
      mode: "exact"
    });
    if (exactStatic) return exactStatic;

    const workerTarget = deployment.targets.worker;
    if (workerTarget) {
      const workerResponse = await dispatchWorker({
        env,
        request,
        repoPath: candidate.repoPath,
        repoSlug: candidate.repoSlug,
        orgSlug,
        scriptName: workerTarget.scriptName
      });
      if (!shouldFallbackFromWorkerToStatic(request, workerResponse)) {
        return workerResponse;
      }
    }

    const fallbackStatic = await resolveStaticAssetResponse({
      env,
      request,
      deployment,
      repoPath: candidate.repoPath,
      mode: "fallback"
    });
    if (fallbackStatic) return fallbackStatic;

    return workerTarget ? new Response("Not found.", { status: 404 }) : null;
  }

  if (host && shouldShowOrgDeployHelp(request, url.pathname)) {
    return new Response(
      request.method === "HEAD"
        ? null
        : orgDeployHelpHtml({
            host: requestHost,
            orgSlug
          }),
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache"
        }
      }
    );
  }

  return new Response("Deployment not found.", { status: 404 });
};
