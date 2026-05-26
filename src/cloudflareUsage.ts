import { clearAppLimitState, suspendAppForLimits } from "./appLimits";
import type { Env } from "./env";
import { sanitizeScriptPart } from "./names";
import { loadUsageDailyRollup, usageDate, usageKey, type UsageDailyRollup, type UsageMetricRollup } from "./usage";
import { evaluateUsageLimits, loadEffectiveUsageLimitPolicies } from "./usageLimits";
import {
  listDeploymentRecords,
  type DeploymentRecord
} from "./storage/deployments";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const COLLECTION_LOCK_TTL_SECONDS = 3 * 60 * 60;
const CLOUDFLARE_METRIC_SOURCES = new Set([
  "worker.request",
  "runtime.cpu_ms",
  "worker.script",
  "r2.class_a",
  "r2.class_b",
  "r2.storage_bytes",
  "kv.read",
  "kv.write",
  "kv.delete",
  "kv.list",
  "kv.storage_bytes",
  "d1.rows_read",
  "d1.rows_written",
  "d1.read_queries",
  "d1.write_queries",
  "d1.storage_bytes",
  "durable_object.request",
  "durable_object.duration_ms"
]);
const GAUGE_METRICS = new Set([
  "worker.script",
  "r2.storage_bytes",
  "kv.storage_bytes",
  "d1.storage_bytes"
]);

type UsageMetricSource = UsageMetricRollup["source"];

export type CloudflareUsageHourlyRecord = {
  version: 1;
  hour: string;
  hourStart: string;
  hourEnd: string;
  date: string;
  environment: string;
  orgSlug: string;
  repoSlug: string;
  repository: string;
  metrics: Record<string, UsageMetricRollup>;
  source: "cloudflare";
  syncedAt: string;
};

type CollectorMetric = {
  metric: string;
  units: number;
  count?: number;
  source?: UsageMetricSource;
};

const numberValue = (...values: unknown[]) => {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return 0;
};

const addMetric = (
  metrics: Map<string, CollectorMetric>,
  metric: string,
  units: number,
  source: UsageMetricSource = "cloudflare",
  count = units
) => {
  if (!Number.isFinite(units) || units <= 0) return;
  const current = metrics.get(metric);
  metrics.set(metric, {
    metric,
    units: (current?.units ?? 0) + units,
    count: (current?.count ?? 0) + count,
    source: current?.source === "cloudflare_estimated" ? current.source : source
  });
};

const hourStart = (date: Date) => {
  const value = new Date(date);
  value.setUTCMinutes(0, 0, 0);
  return value;
};

const previousClosedHour = (now: Date) => {
  const end = hourStart(now);
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  return { start, end };
};

const hourId = (date: Date) => date.toISOString().slice(0, 13);

export const cloudflareUsageHourlyKey = (params: {
  hour: string;
  environment: string;
  orgSlug: string;
  repoSlug: string;
}) =>
  [
    "usage_cf_hourly:v1",
    params.hour,
    sanitizeScriptPart(params.environment),
    sanitizeScriptPart(params.orgSlug),
    sanitizeScriptPart(params.repoSlug)
  ].join(":");

const collectionLockKey = (hour: string) => `usage_collect_lock:v1:${sanitizeScriptPart(hour)}`;

const readNumber = (value: unknown, keys: string[]) => {
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  return numberValue(...keys.map((key) => record[key]));
};

const graphqlRequest = async (
  env: Env,
  query: string,
  variables: Record<string, unknown>
) => {
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) return null;
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });
  const payload = await response.json().catch(() => null) as
    | { data?: unknown; errors?: unknown[] }
    | null;
  if (!response.ok || payload?.errors) {
    throw new Error(`Cloudflare GraphQL request failed with HTTP ${response.status}.`);
  }
  return payload?.data ?? null;
};

const accountNode = (data: unknown) => {
  const accounts = (data as { viewer?: { accounts?: unknown[] } } | null)?.viewer?.accounts;
  return Array.isArray(accounts) ? accounts[0] as Record<string, unknown> | undefined : undefined;
};

