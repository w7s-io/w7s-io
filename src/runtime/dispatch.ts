import type { Env } from "../env";

export const dispatchWorker = async (params: {
  env: Env;
  request: Request;
  repoPath: string;
  repoSlug: string;
  orgSlug: string;
  scriptName: string;
  urlHost?: string;
  headers?: Record<string, string>;
  stripHeaders?: string[];
}) => {
  if (!params.env.DISPATCHER) {
    return new Response("DISPATCHER binding is not configured.", { status: 503 });
  }
  const worker = params.env.DISPATCHER.get(params.scriptName);
  const originalUrl = new URL(params.request.url);
  const rewrittenUrl = new URL(params.request.url);
  if (params.urlHost) {
    rewrittenUrl.protocol = "https:";
    rewrittenUrl.host = params.urlHost;
  }
  rewrittenUrl.pathname = params.repoPath || "/";
  const headers = new Headers(params.request.headers);
  for (const name of params.stripHeaders ?? []) {
    headers.delete(name);
  }
  headers.set("x-w7s-org-slug", params.orgSlug);
  headers.set("x-w7s-repo-slug", params.repoSlug);
  headers.set("x-w7s-original-path", originalUrl.pathname);
  for (const [key, value] of Object.entries(params.headers ?? {})) {
    headers.set(key, value);
  }
  const body =
    params.request.method === "GET" || params.request.method === "HEAD"
      ? undefined
      : params.request.body;
  const requestInit: RequestInit & { duplex?: "half" } = {
    method: params.request.method,
    headers,
    body,
    redirect: "manual"
  };
  if (body) requestInit.duplex = "half";
  try {
    return await worker.fetch(new Request(rewrittenUrl.toString(), requestInit));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker dispatch failed.";
    return new Response(message, { status: 502 });
  }
};
