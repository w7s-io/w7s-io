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

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const APP_LIMIT_STATE_CACHE_TTL_MS = 5_000;
const APP_LIMIT_STATE_CACHE_MAX_ENTRIES = 1024;
const EDGE_CACHE_URL_PREFIX = "https://w7s-app-limit-cache.local/";
const appLimitStateCache = new Map<string, CacheEntry<AppLimitState | null>>();

const appLimitCacheScope = (env: Env) =>
  env.W7S_RUNTIME_CACHE_SCOPE || env.W7S_WORKER_NAME || "default";

const scopedAppLimitCacheKey = (env: Env, key: string) =>
  `${appLimitCacheScope(env)}\0${key}`;

const readAppLimitMemoryCache = (key: string) => {
  const entry = appLimitStateCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    appLimitStateCache.delete(key);
    return undefined;
  }
  return entry.value;
};

const writeAppLimitMemoryCache = (
  key: string,
  value: AppLimitState | null
) => {
  if (appLimitStateCache.size >= APP_LIMIT_STATE_CACHE_MAX_ENTRIES && !appLimitStateCache.has(key)) {
    const oldestKey = appLimitStateCache.keys().next().value;
    if (oldestKey) appLimitStateCache.delete(oldestKey);
  }
  appLimitStateCache.set(key, {
    value,
    expiresAt: Date.now() + APP_LIMIT_STATE_CACHE_TTL_MS
  });
};

const deleteAppLimitMemoryCache = (key: string) => {
  appLimitStateCache.delete(key);
};

const edgeCache = () => {
  const maybeCaches = (globalThis as unknown as { caches?: { default?: Cache } }).caches;
  return maybeCaches?.default ?? null;
};

const edgeCacheRequest = (key: string) =>
  new Request(`${EDGE_CACHE_URL_PREFIX}${encodeURIComponent(key)}`);

const readAppLimitEdgeCache = async (key: string) => {
  const cache = edgeCache();
  if (!cache) return undefined;
  try {
    const response = await cache.match(edgeCacheRequest(key));
    if (!response) return undefined;
    return await response.json() as AppLimitState | null;
  } catch {
    return undefined;
  }
};

const writeAppLimitEdgeCache = async (key: string, value: AppLimitState | null) => {
  const cache = edgeCache();
  if (!cache) return;
  try {
    await cache.put(
      edgeCacheRequest(key),
      new Response(JSON.stringify(value), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${Math.ceil(APP_LIMIT_STATE_CACHE_TTL_MS / 1000)}`
        }
      })
    );
  } catch {
    // App suspension state is backed by KV; edge caching is only a latency optimization.
  }
};

const deleteAppLimitEdgeCache = async (key: string) => {
  const cache = edgeCache();
  if (!cache) return;
  try {
    await cache.delete(edgeCacheRequest(key));
  } catch {
    // Short TTLs keep stale suspension cache entries bounded.
  }
};

const appLimitStateExpired = (state: AppLimitState, at: Date) =>
  Boolean(state.resumeAfter && new Date(state.resumeAfter).getTime() <= at.getTime());

const clearExpiredAppLimitState = async (env: Env, key: string, cacheKey: string) => {
  await env.DEPLOYMENTS_KV.delete(key);
  deleteAppLimitMemoryCache(cacheKey);
  await deleteAppLimitEdgeCache(key);
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
  const cacheKey = scopedAppLimitCacheKey(env, key);
  const at = params.at ?? new Date();
  const cached = readAppLimitMemoryCache(cacheKey);
  if (cached !== undefined) {
    if (cached && appLimitStateExpired(cached, at)) {
      await clearExpiredAppLimitState(env, key, cacheKey);
      return null;
    }
    return cached;
  }

  const edgeCached = await readAppLimitEdgeCache(key);
  if (edgeCached !== undefined) {
    if (edgeCached && appLimitStateExpired(edgeCached, at)) {
      await clearExpiredAppLimitState(env, key, cacheKey);
      return null;
    }
    writeAppLimitMemoryCache(cacheKey, edgeCached);
    return edgeCached;
  }

  const raw = await env.DEPLOYMENTS_KV.get(key, "json");
  if (!raw || typeof raw !== "object") {
    writeAppLimitMemoryCache(cacheKey, null);
    await writeAppLimitEdgeCache(key, null);
    return null;
  }
  const state = raw as Partial<AppLimitState>;
  if (state.version !== 1 || state.status !== "suspended") {
    writeAppLimitMemoryCache(cacheKey, null);
    await writeAppLimitEdgeCache(key, null);
    return null;
  }

  const appLimitState = state as AppLimitState;
  if (appLimitStateExpired(appLimitState, at)) {
    await clearExpiredAppLimitState(env, key, cacheKey);
    return null;
  }
  writeAppLimitMemoryCache(cacheKey, appLimitState);
  await writeAppLimitEdgeCache(key, appLimitState);
  return appLimitState;
};

export const storeAppLimitState = async (env: Env, state: AppLimitState) => {
  const key = appLimitStateKey(state);
  const cacheKey = scopedAppLimitCacheKey(env, key);
  await Promise.all([
    env.DEPLOYMENTS_KV.put(key, JSON.stringify(state)),
    writeAppLimitEdgeCache(key, state)
  ]);
  writeAppLimitMemoryCache(cacheKey, state);
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
    resumeAfter?: Date;
  }
) => {
  const at = params.at ?? new Date();
  const resumeAfter = params.resumeAfter ?? new Date(nextUtcDayIso(at));
  await storeAppLimitState(env, {
    version: 1,
    status: "suspended",
    environment: params.environment,
    orgSlug: params.orgSlug,
    repoSlug: params.repoSlug,
    reason: params.reason,
    metrics: params.metrics,
    updatedAt: at.toISOString(),
    resumeAfter: resumeAfter.toISOString()
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
  const key = appLimitStateKey(params);
  const cacheKey = scopedAppLimitCacheKey(env, key);
  await Promise.all([
    env.DEPLOYMENTS_KV.delete(key),
    deleteAppLimitEdgeCache(key)
  ]);
  deleteAppLimitMemoryCache(cacheKey);
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