const queryWorkerMetrics = async (env: Env, params: {
  accountId: string;
  scriptName: string;
  start: string;
  end: string;
}) => {
  const query = `
    query W7SWorkerUsage($accountTag: string!, $scriptName: string!, $start: string!, $end: string!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(limit: 1000, filter: {
            scriptName: $scriptName,
            datetime_geq: $start,
            datetime_leq: $end
          }) {
            sum { requests errors subrequests }
            quantiles { cpuTimeP50 cpuTimeP99 }
            dimensions { scriptName status datetime }
          }
        }
      }
    }
  `;
  const data = await graphqlRequest(env, query, {
    accountTag: params.accountId,
    scriptName: params.scriptName,
    start: params.start,
    end: params.end
  });
  const rows = accountNode(data)?.workersInvocationsAdaptive;
  const metrics = new Map<string, CollectorMetric>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const record = row as { sum?: Record<string, unknown>; quantiles?: Record<string, unknown> };
    const requests = readNumber(record.sum, ["requests"]);
    addMetric(metrics, "worker.request", requests);
    const estimated = requests * readNumber(record.quantiles, ["cpuTimeP99", "cpuTimeP50"]);
    addMetric(metrics, "runtime.cpu_ms", estimated, "cloudflare_estimated", requests);
  }
  return [...metrics.values()];
};

const queryDurableObjectMetrics = async (env: Env, params: {
  accountId: string;
  scriptName: string;
  start: string;
  end: string;
}) => {
  const query = `
    query W7SDurableObjectUsage($accountTag: string!, $scriptName: string!, $start: Time, $end: Time) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: {
            scriptName: $scriptName,
            datetime_geq: $start,
            datetime_leq: $end
          }) {
            sum { requests wallTime errors }
            dimensions { scriptName namespaceId datetime status }
          }
        }
      }
    }
  `;
  const data = await graphqlRequest(env, query, {
    accountTag: params.accountId,
    scriptName: params.scriptName,
    start: params.start,
    end: params.end
  });
  const rows = accountNode(data)?.durableObjectsInvocationsAdaptiveGroups;
  const metrics = new Map<string, CollectorMetric>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const sum = (row as { sum?: Record<string, unknown> }).sum;
    addMetric(metrics, "durable_object.request", readNumber(sum, ["requests"]));
    addMetric(metrics, "durable_object.duration_ms", readNumber(sum, ["wallTime"]));
  }
  return [...metrics.values()];
};

const queryKvMetrics = async (env: Env, params: {
  accountId: string;
  namespaceId: string;
  start: string;
  end: string;
}) => {
  const query = `
    query W7SKvUsage($accountTag: string!, $namespaceId: string!, $start: Time, $end: Time) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          kvOperationsAdaptiveGroups(limit: 10000, filter: {
            namespaceId: $namespaceId,
            datetime_geq: $start,
            datetime_leq: $end
          }) {
            sum { requests }
            dimensions { namespaceId actionType datetime }
          }
          kvStorageAdaptiveGroups(limit: 1000, filter: {
            namespaceId: $namespaceId,
            datetime_geq: $start,
            datetime_leq: $end
          }) {
            max { byteCount keyCount }
            dimensions { namespaceId datetime }
          }
        }
      }
    }
  `;
  const data = await graphqlRequest(env, query, {
    accountTag: params.accountId,
    namespaceId: params.namespaceId,
    start: params.start,
    end: params.end
  });
  const account = accountNode(data);
  const metrics = new Map<string, CollectorMetric>();
  for (const row of Array.isArray(account?.kvOperationsAdaptiveGroups) ? account.kvOperationsAdaptiveGroups : []) {
    const record = row as {
      sum?: Record<string, unknown>;
      dimensions?: Record<string, unknown>;
    };
    const action = String(record.dimensions?.actionType ?? "").toLowerCase();
    const requests = readNumber(record.sum, ["requests"]);
    if (action.includes("write") || action.includes("put")) addMetric(metrics, "kv.write", requests);
    else if (action.includes("delete")) addMetric(metrics, "kv.delete", requests);
    else if (action.includes("list")) addMetric(metrics, "kv.list", requests);
    else addMetric(metrics, "kv.read", requests);
  }
  for (const row of Array.isArray(account?.kvStorageAdaptiveGroups) ? account.kvStorageAdaptiveGroups : []) {
    const value = readNumber((row as { max?: Record<string, unknown> }).max, ["byteCount"]);
    addMetric(metrics, "kv.storage_bytes", value);
  }
  return [...metrics.values()];
};

