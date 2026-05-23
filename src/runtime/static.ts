import type { Env } from "../env";
import {
  loadStaticSiteManifest,
  type DeploymentRecord,
  type StaticAssetEntry,
  type StaticSiteManifest
} from "../storage/deployments";

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

const responseFromAsset = async (env: Env, asset: StaticAssetEntry, request: Request) => {
  if (!env.STATIC_ASSETS) return null;
  const object = await env.STATIC_ASSETS.get(asset.r2Key);
  if (!object) return null;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", headers.get("content-type") || asset.contentType);
  headers.set("cache-control", asset.path.includes(".") ? "public, max-age=31536000, immutable" : "no-cache");
  if (asset.etag) headers.set("etag", `"${asset.etag}"`);
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
};

export const resolveStaticAssetResponse = async (params: {
  env: Env;
  request: Request;
  deployment: DeploymentRecord;
  repoPath: string;
  mode: "exact" | "fallback";
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
  return responseFromAsset(params.env, asset, params.request);
};

