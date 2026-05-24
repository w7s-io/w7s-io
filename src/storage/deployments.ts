import type { Env } from "../env";
import { sanitizeScriptPart } from "../names";

export type StaticAssetEntry = {
  path: string;
  r2Key: string;
  contentType: string;
  size: number;
  etag: string | null;
};

export type StaticSiteManifest = {
  version: 1;
  orgSlug: string;
  repoSlug: string;
  environment: string;
  assetPrefix: string;
  deployedAt: string;
  files: Record<string, StaticAssetEntry>;
  hasIndex: boolean;
};

export type DeploymentRecord = {
  version: 1;
  orgSlug: string;
  repoSlug: string;
  environment: string;
  repository: string;
  branch: string;
  commitSha: string;
  deployedAt: string;
  customDomains?: string[];
  targets: {
    worker?: {
      namespace: string;
      scriptName: string;
      entrypoint: string;
      compatibilityDate: string;
      startupTimeMs: number | null;
    };
    static?: {
      manifestKey: string;
      assetPrefix: string;
      fileCount: number;
      hasIndex: boolean;
    };
  };
};

export type CustomDomainMapping = {
  version: 1;
  hostname: string;
  orgSlug: string;
  repoSlug: string;
  environment: string;
  repository: string;
  deployedAt: string;
};

export const deploymentKey = (environment: string, orgSlug: string, repoSlug: string) =>
  `deployment:v1:${sanitizeScriptPart(environment)}:${sanitizeScriptPart(orgSlug)}:${sanitizeScriptPart(repoSlug)}`;

export const staticManifestKey = (
  environment: string,
  orgSlug: string,
  repoSlug: string,
  version: string
) =>
  `static_manifest:v1:${sanitizeScriptPart(environment)}:${sanitizeScriptPart(orgSlug)}:${sanitizeScriptPart(repoSlug)}:${sanitizeScriptPart(version)}`;

export const customDomainKey = (hostname: string) =>
  `custom_domain:v1:${hostname.trim().toLowerCase()}`;

export const storeDeploymentRecord = async (env: Env, record: DeploymentRecord) => {
  await env.DEPLOYMENTS_KV.put(
    deploymentKey(record.environment, record.orgSlug, record.repoSlug),
    JSON.stringify(record)
  );
};

export const loadDeploymentRecord = async (
  env: Env,
  environment: string,
  orgSlug: string,
  repoSlug: string
) => {
  const raw = await env.DEPLOYMENTS_KV.get(
    deploymentKey(environment, orgSlug, repoSlug),
    "json"
  );
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<DeploymentRecord>;
  if (record.version !== 1 || typeof record.orgSlug !== "string") return null;
  return record as DeploymentRecord;
};

export const loadDeploymentRecordWithCandidates = async (
  env: Env,
  environments: string[],
  orgSlug: string,
  repoSlug: string
) => {
  for (const environment of environments) {
    const record = await loadDeploymentRecord(env, environment, orgSlug, repoSlug);
    if (record) return record;
  }
  return null;
};

export const storeCustomDomainMappings = async (
  env: Env,
  record: DeploymentRecord,
  hostnames: string[]
) => {
  await Promise.all(
    hostnames.map((hostname) =>
      env.DEPLOYMENTS_KV.put(
        customDomainKey(hostname),
        JSON.stringify({
          version: 1,
          hostname,
          orgSlug: record.orgSlug,
          repoSlug: record.repoSlug,
          environment: record.environment,
          repository: record.repository,
          deployedAt: record.deployedAt
        } satisfies CustomDomainMapping)
      )
    )
  );
};

export const loadCustomDomainMapping = async (env: Env, hostname: string) => {
  const raw = await env.DEPLOYMENTS_KV.get(customDomainKey(hostname), "json");
  if (!raw || typeof raw !== "object") return null;
  const mapping = raw as Partial<CustomDomainMapping>;
  if (mapping.version !== 1 || typeof mapping.hostname !== "string") return null;
  return mapping as CustomDomainMapping;
};

export const storeStaticSiteManifest = async (
  env: Env,
  manifest: StaticSiteManifest
) => {
  const key = staticManifestKey(
    manifest.environment,
    manifest.orgSlug,
    manifest.repoSlug,
    manifest.assetPrefix
  );
  await env.DEPLOYMENTS_KV.put(key, JSON.stringify(manifest));
  return key;
};

export const loadStaticSiteManifest = async (env: Env, key: string) => {
  const raw = await env.DEPLOYMENTS_KV.get(key, "json");
  if (!raw || typeof raw !== "object") return null;
  const manifest = raw as Partial<StaticSiteManifest>;
  if (manifest.version !== 1 || typeof manifest.assetPrefix !== "string") return null;
  return manifest as StaticSiteManifest;
};
