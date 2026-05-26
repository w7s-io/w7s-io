import type { Env } from "./env";
import { json } from "./http";
import { sanitizeScriptPart } from "./names";
import type { UsageLimitWarning } from "./usageLimits";

export type AppLimitState = {
  version: 1;
  status: "active" | "suspended";
  environment: string;
  orgSlug: string;
  repoSlug: string;
  reason?: string;
  metrics?: UsageLimitWarning[];
  updatedAt: string;
  resumeAfter?: string;
};

export const secondsUntilNextUtcDay = (now = new Date()) => {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
};

export const nextUtcDayIso = (now = new Date()) => {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
};

export const appLimitStateKey = (params: {
  environment: string;
  orgSlug: string;
  repoSlug: string;
}) =>
  [
    "app_limit_state:v1",
    sanitizeScriptPart(params.environment),
    sanitizeScriptPart(params.orgSlug),
    sanitizeScriptPart(params.repoSlug)
  ].join(":");

export const loadAppLimitState = async (
  env: Env,
  params: {
    environment: string;
    orgSlug: string;
    repoSlug: string;
    at?: Date;
  }
) => {
  const key = appLimitStateKey(params);
  const raw = await env.DEPLOYMENTS_KV.get(key, "json");
  if (!raw || typeof raw !== "object") return null;
  const state = raw as Partial<AppLimitState>;
  if (state.version !== 1 || state.status !== "suspended") return null;

  const at = params.at ?? new Date();
  if (state.resumeAfter && new Date(state.resumeAfter).getTime() <= at.getTime()) {
    await env.DEPLOYMENTS_KV.delete(key);
    return null;
  }
  return state as AppLimitState;
};

export const storeAppLimitState = async (env: Env, state: AppLimitState) => {
  await env.DEPLOYMENTS_KV.put(
    appLimitStateKey(state),
    JSON.stringify(state)
  );
};

export const suspendAppForLimits = async (
  env: Env,
  params: {
    environment: string;
    orgSlug: string;
    repoSlug: string;
    reason: string;
    metrics: UsageLimitWarning[];
    at?: Date;
  }
) => {
  const at = params.at ?? new Date();
  await storeAppLimitState(env, {
    version: 1,
    status: "suspended",
    environment: params.environment,
    orgSlug: params.orgSlug,
    repoSlug: params.repoSlug,
    reason: params.reason,
    metrics: params.metrics,
    updatedAt: at.toISOString(),
    resumeAfter: nextUtcDayIso(at)
  });
};

export const clearAppLimitState = async (
  env: Env,
  params: {
    environment: string;
    orgSlug: string;
    repoSlug: string;
  }
) => {
  await env.DEPLOYMENTS_KV.delete(appLimitStateKey(params));
};

export const appSuspendedResponse = (
  state: AppLimitState,
  request?: Request
) => {
  const retryAfter = state.resumeAfter
    ? Math.max(1, Math.ceil((new Date(state.resumeAfter).getTime() - Date.now()) / 1000))
    : secondsUntilNextUtcDay();
  const firstMetric = state.metrics?.[0];
  const message =
    state.reason ||
    (firstMetric
      ? `W7S free-tier limit exceeded for ${firstMetric.metric}.`
      : "W7S free-tier limit exceeded.");
  const acceptsHtml = request?.headers.get("accept")?.includes("text/html");
  if (acceptsHtml) {
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>W7S limit reached</title></head><body><main><h1>W7S limit reached</h1><p>${message}</p><p>This app can resume after ${state.resumeAfter ?? "the next UTC day"}.</p></main></body></html>`,
      {
        status: 429,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "retry-after": String(retryAfter)
        }
      }
    );
  }
  return json(
    {
      status: "error",
      error: message,
      details: {
        appLimitState: state
      }
    },
    429,
    {
      "retry-after": String(retryAfter)
    }
  );
};

export const enforceAppNotSuspended = async (
  env: Env,
  params: {
    environment: string;
    orgSlug: string;
    repoSlug: string;
    request?: Request;
  }
) => {
  const state = await loadAppLimitState(env, params);
  return state ? appSuspendedResponse(state, params.request) : null;
};
