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
  bindings?: DeploymentBindings;
  ai?: DeploymentAiConfig;
  rpc?: DeploymentRpc;
  queue?: DeploymentQueueConfig;
  workflow?: DeploymentWorkflowConfig;
  schedules?: DeploymentSchedule[];
  targets: {
    worker?: {
      namespace: string;
      scriptName: string;
      entrypoint: string;
      compatibilityDate: string;
      startupTimeMs: number | null;
      tags?: string[];
    };
    static?: {
      manifestKey: string;
      assetPrefix: string;
      fileCount: number;
      totalSize?: number;
      hasIndex: boolean;
    };
  };
};

export type DeploymentRpc = {
  binding: string;
  tokenHash: string;
  allow: string[];
};

export type DeploymentAiConfig = {
  binding: string;
  tokenHash: string;
};

export type DeploymentQueueConfig = {
  binding: string;
  tokenHash: string;
  allow: string[];
  queues: DeploymentQueue[];
};

export type DeploymentWorkflowConfig = {
  binding: string;
  tokenHash: string;
  allow: string[];
  workflows: DeploymentWorkflow[];
};

export type DeploymentQueue = {
  name: string;
  queueName: string;
  queueId: string;
  consumer: string;
};

export type DeploymentWorkflow = {
  name: string;
  path: string;
};

export type DeploymentSchedule = {
  cron: string;
  path: string;
};

export type DeploymentBindings = {
  kv?: Array<{
    binding: string;
    name: string;
    namespaceId: string;
  }>;
  r2?: Array<{
    binding: string;
    bucketName: string;
  }>;
  d1?: Array<{
    binding: string;
    name: string;
    databaseId: string;
    migrationsApplied?: number;
  }>;
  durableObjects?: Array<{
    binding: string;
    className: string;
  }>;
  hyperdrive?: Array<{
    binding: string;
    id: string;
  }>;
  vars?: string[];
  secrets?: string[];
};

export type ManagedResourceKind = "kv" | "r2" | "d1" | "queue" | "durable_object";