const queryD1Metrics = async (env: Env, params: {
  accountId: string;
  databaseId: string;
  start: string;
  end: string;
}) => {
  const query = `
    query W7SD1Usage($accountTag: string!, $databaseId: string!, $start: Time, $end: Time) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          d1AnalyticsAdaptiveGroups(limit: 10000, filter: {
            datetime_geq: $start,
            datetime_leq: $end,
            databaseId: $databaseId
          }) {
            sum {
              rowsRead
              rowsWritten
              readQueries
              writeQueries
            }
            dimensions { databaseId date }
          }
          d1StorageAdaptiveGroups(limit: 1000, filter: {
            datetime_geq: $start,
            datetime_leq: $end,
            databaseId: $databaseId
          }) {
            max { databaseSizeBytes }
            dimensions { databaseId date }
          }
        }
      }
    }
  `;
  const data = await graphqlRequest(env, query, {
    accountTag: params.accountId,
    databaseId: params.databaseId,
    start: params.start,
    end: params.end
  });
  const account = accountNode(data);
  const metrics = new Map<string, CollectorMetric>();
  for (const row of Array.isArray(account?.d1AnalyticsAdaptiveGroups) ? account.d1AnalyticsAdaptiveGroups : []) {
    const sum = (row as { sum?: Record<string, unknown> }).sum;
    addMetric(metrics, "d1.rows_read", readNumber(sum, ["rowsRead"]));
    addMetric(metrics, "d1.rows_written", readNumber(sum, ["rowsWritten"]));
    addMetric(metrics, "d1.read_queries", readNumber(sum, ["readQueries"]));
    addMetric(metrics, "d1.write_queries", readNumber(sum, ["writeQueries"]));
  }
  for (const row of Array.isArray(account?.d1StorageAdaptiveGroups) ? account.d1StorageAdaptiveGroups : []) {
    const value = readNumber((row as { max?: Record<string, unknown> }).max, ["databaseSizeBytes"]);
    addMetric(metrics, "d1.storage_bytes", value);
  }
  return [...metrics.values()];
};

const queryR2Metrics = async (env: Env, params: {
  accountId: string;
  bucketName: string;
  start: string;
  end: string;
}) => {
  const query = `
    query W7SR2Usage($accountTag: string!, $bucketName: string!, $start: Time, $end: Time) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2OperationsAdaptiveGroups(limit: 10000, filter: {
            datetime_geq: $start,
            datetime_leq: $end,
            bucketName: $bucketName
          }) {
            sum { requests }
            dimensions { actionType actionStatus bucketName datetime }
          }
          r2StorageAdaptiveGroups(limit: 1000, filter: {
            datetime_geq: $start,
            datetime_leq: $end,
            bucketName: $bucketName
          }) {
            max { payloadSize metadataSize objectCount }
            dimensions { bucketName datetime }
          }
        }
      }
    }
  `;
  const data = await graphqlRequest(env, query, {
    accountTag: params.accountId,
    bucketName: params.bucketName,
    start: params.start,
    end: params.end
  });
  const account = accountNode(data);
  const metrics = new Map<string, CollectorMetric>();
  for (const row of Array.isArray(account?.r2OperationsAdaptiveGroups) ? account.r2OperationsAdaptiveGroups : []) {
    const record = row as {
      sum?: Record<string, unknown>;
      dimensions?: Record<string, unknown>;
    };
    const action = String(record.dimensions?.actionType ?? "").toLowerCase();
    const count = readNumber(record.sum, ["requests"]);
    if (/get|head|read|list/.test(action)) addMetric(metrics, "r2.class_b", count);
    else addMetric(metrics, "r2.class_a", count);
  }
  for (const row of Array.isArray(account?.r2StorageAdaptiveGroups) ? account.r2StorageAdaptiveGroups : []) {
    const max = (row as { max?: Record<string, unknown> }).max;
    const size = readNumber(max, ["payloadSize"]) + readNumber(max, ["metadataSize"]);
    addMetric(metrics, "r2.storage_bytes", size);
  }
  return [...metrics.values()];
};

const metricRollups = (metrics: CollectorMetric[], at: Date) => {
  const output: Record<string, UsageMetricRollup> = {};
  for (const metric of metrics) {
    output[metric.metric] = {
      count: metric.count ?? metric.units,
      units: metric.units,
      success: metric.count ?? metric.units,
      error: 0,
      lastAt: at.toISOString(),
      source: metric.source ?? "cloudflare"
    };
  }
  return output;
};

