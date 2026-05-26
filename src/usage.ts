import type { Env } from "./env";
import { sanitizeScriptPart } from "./names";

export type UsageOutcome = "success" | "error";

export type UsageEvent = {
  metric: string;
  repository: string;
  environment: string;
  orgSlug: string;
  repoSlug: string;
  count?: number;
  units?: number;
  outcome?: UsageOutcome;
  source?: UsageMetricRollup["source"];
  at?: Date;
};

export type UsageMetricRollup = {
  count: number;
  units: number;
  success: number;
  error: number;
  lastAt: string;
  source?: "w7s" | "cloudflare" | "cloudflare_estimated";
};

export type UsageDailyRollup = {
  version: 1;
  date: string;
  orgSlug: string;
  repoSlug: string;
  environment: string;
  repository: string;
  metrics: Record<string, UsageMetricRollup>;
  updatedAt: string;
  cloudflareSyncedAt?: string;
  cloudflareHours?: string[];
};

const METRIC_PATTERN = /^[a-z][a-z0-9_.:-]{0,63}$/;
const OWNER_REPO_SLUG = "*";
const GLOBAL_ORG_SLUG = "*";
const GLOBAL_REPO_SLUG = "*";

export const usageDate = (date: Date) => date.toISOString().slice(0, 10);

export const usageKey = (params: {
  date: string;
  environment: string;
  orgSlug: string;
  repoSlug: string;
}) =>
  [
    "usage_daily:v1",
    params.date,
    sanitizeScriptPart(params.environment),
    sanitizeScriptPart(params.orgSlug),
    sanitizeScriptPart(params.repoSlug)
  ].join(":");

export const usageOwnerKey = (params: {
  date: string;
  environment: string;
  orgSlug: string;
}) =>
  [
    "usage_owner_daily:v1",
    params.date,
    sanitizeScriptPart(params.environment),
    sanitizeScriptPart(params.orgSlug)
  ].join(":");

export const usageGlobalKey = (params: {
  date: string;
  environment: string;
}) =>
  [
    "usage_global_daily:v1",
    params.date,
    sanitizeScriptPart(params.environment)
  ].join(":");

export const usageDailyPrefix = (params: {
  date: string;
  environment: string;
}) =>
  [
    "usage_daily:v1",
    params.date,
    sanitizeScriptPart(params.environment)
  ].join(":") + ":";

const positiveNumber = (value: number | undefined, fallback: number) =>
  Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;

const normalizeMetric = (metric: string) => {
  const normalized = metric.trim().toLowerCase();
  if (!METRIC_PATTERN.test(normalized)) {
    throw new Error(`Invalid usage metric: ${metric}`);
  }
  return normalized;
};

export const loadUsageDailyRollup = async (env: Env, params: {
  date: string;
  environment: string;
  orgSlug: string;
  repoSlug: string;
}) => {
  const raw = await env.DEPLOYMENTS_KV.get(usageKey(params), "json");
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<UsageDailyRollup>;
  if (record.version !== 1 || typeof record.date !== "string" || !record.metrics) return null;
  return record as UsageDailyRollup;
};

const loadUsageRollupFromKey = async (env: Env, key: string) => {
  const raw = await env.DEPLOYMENTS_KV.get(key, "json");
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<UsageDailyRollup>;
  if (record.version !== 1 || typeof record.date !== "string" || !record.metrics) return null;
  return record as UsageDailyRollup;
};

export const loadUsageOwnerDailyRollup = async (env: Env, params: {
  date: string;
  environment: string;
  orgSlug: string;
}) => loadUsageRollupFromKey(env, usageOwnerKey(params));

export const loadUsageGlobalDailyRollup = async (env: Env, params: {
  date: string;
  environment: string;
}) => loadUsageRollupFromKey(env, usageGlobalKey(params));

const emptyUsageRollup = (params: {
  date: string;
  environment: string;
  orgSlug: string;
  repoSlug: string;
  repository: string;
  at: Date;
}): UsageDailyRollup => ({
  version: 1,
  date: params.date,
  orgSlug: params.orgSlug,
  repoSlug: params.repoSlug,
  environment: params.environment,
  repository: params.repository,
  metrics: {},
  updatedAt: params.at.toISOString()
});

const applyMetricToRollup = (
  record: UsageDailyRollup,
  params: {
    metric: string;
    count: number;
    units: number;
    outcome?: UsageOutcome;
    source?: UsageMetricRollup["source"];
    at: Date;
  }
) => {
  const current = record.metrics[params.metric] ?? {
    count: 0,
    units: 0,
    success: 0,
    error: 0,
    lastAt: params.at.toISOString()
  };
  current.count += params.count;
  current.units += params.units;
  if (params.outcome === "error") current.error += params.count;
  else current.success += params.count;
  current.lastAt = params.at.toISOString();
  if (params.source) current.source = params.source;
  record.metrics[params.metric] = current;
  record.updatedAt = params.at.toISOString();
};

