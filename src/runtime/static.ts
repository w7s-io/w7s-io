import type { Env } from "../env";
import {
  loadStaticSiteManifest,
  type DeploymentRecord,
  type StaticAssetEntry,
  type StaticSiteManifest
} from "../storage/deployments";

type RuntimeExecutionContext = Pick<ExecutionContext, "waitUntil">;

type StaticMemoryEntry = {
  bytes: ArrayBuffer;
  size: number;
  expiresAt: number;
};

const STATIC_MEMORY_CACHE_TTL_MS = 60_000;
const STATIC_MEMORY_CACHE_MAX_BYTES = 5 * 1024 * 1024;
const STATIC_MEMORY_CACHE_MAX_ENTRY_BYTES = 512 * 1024;
const staticMemoryCache = new Map<string, StaticMemoryEntry>();
let staticMemoryCacheBytes = 0;

const normalizeRequestPath = (path: string) =>
  path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");

const resolveExactAsset = (manifest: StaticSiteManifest, repoPath: string) => {
  const normalized = normalizeRequestPath(repoPath);
  const candidates = [
    normalized || "index.html",
    normalized.endsWith("/") ? `${normalized}index.html` : `${normalized}/index.html`
  ];
  for (const candidate of candidates) {
    const asset = manifest.files[candidate];
    if (asset) return asset;
  }
  return null;
};

const resolveSpaFallbackAsset = (manifest: StaticSiteManifest) => {
  if (!manifest.hasIndex) return null;
  return manifest.files["index.html"] ?? null;
};

const isCacheableAsset = (asset: StaticAssetEntry) =>
  !asset.contentType.startsWith("text/html") &&
  !asset.path.endsWith(".html") &&
  asset.path.includes(".");

const isWorkerCacheableAsset = (asset: StaticAssetEntry) =>
  asset.path.includes(".");

const isMemoryCacheableAsset = (asset: StaticAssetEntry) =>
  isWorkerCacheableAsset(asset) && asset.size <= STATIC_MEMORY_CACHE_MAX_ENTRY_BYTES;

const cacheControlForAsset = (asset: StaticAssetEntry) =>
  isCacheableAsset(asset)
    ? "public, max-age=31536000, immutable"
    : "no-cache";

const staticCache = () => {
  const maybeCaches = (globalThis as unknown as { caches?: { default?: Cache } }).caches;
  return maybeCaches?.default ?? null;
};

const cacheRequestForAsset = (asset: StaticAssetEntry) =>
  new Request(`https://w7s-static-cache.local/${asset.r2Key}`);

const responseHeadersForAsset = (asset: StaticAssetEntry) => {
  const headers = new Headers();
  headers.set("content-type", asset.contentType);
  headers.set("cache-control", cacheControlForAsset(asset));
  if (asset.etag) headers.set("etag", `"${asset.etag}"`);
  return headers;
};

const staticMemoryCacheKey = (asset: StaticAssetEntry) =>
  `${asset.r2Key}:${asset.etag ?? ""}:${asset.size}`;

const readStaticMemoryCache = (asset: StaticAssetEntry) => {
  const key = staticMemoryCacheKey(asset);
  const entry = staticMemoryCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    staticMemoryCache.delete(key);
    staticMemoryCacheBytes = Math.max(0, staticMemoryCacheBytes - entry.size);
    return null;
  }
  return entry;
};

const writeStaticMemoryCache = (asset: StaticAssetEntry, bytes: ArrayBuffer) => {
  if (!isMemoryCacheableAsset(asset)) return;
  const size = bytes.byteLength;
  if (size > STATIC_MEMORY_CACHE_MAX_ENTRY_BYTES) return;
  const key = staticMemoryCacheKey(asset);
  const existing = staticMemoryCache.get(key);
  if (existing) staticMemoryCacheBytes = Math.max(0, staticMemoryCacheBytes - existing.size);
  while (
    staticMemoryCacheBytes + size > STATIC_MEMORY_CACHE_MAX_BYTES &&
    staticMemoryCache.size > 0
  ) {
    const oldestKey = staticMemoryCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = staticMemoryCache.get(oldestKey);
    staticMemoryCache.delete(oldestKey);
    if (oldest) staticMemoryCacheBytes = Math.max(0, staticMemoryCacheBytes - oldest.size);
  }
  staticMemoryCache.set(key, {
    bytes,
    size,
    expiresAt: Date.now() + STATIC_MEMORY_CACHE_TTL_MS
  });
  staticMemoryCacheBytes += size;
};

