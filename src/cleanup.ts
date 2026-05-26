import type { Env } from "./env";
import {
  type DeploymentRecord,
  type StaticSiteManifest,
  type WorkerScriptMapping
} from "./storage/deployments";
import { buildCloudflareHeaders, parseCloudflareEnvelope } from "./deploy/cloudflareApi";

const DEFAULT_STATIC_RETENTION_DAYS = 7;
const DEFAULT_USAGE_RETENTION_DAYS = 14;
const DEFAULT_WORKER_SCRIPT_RETENTION_DAYS = 7;
const CLEANUP_LOCK_TTL_SECONDS = 2 * 60 * 60;

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const daysToMs = (days: number) => days * 24 * 60 * 60 * 1000;

const cutoffIso = (now: Date, days: number) =>
  new Date(now.getTime() - daysToMs(days)).toISOString();

const isBeforeIso = (value: string | undefined, cutoff: string) =>
  typeof value === "string" && value < cutoff;

const cleanupLockKey = (now: Date) =>
  `cleanup_lock:v1:${now.toISOString().slice(0, 13)}`;

const listKeys = async (env: Env, prefix: string) => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.DEPLOYMENTS_KV.list({ prefix, cursor });
    keys.push(...listed.keys.map((entry) => entry.name));
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return keys;
};

const loadJson = async <T>(env: Env, key: string) => {
  const raw = await env.DEPLOYMENTS_KV.get(key, "json");
  return raw && typeof raw === "object" ? raw as T : null;
};

const deleteStaticManifest = async (env: Env, key: string, manifest: StaticSiteManifest) => {
  if (env.STATIC_ASSETS) {
    const objectKeys = Object.values(manifest.files).map((file) => file.r2Key);
    for (let index = 0; index < objectKeys.length; index += 1000) {
      const chunk = objectKeys.slice(index, index + 1000);
      if (chunk.length > 0) await env.STATIC_ASSETS.delete(chunk);
    }
  }
  await env.DEPLOYMENTS_KV.delete(key);
};

const cleanupStaticManifests = async (env: Env, now: Date) => {
  const cutoff = cutoffIso(now, positiveInteger(env.W7S_STATIC_RETENTION_DAYS, DEFAULT_STATIC_RETENTION_DAYS));
  const deploymentRecords = new Set(
    (await Promise.all(
      (await listKeys(env, "deployment:v1:")).map(async (key) => loadJson<DeploymentRecord>(env, key))
    ))
      .filter((record): record is DeploymentRecord => Boolean(record?.version === 1))
      .map((record) => record.targets.static?.manifestKey)
      .filter((key): key is string => Boolean(key))
  );
  let deleted = 0;
  for (const key of await listKeys(env, "static_manifest:v1:")) {
    if (deploymentRecords.has(key)) continue;
    const manifest = await loadJson<StaticSiteManifest>(env, key);
    if (!manifest || manifest.version !== 1 || !isBeforeIso(manifest.deployedAt, cutoff)) continue;
    await deleteStaticManifest(env, key, manifest);
    deleted += 1;
  }
  return deleted;
};

const cleanupExpiredAppLimits = async (env: Env, now: Date) => {
  let deleted = 0;
  for (const key of await listKeys(env, "app_limit_state:v1:")) {
    const record = await loadJson<{ version?: number; resumeAfter?: string }>(env, key);
    if (record?.version !== 1 || !record.resumeAfter || new Date(record.resumeAfter).getTime() > now.getTime()) {
      continue;
    }
    await env.DEPLOYMENTS_KV.delete(key);
    deleted += 1;
  }
  return deleted;
};

const cleanupUsageRollups = async (env: Env, now: Date) => {
  const cutoff = cutoffIso(now, positiveInteger(env.W7S_USAGE_RETENTION_DAYS, DEFAULT_USAGE_RETENTION_DAYS));
  const prefixes = [
    "usage_daily:v1:",
    "usage_owner_daily:v1:",
    "usage_global_daily:v1:",
    "usage_cf_hourly:v1:"
  ];
  let deleted = 0;
  for (const prefix of prefixes) {
    for (const key of await listKeys(env, prefix)) {
      const record = await loadJson<{ version?: number; date?: string; hourStart?: string }>(env, key);
      const timestamp = record?.hourStart ?? (record?.date ? `${record.date}T00:00:00.000Z` : undefined);
      if (!timestamp || !isBeforeIso(timestamp, cutoff)) continue;
      await env.DEPLOYMENTS_KV.delete(key);
      deleted += 1;
    }
  }
  return deleted;
};

const currentWorkerScripts = async (env: Env) => {
  const scripts = new Set<string>();
  for (const key of await listKeys(env, "deployment:v1:")) {
    const record = await loadJson<DeploymentRecord>(env, key);
    if (record?.version === 1 && record.targets.worker?.scriptName) {
      scripts.add(record.targets.worker.scriptName);
    }
  }
  return scripts;
};

const deleteDispatchScript = async (env: Env, scriptName: string) => {
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const namespace = env.CLOUDFLARE_DISPATCH_NAMESPACE?.trim() || "w7s-isolate";
  if (!apiToken || !accountId) return false;
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/dispatch/namespaces/${encodeURIComponent(namespace)}/scripts/${encodeURIComponent(scriptName)}`,
    {
      method: "DELETE",
      headers: buildCloudflareHeaders(apiToken)
    }
  );
  if (response.status === 404) return true;
  await parseCloudflareEnvelope(response);
  return true;
};

const cleanupWorkerScripts = async (env: Env, now: Date) => {
  const cutoff = cutoffIso(now, positiveInteger(env.W7S_WORKER_SCRIPT_RETENTION_DAYS, DEFAULT_WORKER_SCRIPT_RETENTION_DAYS));
  const current = await currentWorkerScripts(env);
  let deleted = 0;
  for (const key of await listKeys(env, "worker_script:v1:")) {
    const mapping = await loadJson<WorkerScriptMapping>(env, key);
    if (
      !mapping ||
      mapping.version !== 1 ||
      !mapping.scriptName ||
      current.has(mapping.scriptName) ||
      !isBeforeIso(mapping.deployedAt, cutoff)
    ) {
      continue;
    }
    try {
      const removed = await deleteDispatchScript(env, mapping.scriptName);
      if (!removed) continue;
      await env.DEPLOYMENTS_KV.delete(key);
      deleted += 1;
    } catch (error) {
      console.warn(`W7S cleanup could not delete Worker script ${mapping.scriptName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return deleted;
};

export const cleanupPlatformState = async (env: Env, now = new Date()) => {
  const lockKey = cleanupLockKey(now);
  const existing = await env.DEPLOYMENTS_KV.get(lockKey);
  if (existing) return { cleaned: false, reason: "already cleaned" };
  await env.DEPLOYMENTS_KV.put(lockKey, now.toISOString(), {
    expirationTtl: CLEANUP_LOCK_TTL_SECONDS
  });

  const [
    staticManifests,
    appLimits,
    usageRollups,
    workerScripts
  ] = await Promise.all([
    cleanupStaticManifests(env, now),
    cleanupExpiredAppLimits(env, now),
    cleanupUsageRollups(env, now),
    cleanupWorkerScripts(env, now)
  ]);

  return {
    cleaned: true,
    staticManifests,
    appLimits,
    usageRollups,
    workerScripts
  };
};