const recordUsageAtKey = async (
  env: Env,
  key: string,
  base: Omit<UsageDailyRollup, "version" | "metrics" | "updatedAt">,
  event: {
    metric: string;
    count: number;
    units: number;
    outcome?: UsageOutcome;
    source?: UsageMetricRollup["source"];
    at: Date;
  }
) => {
  const existing = await loadUsageRollupFromKey(env, key);
  const record = existing ?? emptyUsageRollup({ ...base, at: event.at });
  record.repository = base.repository;
  record.updatedAt = event.at.toISOString();
  applyMetricToRollup(record, event);
  await env.DEPLOYMENTS_KV.put(key, JSON.stringify(record));
};

const mergeMetricRollup = (
  target: Record<string, UsageMetricRollup>,
  metric: string,
  rollup: UsageMetricRollup
) => {
  const current = target[metric] ?? {
    count: 0,
    units: 0,
    success: 0,
    error: 0,
    lastAt: rollup.lastAt,
    source: rollup.source
  };
  current.count += rollup.count;
  current.units += rollup.units;
  current.success += rollup.success;
  current.error += rollup.error;
  current.lastAt = rollup.lastAt > current.lastAt ? rollup.lastAt : current.lastAt;
  if (rollup.source === "cloudflare_estimated") current.source = rollup.source;
  else if (rollup.source && !current.source) current.source = rollup.source;
  target[metric] = current;
};

export const listUsageDailyRollups = async (env: Env, params: {
  date: string;
  environment: string;
}) => {
  const records: UsageDailyRollup[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.DEPLOYMENTS_KV.list({
      prefix: usageDailyPrefix(params),
      cursor
    });
    const loaded = await Promise.all(
      listed.keys.map(async (entry) => loadUsageRollupFromKey(env, entry.name))
    );
    records.push(...loaded.filter((record): record is UsageDailyRollup => Boolean(record)));
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return records;
};

export const rebuildUsageAggregatesForDate = async (env: Env, params: {
  date: string;
  environment: string;
}) => {
  const rollups = await listUsageDailyRollups(env, params);
  const now = new Date().toISOString();
  const ownerMetrics = new Map<string, Record<string, UsageMetricRollup>>();
  const globalMetrics: Record<string, UsageMetricRollup> = {};

  for (const rollup of rollups) {
    const owner = rollup.orgSlug;
    const ownerBucket = ownerMetrics.get(owner) ?? {};
    for (const [metric, metricRollup] of Object.entries(rollup.metrics)) {
      mergeMetricRollup(ownerBucket, metric, metricRollup);
      mergeMetricRollup(globalMetrics, metric, metricRollup);
    }
    ownerMetrics.set(owner, ownerBucket);
  }

  await Promise.all([
    ...[...ownerMetrics.entries()].map(([orgSlug, metrics]) =>
      env.DEPLOYMENTS_KV.put(
        usageOwnerKey({ date: params.date, environment: params.environment, orgSlug }),
        JSON.stringify({
          version: 1,
          date: params.date,
          orgSlug,
          repoSlug: OWNER_REPO_SLUG,
          environment: params.environment,
          repository: `${orgSlug}/*`,
          metrics,
          updatedAt: now
        } satisfies UsageDailyRollup)
      )
    ),
    env.DEPLOYMENTS_KV.put(
      usageGlobalKey(params),
      JSON.stringify({
        version: 1,
        date: params.date,
        orgSlug: GLOBAL_ORG_SLUG,
        repoSlug: GLOBAL_REPO_SLUG,
        environment: params.environment,
        repository: "*/*",
        metrics: globalMetrics,
        updatedAt: now
      } satisfies UsageDailyRollup)
    )
  ]);
};

export const recordUsageEvent = async (env: Env, event: UsageEvent) => {
  try {
    const metric = normalizeMetric(event.metric);
    const at = event.at ?? new Date();
    const date = usageDate(at);
    const count = positiveNumber(event.count, 1);
    const units = positiveNumber(event.units, count);
    const eventRecord = {
      metric,
      count,
      units,
      outcome: event.outcome,
      source: event.source,
      at
    };

    await Promise.all([
      recordUsageAtKey(
        env,
        usageKey({
          date,
          environment: event.environment,
          orgSlug: event.orgSlug,
          repoSlug: event.repoSlug
        }),
        {
          date,
          environment: event.environment,
          orgSlug: event.orgSlug,
          repoSlug: event.repoSlug,
          repository: event.repository
        },
        eventRecord
      ),
      recordUsageAtKey(
        env,
        usageOwnerKey({
          date,
          environment: event.environment,
          orgSlug: event.orgSlug
        }),
        {
          date,
          environment: event.environment,
          orgSlug: event.orgSlug,
          repoSlug: OWNER_REPO_SLUG,
          repository: `${event.orgSlug}/*`
        },
        eventRecord
      ),
      recordUsageAtKey(
        env,
        usageGlobalKey({
          date,
          environment: event.environment
        }),
        {
          date,
          environment: event.environment,
          orgSlug: GLOBAL_ORG_SLUG,
          repoSlug: GLOBAL_REPO_SLUG,
          repository: "*/*"
        },
        eventRecord
      )
    ]);
  } catch {
    // Usage rollups are best-effort until a strongly consistent store is added.
  }
};
