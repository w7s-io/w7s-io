import type { DeployArchive } from "./archive";
import type { Env } from "../env";
import {
  storeStaticSiteManifest,
  type StaticAssetEntry,
  type StaticSiteManifest
} from "../storage/deployments";
import { sanitizeScriptPart } from "../names";

type StaticSiteRoot = {
  label: string;
  prefix: string;
  explicit: boolean;
  assetOnly?: boolean;
};

const STATIC_SITE_ROOTS: StaticSiteRoot[] = [
  { label: "frontend/dist", prefix: "frontend/dist/", explicit: true },
  { label: "frontend/build", prefix: "frontend/build/", explicit: true },
  { label: "frontend/out", prefix: "frontend/out/", explicit: true },
  { label: "dist/client", prefix: "dist/client/", explicit: false, assetOnly: true },
  { label: "dist", prefix: "dist/", explicit: false },
  { label: "build", prefix: "build/", explicit: false },
  { label: "out", prefix: "out/", explicit: false }
];

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm"
};

const inferContentType = (path: string) => {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  return contentTypes[ext] ?? "application/octet-stream";
};

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const toArrayBuffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const sha256 = async (bytes: Uint8Array) =>
  hex(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)));

export const detectStaticSiteRoot = (
  archive: DeployArchive,
  options: { allowAssetOnly?: boolean } = {}
) =>
  STATIC_SITE_ROOTS.find((root) => {
    const hasEntries = archive.entries.some((entry) => entry.path.startsWith(root.prefix));
    if (!hasEntries) return false;
    if (root.explicit || archive.files.has(`${root.prefix}index.html`)) return true;
    return Boolean(options.allowAssetOnly && root.assetOnly);
  }) ?? null;

export const hasStaticSite = (
  archive: DeployArchive,
  options: { allowAssetOnly?: boolean } = {}
) => Boolean(detectStaticSiteRoot(archive, options));

export const publishStaticSite = async (params: {
  env: Env;
  archive: DeployArchive;
  orgSlug: string;
  repoSlug: string;
  environment: string;
  commitSha: string;
  deployedAt: string;
  allowAssetOnly?: boolean;
}) => {
  if (!params.env.STATIC_ASSETS) {
    throw new Error("STATIC_ASSETS R2 binding is required to publish frontend assets.");
  }
  const staticRoot = detectStaticSiteRoot(params.archive, {
    allowAssetOnly: params.allowAssetOnly
  });
  if (!staticRoot) {
    throw new Error("No static frontend output was found.");
  }

  const assetPrefix = [
    "static",
    "v1",
    sanitizeScriptPart(params.environment),
    sanitizeScriptPart(params.orgSlug),
    sanitizeScriptPart(params.repoSlug),
    sanitizeScriptPart(params.commitSha.slice(0, 40))
  ].join("/");
  const files: Record<string, StaticAssetEntry> = {};

  for (const entry of params.archive.entries) {
    if (!entry.path.startsWith(staticRoot.prefix)) continue;
    const routePath = entry.path.slice(staticRoot.prefix.length).replace(/^\/+/, "");
    if (!routePath) continue;
    const digest = await sha256(entry.bytes);
    const r2Key = `${assetPrefix}/${routePath}`;
    const contentType = inferContentType(routePath);
    await params.env.STATIC_ASSETS.put(r2Key, entry.bytes, {
      httpMetadata: {
        contentType
      },
      customMetadata: {
        sha256: digest
      }
    });
    files[routePath] = {
      path: routePath,
      r2Key,
      contentType,
      size: entry.bytes.byteLength,
      etag: digest
    };
  }

  if (Object.keys(files).length === 0) {
    throw new Error(`${staticRoot.label} was present but no publishable files were found.`);
  }

  const manifest: StaticSiteManifest = {
    version: 1,
    orgSlug: params.orgSlug,
    repoSlug: params.repoSlug,
    environment: params.environment,
    assetPrefix,
    deployedAt: params.deployedAt,
    files,
    hasIndex: Boolean(files["index.html"])
  };
  const manifestKey = await storeStaticSiteManifest(params.env, manifest);
  return {
    manifest,
    manifestKey
  };
};