const safeCollect = async (
  label: string,
  collect: () => Promise<CollectorMetric[]>
) => {
  try {
    return await collect();
  } catch (error) {
    console.warn(`W7S Cloudflare usage adapter failed for ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
};

export const storeCloudflareUsageHourlyRecord = async (
  env: Env,
  record: CloudflareUsageHourlyRecord
) => {
  await env.DEPLOYMENTS_KV.put(
    cloudflareUsageHourlyKey(record),
    JSON.stringify(record)
  );
};

export const listCloudflareUsageHourlyRecords = async (
  env: Env,
  params: {
    date: string;
    environment: string;
    orgSlug: string;
    repoSlug: string;
  }
) => {
  const prefix = `usage_cf_hourly:v1:${params.date}`;
  const records: CloudflareUsageHourlyRecord[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.DEPLOYMENTS_KV.list({
      prefix,
      cursor
    });
    const loaded = await Promise.all(
      listed.keys.map(async (entry) => {
        const raw = await env.DEPLOYMENTS_KV.get(entry.name, "json");
        if (!raw || typeof raw !== "object") return null;
        const record = raw as Partial<CloudflareUsageHourlyRecord>;
        if (record.version !== 1 || typeof record.hour !== "string") return null;
        if (
          record.environment !== params.environment ||
          record.orgSlug !== params.orgSlug ||
          record.repoSlug !== params.repoSlug
        ) {
          return null;
        }
        return record as CloudflareUsageHourlyRecord;
      })
    );
    records.push(...loaded.filter((record): record is CloudflareUsageHourlyRecord => Boolean(record)));
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return records.sort((a, b) => a.hour.localeCompare(b.hour));
};

export const mergeCloudflareHourlyIntoDaily = async (
  env: Env,
  params: {
    date: string;
    environment: string;
    orgSlug: string;
    repoSlug: string;
    repository: string;
  }
) => {
  const hourly = await listCloudflareUsageHourlyRecords(env, params);
  const existing = await loadUsageDailyRollup(env, params);
  const now = new Date().toISOString();
  const daily: UsageDailyRollup = existing ?? {
    version: 1,
    date: params.date,
    orgSlug: params.orgSlug,
    repoSlug: params.repoSlug,
    environment: params.environment,
    repository: params.repository,
    metrics: {},
    updatedAt: now
  };

  for (const metric of CLOUDFLARE_METRIC_SOURCES) delete daily.metrics[metric];

  const totals = new Map<string, UsageMetricRollup>();
  for (const record of hourly) {
    for (const [metric, rollup] of Object.entries(record.metrics)) {
      const current = totals.get(metric) ?? {
        count: 0,
        units: 0,
        success: 0,
        error: 0,
        lastAt: record.syncedAt,
        source: rollup.source
      };
      if (GAUGE_METRICS.has(metric)) {
        current.count = Math.max(current.count, rollup.count);
        current.units = Math.max(current.units, rollup.units);
        current.success = Math.max(current.success, rollup.success);
      } else {
        current.count += rollup.count;
        current.units += rollup.units;
        current.success += rollup.success;
      }
      current.error += rollup.error;
      current.lastAt = rollup.lastAt > current.lastAt ? rollup.lastAt : current.lastAt;
      if (rollup.source === "cloudflare_estimated") current.source = rollup.source;
      totals.set(metric, current);
    }
  }
  for (const [metric, rollup] of totals) daily.metrics[metric] = rollup;
  daily.repository = params.repository;
  daily.updatedAt = now;
  daily.cloudflareSyncedAt = hourly.at(-1)?.syncedAt ?? daily.cloudflareSyncedAt;
  daily.cloudflareHours = hourly.map((record) => record.hour);

  await env.DEPLOYMENTS_KV.put(usageKey(params), JSON.stringify(daily));
  return daily;
};

const collectDeploymentMetrics = async (env: Env, deployment: DeploymentRecord, params: {
  accountId: string;
  hour: string;
  start: Date;
  end: Date;
  syncedAt: Date;
}) => {
  const metrics = new Map<string, CollectorMetric>();
  if (deployment.targets.worker?.scriptName) {
    addMetric(metrics, "worker.script", 1);
    for (const metric of await safeCollect("worker", () => queryWorkerMetrics(env, {
      accountId: params.accountId,
      scriptName: deployment.targets.worker!.scriptName,
      start: params.start.toISOString(),
      end: params.end.toISOString()
    }))) {
      addMetric(metrics, metric.metric, metric.units, metric.source, metric.count);
    }
  }
  if (deployment.targets.worker?.scriptName && (deployment.bindings?.durableObjects?.length ?? 0) > 0) {
    for (const metric of await safeCollect("durable_object", () => queryDurableObjectMetrics(env, {
      accountId: params.accountId,
      scriptName: deployment.targets.worker!.scriptName,
      start: params.start.toISOString(),
      end: params.end.toISOString()
    }))) {
      addMetric(metrics, metric.metric, metric.units, metric.source, metric.count);
    }
  }
  for (const kv of deployment.bindings?.kv ?? []) {
    for (const metric of await safeCollect("kv", () => queryKvMetrics(env, {
      accountId: params.accountId,
      namespaceId: kv.namespaceId,
      start: params.start.toISOString(),
      end: params.end.toISOString()
    }))) {
      addMetric(metrics, metric.metric, metric.units, metric.source, metric.count);
    }
  }
  for (const d1 of deployment.bindings?.d1 ?? []) {
    for (const metric of await safeCollect("d1", () => queryD1Metrics(env, {
      accountId: params.accountId,
      databaseId: d1.databaseId,
      start: params.start.toISOString(),
      end: params.end.toISOString()
    }))) {
      addMetric(metrics, metric.metric, metric.units, metric.source, metric.count);
    }
  }
  for (const r2 of deployment.bindings?.r2 ?? []) {
    for (const metric of await safeCollect("r2", () => queryR2Metrics(env, {
      accountId: params.accountId,
      bucketName: r2.bucketName,
      start: params.start.toISOString(),
      end: params.end.toISOString()
    }))) {
      addMetric(metrics, metric.metric, metric.units, metric.source, metric.count);
    }
  }

  const record: CloudflareUsageHourlyRecord = {
    version: 1,
    hour: params.hour,
    hourStart: params.start.toISOString(),
    hourEnd: params.end.toISOString(),
    date: usageDate(params.start),
    environment: deployment.environment,
    orgSlug: deployment.orgSlug,
    repoSlug: deployment.repoSlug,
    repository: deployment.repository,
    metrics: metricRollups([...metrics.values()], params.syncedAt),
    source: "cloudflare",
    syncedAt: params.syncedAt.toISOString()
  };
  await storeCloudflareUsageHourlyRecord(env, record);
  const daily = await mergeCloudflareHourlyIntoDaily(env, {
    date: record.date,
    environment: record.environment,
    orgSlug: record.orgSlug,
    repoSlug: record.repoSlug,
    repository: record.repository
  });
  const effectivePolicies = await loadEffectiveUsageLimitPolicies(env, {
    environment: deployment.environment,
    orgSlug: deployment.orgSlug,
    repoSlug: deployment.repoSlug
  });
  const limits = evaluateUsageLimits(daily, effectivePolicies.policies);
  const exceeded = limits.warnings.filter((warning) =>
    warning.status === "exceeded" &&
    daily.metrics[warning.metric]?.source !== "cloudflare_estimated"
  );
  if (exceeded.length > 0) {
    await suspendAppForLimits(env, {
      environment: deployment.environment,
      orgSlug: deployment.orgSlug,
      repoSlug: deployment.repoSlug,
      reason: `W7S free-tier limit exceeded for ${exceeded[0]?.metric}.`,
      metrics: exceeded,
      at: params.syncedAt
    });
  } else {
    await clearAppLimitState(env, {
      environment: deployment.environment,
      orgSlug: deployment.orgSlug,
      repoSlug: deployment.repoSlug
    });
  }
  return record;
};

export const collectHourlyCloudflareUsage = async (
  env: Env,
  now = new Date()
) => {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!env.CLOUDFLARE_API_TOKEN?.trim() || !accountId) {
    return { collected: false, reason: "missing Cloudflare credentials", deployments: 0 };
  }
  const { start, end } = previousClosedHour(now);
  const hour = hourId(start);
  const lockKey = collectionLockKey(hour);
  const existingLock = await env.DEPLOYMENTS_KV.get(lockKey);
  if (existingLock) return { collected: false, reason: "already collected", deployments: 0 };
  await env.DEPLOYMENTS_KV.put(lockKey, now.toISOString(), {
    expirationTtl: COLLECTION_LOCK_TTL_SECONDS
  });

  const deployments = await listDeploymentRecords(env);
  const settled = await Promise.allSettled(
    deployments.map((deployment) =>
      collectDeploymentMetrics(env, deployment, {
        accountId,
        hour,
        start,
        end,
        syncedAt: now
      })
    )
  );
  const failures = settled.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
  if (failures.length > 0) {
    console.warn(`W7S Cloudflare usage collection failed for ${failures.length} deployment(s).`);
  }
  return {
    collected: true,
    hour,
    deployments: deployments.length,
    failures: failures.length
  };
};
