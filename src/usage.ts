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

export const recordUsageEvent = async (env: Env, event: UsageEvent) => {
  try {
    const metric = normalizeMetric(event.metric);
    const at = event.at ?? new Date();
    const date = usageDate(at);
    const key = usageKey({
      date,
      environment: event.environment,
      orgSlug: event.orgSlug,
      repoSlug: event.repoSlug
    });
    const existing = await loadUsageDailyRollup(env, {
      date,
      environment: event.environment,
      orgSlug: event.orgSlug,
      repoSlug: event.repoSlug
    });
    const record: UsageDailyRollup = existing ?? {
      version: 1,
      date,
      orgSlug: event.orgSlug,
      repoSlug: event.repoSlug,
      environment: event.environment,
      repository: event.repository,
      metrics: {},
      updatedAt: at.toISOString()
    };
    record.repository = event.repository;
    record.updatedAt = at.toISOString();

    const count = positiveNumber(event.count, 1);
    const units = positiveNumber(event.units, count);
    const current = record.metrics[metric] ?? {
      count: 0,
      units: 0,
      success: 0,
      error: 0,
      lastAt: at.toISOString()
    };
    current.count += count;
    current.units += units;
    if (event.outcome === "error") current.error += count;
    else current.success += count;
    current.lastAt = at.toISOString();
    if (event.source) current.source = event.source;
    record.metrics[metric] = current;

    await env.DEPLOYMENTS_KV.put(key, JSON.stringify(record));
  } catch {
    // Usage rollups are best-effort until a strongly consistent store is added.
  }
};