export type ManagedResourceRecord = {
  version: 1;
  kind: ManagedResourceKind;
  orgSlug: string;
  repoSlug: string;
  environment: string;
  binding: string;
  name: string;
  id: string;
  createdAt: string;
  updatedAt: string;
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

export type QueueMapping = {
  version: 1;
  queueName: string;
  queueId: string;
  queue: string;
  consumer: string;
  orgSlug: string;
  repoSlug: string;
  environment: string;
  repository: string;
  deployedAt: string;
};

export type WorkerScriptMapping = {
  version: 1;
  scriptName: string;
  orgSlug: string;
  repoSlug: string;
  environment: string;
  repository: string;
  branch: string;
  commitSha: string;
  deployedAt: string;
};

export type ScheduleMapping = {
  version: 1;
  id: string;
  cron: string;
  path: string;
  orgSlug: string;
  repoSlug: string;
  environment: string;
  repository: string;
  deployedAt: string;
};

export type BindingTokenKind = "ai" | "rpc" | "queue" | "workflow";

export type BindingTokenMapping = {
  version: 1;
  kind: BindingTokenKind;
  tokenHash: string;
  orgSlug: string;
  repoSlug: string;
  environment: string;
  repository: string;
  deployedAt: string;
};

export type AiTokenMapping = Omit<BindingTokenMapping, "kind">;

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const MAX_RUNTIME_CACHE_ENTRIES = 1024;
const DEPLOYMENT_RECORD_CACHE_TTL_MS = 5_000;
const CUSTOM_DOMAIN_CACHE_TTL_MS = 5_000;
const STATIC_MANIFEST_CACHE_TTL_MS = 60_000;
const EDGE_CACHE_URL_PREFIX = "https://w7s-runtime-metadata-cache.local/";

const deploymentRecordCache = new Map<string, CacheEntry<DeploymentRecord | null>>();
const customDomainCache = new Map<string, CacheEntry<CustomDomainMapping | null>>();
const staticManifestCache = new Map<string, CacheEntry<StaticSiteManifest | null>>();

const runtimeCacheScope = (env: Env) =>
  env.W7S_RUNTIME_CACHE_SCOPE || env.W7S_WORKER_NAME || "default";

const scopedRuntimeCacheKey = (env: Env, key: string) =>
  `${runtimeCacheScope(env)}\0${key}`;

const readRuntimeCache = <T>(
  store: Map<string, CacheEntry<T>>,
  key: string
) => {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
};

const writeRuntimeCache = <T>(
  store: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number
) => {
  if (store.size >= MAX_RUNTIME_CACHE_ENTRIES && !store.has(key)) {
    const oldestKey = store.keys().next().value;
    if (oldestKey) store.delete(oldestKey);
  }
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
};

const deleteRuntimeCache = <T>(
  store: Map<string, CacheEntry<T>>,
  key: string
) => {
  store.delete(key);
};

const metadataEdgeCache = () => {
  const maybeCaches = (globalThis as unknown as { caches?: { default?: Cache } }).caches;
  return maybeCaches?.default ?? null;
};

const metadataEdgeCacheRequest = (key: string) =>
  new Request(`${EDGE_CACHE_URL_PREFIX}${encodeURIComponent(key)}`);

const readMetadataEdgeCache = async <T>(key: string) => {
  const cache = metadataEdgeCache();
  if (!cache) return undefined;
  try {
    const response = await cache.match(metadataEdgeCacheRequest(key));
    if (!response) return undefined;
    return await response.json() as T;
  } catch {
    return undefined;
  }
};

const writeMetadataEdgeCache = async <T>(key: string, value: T, ttlMs: number) => {
  const cache = metadataEdgeCache();
  if (!cache) return;
  try {
    await cache.put(
      metadataEdgeCacheRequest(key),
      new Response(JSON.stringify(value), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${Math.max(1, Math.ceil(ttlMs / 1000))}`
        }
      })
    );
  } catch {
    // Metadata edge caching is an optimization; KV remains the source of truth.
  }
};

const deleteMetadataEdgeCache = async (key: string) => {
  const cache = metadataEdgeCache();
  if (!cache) return;
  try {
    await cache.delete(metadataEdgeCacheRequest(key));
  } catch {
    // Ignore cache deletion failures; short TTLs prevent long-lived stale routes.
  }
};

const shortHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0").slice(0, 7);
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

export const queueMappingKey = (queueName: string) =>
  `queue_mapping:v1:${queueName.trim().toLowerCase()}`;

export const workerScriptMappingKey = (scriptName: string) =>
  `worker_script:v1:${sanitizeScriptPart(scriptName)}`;

export const aiTokenMappingKey = (tokenHash: string) =>
  `ai_token:v1:${tokenHash.trim()}`;

export const bindingTokenMappingKey = (kind: BindingTokenKind, tokenHash: string) =>
  `binding_token:v1:${kind}:${tokenHash.trim()}`;

export const scheduleMappingId = (
  record: Pick<DeploymentRecord, "environment" | "orgSlug" | "repoSlug">,
  schedule: DeploymentSchedule
) =>
  [
    sanitizeScriptPart(record.environment),
    sanitizeScriptPart(record.orgSlug),
    sanitizeScriptPart(record.repoSlug),
    shortHash(`${schedule.cron}\0${schedule.path}`)
  ].join(":");

export const scheduleMappingKey = (id: string) =>
  `schedule_mapping:v1:${id}`;

export const scheduleLockKey = (id: string, scheduledMinute: string) =>
  `schedule_lock:v1:${id}:${sanitizeScriptPart(scheduledMinute)}`;

export const managedResourceKey = (
  environment: string,
  orgSlug: string,
  repoSlug: string,
  kind: ManagedResourceKind,
  binding: string
) =>
  `resource:v1:${sanitizeScriptPart(environment)}:${sanitizeScriptPart(orgSlug)}:${sanitizeScriptPart(repoSlug)}:${kind}:${sanitizeScriptPart(binding)}`;

export const storeDeploymentRecord = async (env: Env, record: DeploymentRecord) => {
  const key = deploymentKey(record.environment, record.orgSlug, record.repoSlug);
  const cacheKey = scopedRuntimeCacheKey(env, key);
  const storeBindingTokenMapping = (kind: BindingTokenKind, tokenHash: string) =>
    env.DEPLOYMENTS_KV.put(
      bindingTokenMappingKey(kind, tokenHash),
      JSON.stringify({
        version: 1,
        kind,
        tokenHash,
        orgSlug: record.orgSlug,
        repoSlug: record.repoSlug,
        environment: record.environment,
        repository: record.repository,
        deployedAt: record.deployedAt
      } satisfies BindingTokenMapping)
    );
  await Promise.all([
    env.DEPLOYMENTS_KV.put(
      key,
      JSON.stringify(record)
    ),
    record.targets.worker
      ? env.DEPLOYMENTS_KV.put(
          workerScriptMappingKey(record.targets.worker.scriptName),
          JSON.stringify({
            version: 1,
            scriptName: record.targets.worker.scriptName,
            orgSlug: record.orgSlug,
            repoSlug: record.repoSlug,
            environment: record.environment,
            repository: record.repository,
            branch: record.branch,
            commitSha: record.commitSha,
            deployedAt: record.deployedAt
          } satisfies WorkerScriptMapping)
        )
      : Promise.resolve(),
    record.ai
      ? env.DEPLOYMENTS_KV.put(
          aiTokenMappingKey(record.ai.tokenHash),
          JSON.stringify({
            version: 1,
            tokenHash: record.ai.tokenHash,
            orgSlug: record.orgSlug,
            repoSlug: record.repoSlug,
            environment: record.environment,
            repository: record.repository,
            deployedAt: record.deployedAt
          } satisfies AiTokenMapping)
        )
      : Promise.resolve(),
    record.ai
      ? storeBindingTokenMapping("ai", record.ai.tokenHash)
      : Promise.resolve(),
    record.rpc
      ? storeBindingTokenMapping("rpc", record.rpc.tokenHash)
      : Promise.resolve(),
    record.queue
      ? storeBindingTokenMapping("queue", record.queue.tokenHash)
      : Promise.resolve(),
    record.workflow
      ? storeBindingTokenMapping("workflow", record.workflow.tokenHash)
      : Promise.resolve()
  ]);
  writeRuntimeCache(
    deploymentRecordCache,
    cacheKey,
    record,
    DEPLOYMENT_RECORD_CACHE_TTL_MS
  );
  await writeMetadataEdgeCache(key, record, DEPLOYMENT_RECORD_CACHE_TTL_MS);
};

export const loadDeploymentRecord = async (
  env: Env,
  environment: string,
  orgSlug: string,
  repoSlug: string
) => {
  const key = deploymentKey(environment, orgSlug, repoSlug);
  const cacheKey = scopedRuntimeCacheKey(env, key);
  const cached = readRuntimeCache(deploymentRecordCache, cacheKey);
  if (cached !== undefined) return cached;

  const edgeCached = await readMetadataEdgeCache<DeploymentRecord | null>(key);
  if (edgeCached !== undefined) {
    writeRuntimeCache(
      deploymentRecordCache,
      cacheKey,
      edgeCached,
      DEPLOYMENT_RECORD_CACHE_TTL_MS
    );
    return edgeCached;
  }

  const raw = await env.DEPLOYMENTS_KV.get(key, "json");
  if (!raw || typeof raw !== "object") {
    writeRuntimeCache(
      deploymentRecordCache,
      cacheKey,
      null,
      DEPLOYMENT_RECORD_CACHE_TTL_MS
    );
    await writeMetadataEdgeCache(key, null, DEPLOYMENT_RECORD_CACHE_TTL_MS);
    return null;
  }
  const record = raw as Partial<DeploymentRecord>;
  if (record.version !== 1 || typeof record.orgSlug !== "string") {
    writeRuntimeCache(
      deploymentRecordCache,
      cacheKey,
      null,
      DEPLOYMENT_RECORD_CACHE_TTL_MS
    );
    await writeMetadataEdgeCache(key, null, DEPLOYMENT_RECORD_CACHE_TTL_MS);
    return null;
  }
  const deployment = record as DeploymentRecord;
  writeRuntimeCache(
    deploymentRecordCache,
    cacheKey,
    deployment,
    DEPLOYMENT_RECORD_CACHE_TTL_MS
  );
  await writeMetadataEdgeCache(key, deployment, DEPLOYMENT_RECORD_CACHE_TTL_MS);
  return deployment;
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

export const listDeploymentRecords = async (env: Env) => {
  const records: DeploymentRecord[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.DEPLOYMENTS_KV.list({
      prefix: "deployment:v1:",
      cursor
    });
    const loaded = await Promise.all(
      listed.keys.map(async (entry) => {
        const raw = await env.DEPLOYMENTS_KV.get(entry.name, "json");
        if (!raw || typeof raw !== "object") return null;
        const record = raw as Partial<DeploymentRecord>;
        if (record.version !== 1 || typeof record.orgSlug !== "string") return null;
        return record as DeploymentRecord;
      })
    );
    records.push(...loaded.filter((record): record is DeploymentRecord => Boolean(record)));
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return records;
};

export const loadWorkerScriptMapping = async (env: Env, scriptName: string) => {
  const raw = await env.DEPLOYMENTS_KV.get(workerScriptMappingKey(scriptName), "json");
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<WorkerScriptMapping>;
  if (
    record.version !== 1 ||
    typeof record.scriptName !== "string" ||
    typeof record.orgSlug !== "string" ||
    typeof record.repoSlug !== "string" ||
    typeof record.environment !== "string" ||
    typeof record.repository !== "string"
  ) {
    return null;
  }
  return record as WorkerScriptMapping;
};

export const loadAiTokenMapping = async (env: Env, tokenHash: string) => {
  const raw = await env.DEPLOYMENTS_KV.get(aiTokenMappingKey(tokenHash), "json");
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<AiTokenMapping>;
  if (
    record.version !== 1 ||
    typeof record.tokenHash !== "string" ||
    typeof record.orgSlug !== "string" ||
    typeof record.repoSlug !== "string" ||
    typeof record.environment !== "string" ||
    typeof record.repository !== "string"
  ) {
    return null;
  }
  return record as AiTokenMapping;
};

export const loadBindingTokenMapping = async (
  env: Env,
  kind: BindingTokenKind,
  tokenHash: string
) => {
  const raw = await env.DEPLOYMENTS_KV.get(bindingTokenMappingKey(kind, tokenHash), "json");
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<BindingTokenMapping>;
  if (
    record.version !== 1 ||
    record.kind !== kind ||
    typeof record.tokenHash !== "string" ||
    typeof record.orgSlug !== "string" ||
    typeof record.repoSlug !== "string" ||
    typeof record.environment !== "string" ||
    typeof record.repository !== "string"
  ) {
    return null;
  }
  return record as BindingTokenMapping;
};

export const storeCustomDomainMappings = async (
  env: Env,
  record: DeploymentRecord,
  hostnames: string[]
) => {
  await Promise.all(
    hostnames.map((hostname) => {
      const key = customDomainKey(hostname);
      const cacheKey = scopedRuntimeCacheKey(env, key);
      const mapping = {
        version: 1,
        hostname,
        orgSlug: record.orgSlug,
        repoSlug: record.repoSlug,
        environment: record.environment,
        repository: record.repository,
        deployedAt: record.deployedAt
      } satisfies CustomDomainMapping;
      writeRuntimeCache(
        customDomainCache,
        cacheKey,
        mapping,
        CUSTOM_DOMAIN_CACHE_TTL_MS
      );
      return Promise.all([
        env.DEPLOYMENTS_KV.put(key, JSON.stringify(mapping)),
        writeMetadataEdgeCache(key, mapping, CUSTOM_DOMAIN_CACHE_TTL_MS)
      ]);
    })
  );
};

export const replaceCustomDomainMappings = async (
  env: Env,
  record: DeploymentRecord,
  hostnames: string[]
) => {
  const wanted = new Set(hostnames.map((hostname) => hostname.trim().toLowerCase()));
  let cursor: string | undefined;
  do {
    const listed = await env.DEPLOYMENTS_KV.list({
      prefix: "custom_domain:v1:",
      cursor
    });
    await Promise.all(
      listed.keys.map(async (entry) => {
        const raw = await env.DEPLOYMENTS_KV.get(entry.name, "json");
        if (!raw || typeof raw !== "object") return;
        const mapping = raw as Partial<CustomDomainMapping>;
        if (
          mapping.version !== 1 ||
          mapping.orgSlug !== record.orgSlug ||
          mapping.repoSlug !== record.repoSlug ||
          mapping.environment !== record.environment ||
          !mapping.hostname ||
          wanted.has(mapping.hostname)
        ) {
          return;
        }
        await env.DEPLOYMENTS_KV.delete(entry.name);
        deleteRuntimeCache(customDomainCache, scopedRuntimeCacheKey(env, entry.name));
        await deleteMetadataEdgeCache(entry.name);
      })
    );
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);

  await storeCustomDomainMappings(env, record, hostnames);
};

export const loadCustomDomainMapping = async (env: Env, hostname: string) => {
  const key = customDomainKey(hostname);
  const cacheKey = scopedRuntimeCacheKey(env, key);
  const cached = readRuntimeCache(customDomainCache, cacheKey);
  if (cached !== undefined) return cached;

  const edgeCached = await readMetadataEdgeCache<CustomDomainMapping | null>(key);
  if (edgeCached !== undefined) {
    writeRuntimeCache(
      customDomainCache,
      cacheKey,
      edgeCached,
      CUSTOM_DOMAIN_CACHE_TTL_MS
    );
    return edgeCached;
  }

  const raw = await env.DEPLOYMENTS_KV.get(key, "json");
  if (!raw || typeof raw !== "object") {
    writeRuntimeCache(
      customDomainCache,
      cacheKey,
      null,
      CUSTOM_DOMAIN_CACHE_TTL_MS
    );
    await writeMetadataEdgeCache(key, null, CUSTOM_DOMAIN_CACHE_TTL_MS);
    return null;
  }
  const mapping = raw as Partial<CustomDomainMapping>;
  if (mapping.version !== 1 || typeof mapping.hostname !== "string") {
    writeRuntimeCache(
      customDomainCache,
      cacheKey,
      null,
      CUSTOM_DOMAIN_CACHE_TTL_MS
    );
    await writeMetadataEdgeCache(key, null, CUSTOM_DOMAIN_CACHE_TTL_MS);
    return null;
  }
  const customDomain = mapping as CustomDomainMapping;
  writeRuntimeCache(
    customDomainCache,
    cacheKey,
    customDomain,
    CUSTOM_DOMAIN_CACHE_TTL_MS
  );
  await writeMetadataEdgeCache(key, customDomain, CUSTOM_DOMAIN_CACHE_TTL_MS);
  return customDomain;
};

export const storeQueueMappings = async (
  env: Env,
  record: DeploymentRecord,
  queues: DeploymentQueue[]
) => {
  await Promise.all(
    queues.map((queue) =>
      env.DEPLOYMENTS_KV.put(
        queueMappingKey(queue.queueName),
        JSON.stringify({
          version: 1,
          queueName: queue.queueName,
          queueId: queue.queueId,
          queue: queue.name,
          consumer: queue.consumer,
          orgSlug: record.orgSlug,
          repoSlug: record.repoSlug,
          environment: record.environment,
          repository: record.repository,
          deployedAt: record.deployedAt
        } satisfies QueueMapping)
      )
    )
  );
};

export const replaceQueueMappings = async (
  env: Env,
  record: DeploymentRecord,
  queues: DeploymentQueue[]
) => {
  const wanted = new Set(queues.map((queue) => queue.queueName.trim().toLowerCase()));
  let cursor: string | undefined;
  do {
    const listed = await env.DEPLOYMENTS_KV.list({
      prefix: "queue_mapping:v1:",
      cursor
    });
    await Promise.all(
      listed.keys.map(async (entry) => {
        const raw = await env.DEPLOYMENTS_KV.get(entry.name, "json");
        if (!raw || typeof raw !== "object") return;
        const mapping = raw as Partial<QueueMapping>;
        if (
          mapping.version !== 1 ||
          mapping.orgSlug !== record.orgSlug ||
          mapping.repoSlug !== record.repoSlug ||
          mapping.environment !== record.environment ||
          !mapping.queueName ||
          wanted.has(mapping.queueName)
        ) {
          return;
        }
        await env.DEPLOYMENTS_KV.delete(entry.name);
      })
    );
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);

  await storeQueueMappings(env, record, queues);
};

export const loadQueueMapping = async (env: Env, queueName: string) => {
  const raw = await env.DEPLOYMENTS_KV.get(queueMappingKey(queueName), "json");
  if (!raw || typeof raw !== "object") return null;
  const mapping = raw as Partial<QueueMapping>;
  if (mapping.version !== 1 || typeof mapping.queueName !== "string") return null;
  return mapping as QueueMapping;
};

export const storeScheduleMappings = async (
  env: Env,
  record: DeploymentRecord,
  schedules: DeploymentSchedule[]
) => {
  await Promise.all(
    schedules.map((schedule) => {
      const id = scheduleMappingId(record, schedule);
      return env.DEPLOYMENTS_KV.put(
        scheduleMappingKey(id),
        JSON.stringify({
          version: 1,
          id,
          cron: schedule.cron,
          path: schedule.path,
          orgSlug: record.orgSlug,
          repoSlug: record.repoSlug,
          environment: record.environment,
          repository: record.repository,
          deployedAt: record.deployedAt
        } satisfies ScheduleMapping)
      );
    })
  );
};

export const replaceScheduleMappings = async (
  env: Env,
  record: DeploymentRecord,
  schedules: DeploymentSchedule[]
) => {
  const wanted = new Set(schedules.map((schedule) => scheduleMappingId(record, schedule)));
  let cursor: string | undefined;
  do {
    const listed = await env.DEPLOYMENTS_KV.list({
      prefix: "schedule_mapping:v1:",
      cursor
    });
    await Promise.all(
      listed.keys.map(async (entry) => {
        const raw = await env.DEPLOYMENTS_KV.get(entry.name, "json");
        if (!raw || typeof raw !== "object") return;
        const mapping = raw as Partial<ScheduleMapping>;
        if (
          mapping.version !== 1 ||
          mapping.orgSlug !== record.orgSlug ||
          mapping.repoSlug !== record.repoSlug ||
          mapping.environment !== record.environment ||
          !mapping.id ||
          wanted.has(mapping.id)
        ) {
          return;
        }
        await env.DEPLOYMENTS_KV.delete(entry.name);
      })
    );
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);

  await storeScheduleMappings(env, record, schedules);
};

export const listScheduleMappings = async (env: Env) => {
  const mappings: ScheduleMapping[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.DEPLOYMENTS_KV.list({
      prefix: "schedule_mapping:v1:",
      cursor
    });
    await Promise.all(
      listed.keys.map(async (entry) => {
        const raw = await env.DEPLOYMENTS_KV.get(entry.name, "json");
        if (!raw || typeof raw !== "object") return;
        const mapping = raw as Partial<ScheduleMapping>;
        if (
          mapping.version !== 1 ||
          typeof mapping.id !== "string" ||
          typeof mapping.cron !== "string" ||
          typeof mapping.path !== "string"
        ) {
          return;
        }
        mappings.push(mapping as ScheduleMapping);
      })
    );
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return mappings;
};

export const storeManagedResourceRecord = async (
  env: Env,
  record: ManagedResourceRecord
) => {
  await env.DEPLOYMENTS_KV.put(
    managedResourceKey(
      record.environment,
      record.orgSlug,
      record.repoSlug,
      record.kind,
      record.binding
    ),
    JSON.stringify(record)
  );
};

export const loadManagedResourceRecord = async (
  env: Env,
  environment: string,
  orgSlug: string,
  repoSlug: string,
  kind: ManagedResourceKind,
  binding: string
) => {
  const raw = await env.DEPLOYMENTS_KV.get(
    managedResourceKey(environment, orgSlug, repoSlug, kind, binding),
    "json"
  );
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<ManagedResourceRecord>;
  if (record.version !== 1 || record.kind !== kind || typeof record.id !== "string") {
    return null;
  }
  return record as ManagedResourceRecord;
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
  const cacheKey = scopedRuntimeCacheKey(env, key);
  await env.DEPLOYMENTS_KV.put(key, JSON.stringify(manifest));
  writeRuntimeCache(
    staticManifestCache,
    cacheKey,
    manifest,
    STATIC_MANIFEST_CACHE_TTL_MS
  );
  await writeMetadataEdgeCache(key, manifest, STATIC_MANIFEST_CACHE_TTL_MS);
  return key;
};

export const loadStaticSiteManifest = async (env: Env, key: string) => {
  const cacheKey = scopedRuntimeCacheKey(env, key);
  const cached = readRuntimeCache(staticManifestCache, cacheKey);
  if (cached !== undefined) return cached;

  const edgeCached = await readMetadataEdgeCache<StaticSiteManifest | null>(key);
  if (edgeCached !== undefined) {
    writeRuntimeCache(
      staticManifestCache,
      cacheKey,
      edgeCached,
      STATIC_MANIFEST_CACHE_TTL_MS
    );
    return edgeCached;
  }

  const raw = await env.DEPLOYMENTS_KV.get(key, "json");
  if (!raw || typeof raw !== "object") {
    writeRuntimeCache(
      staticManifestCache,
      cacheKey,
      null,
      STATIC_MANIFEST_CACHE_TTL_MS
    );
    await writeMetadataEdgeCache(key, null, STATIC_MANIFEST_CACHE_TTL_MS);
    return null;
  }
  const manifest = raw as Partial<StaticSiteManifest>;
  if (manifest.version !== 1 || typeof manifest.assetPrefix !== "string") {
    writeRuntimeCache(
      staticManifestCache,
      cacheKey,
      null,
      STATIC_MANIFEST_CACHE_TTL_MS
    );
    await writeMetadataEdgeCache(key, null, STATIC_MANIFEST_CACHE_TTL_MS);
    return null;
  }
  const staticManifest = manifest as StaticSiteManifest;
  writeRuntimeCache(
    staticManifestCache,
    cacheKey,
    staticManifest,
    STATIC_MANIFEST_CACHE_TTL_MS
  );
  await writeMetadataEdgeCache(key, staticManifest, STATIC_MANIFEST_CACHE_TTL_MS);
  return staticManifest;
};