const responseFromMemory = (
  asset: StaticAssetEntry,
  entry: StaticMemoryEntry,
  status = 200
) => {
  const headers = responseHeadersForAsset(asset);
  headers.set("x-w7s-static-cache", "memory");
  return new Response(entry.bytes.slice(0), {
    status,
    headers
  });
};

const responseFromAsset = async (
  env: Env,
  asset: StaticAssetEntry,
  request: Request,
  executionCtx?: RuntimeExecutionContext
) => {
  if (!env.STATIC_ASSETS) return null;
  if (request.method === "GET") {
    const memoryEntry = readStaticMemoryCache(asset);
    if (memoryEntry) return responseFromMemory(asset, memoryEntry);
  }
  const cache = request.method === "GET" && isWorkerCacheableAsset(asset) ? staticCache() : null;
  const cacheRequest = cache ? cacheRequestForAsset(asset) : null;
  if (cache && cacheRequest) {
    const cached = await cache.match(cacheRequest);
    if (cached) {
      const headers = responseHeadersForAsset(asset);
      headers.set("x-w7s-static-cache", "hit");
      if (isMemoryCacheableAsset(asset)) {
        try {
          const bytes = await cached.clone().arrayBuffer();
          writeStaticMemoryCache(asset, bytes);
          return new Response(bytes.slice(0), {
            status: cached.status,
            headers
          });
        } catch {
          // Memory warming should never turn a valid Cache API hit into a failed request.
        }
      }
      return new Response(cached.body, {
        status: cached.status,
        headers
      });
    }
  }
  const object = await env.STATIC_ASSETS.get(asset.r2Key);
  if (!object) return null;
  const headers = responseHeadersForAsset(asset);
  object.writeHttpMetadata(headers);
  headers.set("content-type", headers.get("content-type") || asset.contentType);
  headers.set("x-w7s-static-cache", "miss");
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  if (isMemoryCacheableAsset(asset)) {
    const bytes = await object.arrayBuffer();
    writeStaticMemoryCache(asset, bytes);
    const response = new Response(bytes.slice(0), { status: 200, headers });
    if (cache && cacheRequest) {
      const cacheHeaders = new Headers(headers);
      cacheHeaders.set("cache-control", "public, max-age=300");
      cacheHeaders.delete("x-w7s-static-cache");
      const cachePut = cache.put(
        cacheRequest,
        new Response(bytes.slice(0), {
          status: response.status,
          headers: cacheHeaders
        })
      ).catch((error) => {
        console.error("W7S static cache write failed", error);
      });
      if (executionCtx) executionCtx.waitUntil(cachePut);
      else await cachePut;
    }
    return response;
  }
  const response = new Response(object.body, { status: 200, headers });
  if (cache && cacheRequest) {
    const cacheHeaders = new Headers(headers);
    cacheHeaders.set("cache-control", "public, max-age=300");
    cacheHeaders.delete("x-w7s-static-cache");
    const cachePut = cache.put(
      cacheRequest,
      new Response(response.clone().body, {
        status: response.status,
        headers: cacheHeaders
      })
    ).catch((error) => {
      console.error("W7S static cache write failed", error);
    });
    if (executionCtx) executionCtx.waitUntil(cachePut);
    else await cachePut;
  }
  return response;
};

export const resolveStaticAssetResponse = async (params: {
  env: Env;
  request: Request;
  deployment: DeploymentRecord;
  repoPath: string;
  mode: "exact" | "fallback";
  executionCtx?: RuntimeExecutionContext;
}) => {
  if (params.request.method !== "GET" && params.request.method !== "HEAD") return null;
  const staticTarget = params.deployment.targets.static;
  if (!staticTarget) return null;
  const manifest = await loadStaticSiteManifest(params.env, staticTarget.manifestKey);
  if (!manifest) return null;
  const asset =
    params.mode === "exact"
      ? resolveExactAsset(manifest, params.repoPath)
      : resolveSpaFallbackAsset(manifest);
  if (!asset) return null;
  return responseFromAsset(params.env, asset, params.request, params.executionCtx);
};
