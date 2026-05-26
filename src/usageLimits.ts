import type { Env } from "./env";
import { sanitizeScriptPart } from "./names";
import { loadUsageDailyRollup, usageDate, type UsageDailyRollup } from "./usage";

export type UsageLimitStatus = "ok" | "warning" | "exceeded";
export type UsageLimitPolicySource =
  | "default"
  | "owner"
  | "owner_environment"
  | "repo"
  | "repo_environment";

export type UsageLimitPolicy = {
  metric: string;
  dailyUnits: number;
  warningThreshold: number;
  source?: UsageLimitPolicySource;
};

export type UsageLimitWarning = {
  metric: string;
  status: Exclude<UsageLimitStatus, "ok">;
  used: number;
  limit: number;
  remaining: number;
  message: string;
};

export type UsageLimitMetricEvaluation = {
  metric: string;
  used: number;
  limit: number;
  remaining: number;
  usageRatio: number;
  status: UsageLimitStatus;
  source?: UsageLimitPolicySource;
};

export type UsageLimitEvaluation = {
  version: 1;
  period: "daily";
  mode: "enforce";
  metrics: Record<string, UsageLimitMetricEvaluation>;
  warnings: UsageLimitWarning[];
};

export type UsageLimitCheck = {
  version: 1;
  mode: "enforce";
  enforcement: "hard";
  metric: string;
  date: string;
  environment: string;
  orgSlug: string;
  repoSlug: string;
  used: number;
  requestedUnits: number;
  projectedUnits: number;
  limit: number;
  remaining: number;
  usageRatio: number;
  projectedUsageRatio: number;
  status: UsageLimitStatus;
  projectedStatus: UsageLimitStatus;
  wouldBlock: boolean;
  source?: UsageLimitPolicySource;
  policy: UsageLimitPolicy;
};

export const DEFAULT_DAILY_USAGE_LIMITS: UsageLimitPolicy[] = [
  { metric: "deploy", dailyUnits: 50, warningThreshold: 0.8, source: "default" },
  { metric: "runtime.request", dailyUnits: 10_000, warningThreshold: 0.8, source: "default" },
  { metric: "worker.request", dailyUnits: 10_000, warningThreshold: 0.8, source: "default" },
  { metric: "runtime.cpu_ms", dailyUnits: 300_000, warningThreshold: 0.8, source: "default" },
  { metric: "worker.script", dailyUnits: 5, warningThreshold: 0.8, source: "default" },
  { metric: "static.r2_class_a", dailyUnits: 1_000, warningThreshold: 0.8, source: "default" },
  { metric: "static.r2_class_b", dailyUnits: 20_000, warningThreshold: 0.8, source: "default" },
  { metric: "r2.class_a", dailyUnits: 1_000, warningThreshold: 0.8, source: "default" },
  { metric: "r2.class_b", dailyUnits: 20_000, warningThreshold: 0.8, source: "default" },
  { metric: "r2.storage_bytes", dailyUnits: 100 * 1024 * 1024, warningThreshold: 0.8, source: "default" },
  { metric: "kv.read", dailyUnits: 10_000, warningThreshold: 0.8, source: "default" },
  { metric: "kv.write", dailyUnits: 1_000, warningThreshold: 0.8, source: "default" },
  { metric: "kv.delete", dailyUnits: 1_000, warningThreshold: 0.8, source: "default" },
  { metric: "kv.list", dailyUnits: 1_000, warningThreshold: 0.8, source: "default" },
  { metric: "kv.storage_bytes", dailyUnits: 50 * 1024 * 1024, warningThreshold: 0.8, source: "default" },
  { metric: "d1.rows_read", dailyUnits: 100_000, warningThreshold: 0.8, source: "default" },
  { metric: "d1.rows_written", dailyUnits: 10_000, warningThreshold: 0.8, source: "default" },
  { metric: "d1.read_queries", dailyUnits: 10_000, warningThreshold: 0.8, source: "default" },
  { metric: "d1.write_queries", dailyUnits: 1_000, warningThreshold: 0.8, source: "default" },
  { metric: "d1.storage_bytes", dailyUnits: 50 * 1024 * 1024, warningThreshold: 0.8, source: "default" },
  { metric: "durable_object.request", dailyUnits: 5_000, warningThreshold: 0.8, source: "default" },
  { metric: "durable_object.duration_ms", dailyUnits: 300_000, warningThreshold: 0.8, source: "default" },
  { metric: "durable_object.rows_read", dailyUnits: 100_000, warningThreshold: 0.8, source: "default" },
  { metric: "durable_object.rows_written", dailyUnits: 10_000, warningThreshold: 0.8, source: "default" },
  { metric: "durable_object.storage_read_units", dailyUnits: 100_000, warningThreshold: 0.8, source: "default" },
  { metric: "durable_object.storage_write_units", dailyUnits: 10_000, warningThreshold: 0.8, source: "default" },
  { metric: "durable_object.storage_deletes", dailyUnits: 10_000, warningThreshold: 0.8, source: "default" },
  { metric: "rpc.dispatch", dailyUnits: 10_000, warningThreshold: 0.8, source: "default" },
  { metric: "queue.send", dailyUnits: 10_000, warningThreshold: 0.8, source: "default" },
  { metric: "queue.delivery", dailyUnits: 10_000, warningThreshold: 0.8, source: "default" },
  { metric: "schedule.delivery", dailyUnits: 2_000, warningThreshold: 0.8, source: "default" },
  { metric: "workflow.create", dailyUnits: 1_000, warningThreshold: 0.8, source: "default" },
  { metric: "workflow.delivery", dailyUnits: 1_000, warningThreshold: 0.8, source: "default" }
];

export type UsageLimitPolicyRecord = {
  version: 1;
  metrics: Record<string, number | {
    dailyUnits?: number;
    warningThreshold?: number;
  }>;
  updatedAt?: string;
};

export type UsageLimitPolicyLookup = {
  scope: UsageLimitPolicySource;
  key: string | null;
  found: boolean;
  metrics: string[];
};

export type EffectiveUsageLimitPolicies = {
  version: 1;
  period: "daily";
  mode: "enforce";
  environment: string;
  orgSlug: string;
  repoSlug: string;
  policies: UsageLimitPolicy[];
  policy: Record<string, UsageLimitPolicy>;
  lookups: UsageLimitPolicyLookup[];
};

export const usageLimitPolicyKey = (params: {
  scope: Exclude<UsageLimitPolicySource, "default">;
  environment?: string;
  orgSlug: string;
  repoSlug?: string;
}) => {
  const environment = params.environment ? sanitizeScriptPart(params.environment) : null;
  const org = sanitizeScriptPart(params.orgSlug);
  const repo = params.repoSlug ? sanitizeScriptPart(params.repoSlug) : null;

  if (params.scope === "owner") return `usage_limit_policy:v1:owner:${org}`;
  if (params.scope === "owner_environment") {
    return `usage_limit_policy:v1:owner_environment:${environment}:${org}`;
  }
  if (params.scope === "repo") return `usage_limit_policy:v1:repo:${org}:${repo}`;
  return `usage_limit_policy:v1:repo_environment:${environment}:${org}:${repo}`;
};

const ratio = (used: number, limit: number) =>
  limit > 0 ? Number((used / limit).toFixed(4)) : 0;

const statusFor = (params: {
  used: number;
  limit: number;
  warningThreshold: number;
}): UsageLimitStatus => {
  if (params.used > params.limit) return "exceeded";
  if (params.used >= params.limit * params.warningThreshold) return "warning";
  return "ok";
};

const warningMessage = (evaluation: UsageLimitMetricEvaluation) => {
  const action = evaluation.status === "exceeded" ? "exceeded" : "is approaching";
  return `${evaluation.metric} ${action} the daily limit (${evaluation.used}/${evaluation.limit}).`;
};

const positiveInteger = (value: unknown) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.floor(number);
};

const normalizedThreshold = (value: unknown) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1) return null;
  return number;
};

const metricOrder = new Map(DEFAULT_DAILY_USAGE_LIMITS.map((policy, index) => [policy.metric, index]));
const knownMetrics = new Set(DEFAULT_DAILY_USAGE_LIMITS.map((policy) => policy.metric));

const readPolicyRecord = async (
  env: Env,
  key: string,
  scope: UsageLimitPolicySource
) => {
  let raw: unknown;
  try {
    raw = await env.DEPLOYMENTS_KV.get(key, "json");
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object") {
    return {
      lookup: { scope, key, found: false, metrics: [] },
      record: null
    };
  }
  const record = raw as Partial<UsageLimitPolicyRecord>;
  if (record.version !== 1 || !record.metrics || typeof record.metrics !== "object") {
    return {
      lookup: { scope, key, found: true, metrics: [] },
      record: null
    };
  }
  return {
    lookup: {
      scope,
      key,
      found: true,
      metrics: Object.keys(record.metrics).filter((metric) => knownMetrics.has(metric))
    },
    record: record as UsageLimitPolicyRecord
  };
};

const applyPolicyRecord = (
  policies: Map<string, UsageLimitPolicy>,
  record: UsageLimitPolicyRecord,
  source: UsageLimitPolicySource
) => {
  for (const [metric, value] of Object.entries(record.metrics)) {
    const current = policies.get(metric);
    if (!current || !knownMetrics.has(metric)) continue;

    const patch = typeof value === "number" ? { dailyUnits: value } : value;
    if (!patch || typeof patch !== "object") continue;

    const dailyUnits = positiveInteger(patch.dailyUnits);
    const warningThreshold = normalizedThreshold(patch.warningThreshold);
    if (dailyUnits === null && warningThreshold === null) continue;

    policies.set(metric, {
      ...current,
      ...(dailyUnits !== null ? { dailyUnits } : {}),
      ...(warningThreshold !== null ? { warningThreshold } : {}),
      source
    });
  }
};

const policySort = (a: UsageLimitPolicy, b: UsageLimitPolicy) =>
  (metricOrder.get(a.metric) ?? Number.MAX_SAFE_INTEGER) -
  (metricOrder.get(b.metric) ?? Number.MAX_SAFE_INTEGER);

export const loadEffectiveUsageLimitPolicies = async (
  env: Env,
  params: {
    environment: string;
    orgSlug: string;
    repoSlug: string;
  }
): Promise<EffectiveUsageLimitPolicies> => {
  const policies = new Map(
    DEFAULT_DAILY_USAGE_LIMITS.map((policy) => [policy.metric, { ...policy }])
  );
  const keys: Array<{ scope: Exclude<UsageLimitPolicySource, "default">; key: string }> = [
    {
      scope: "owner",
      key: usageLimitPolicyKey({
        scope: "owner",
        orgSlug: params.orgSlug
      })
    },
    {
      scope: "owner_environment",
      key: usageLimitPolicyKey({
        scope: "owner_environment",
        environment: params.environment,
        orgSlug: params.orgSlug
      })
    },
    {
      scope: "repo",
      key: usageLimitPolicyKey({
        scope: "repo",
        orgSlug: params.orgSlug,
        repoSlug: params.repoSlug
      })
    },
    {
      scope: "repo_environment",
      key: usageLimitPolicyKey({
        scope: "repo_environment",
        environment: params.environment,
        orgSlug: params.orgSlug,
        repoSlug: params.repoSlug
      })
    }
  ];
  const lookups: UsageLimitPolicyLookup[] = [
    {
      scope: "default",
      key: null,
      found: true,
      metrics: DEFAULT_DAILY_USAGE_LIMITS.map((policy) => policy.metric)
    }
  ];

  for (const { scope, key } of keys) {
    const { lookup, record } = await readPolicyRecord(env, key, scope);
    lookups.push(lookup);
    if (record) applyPolicyRecord(policies, record, scope);
  }

  const ordered = [...policies.values()].sort(policySort);
  return {
    version: 1,
    period: "daily",
    mode: "enforce",
    environment: params.environment,
    orgSlug: params.orgSlug,
    repoSlug: params.repoSlug,
    policies: ordered,
    policy: Object.fromEntries(ordered.map((policy) => [policy.metric, policy])),
    lookups
  };
};

export const evaluateUsageLimits = (
  usage: Pick<UsageDailyRollup, "metrics">,
  policies = DEFAULT_DAILY_USAGE_LIMITS
): UsageLimitEvaluation => {
  const metrics: Record<string, UsageLimitMetricEvaluation> = {};
  const warnings: UsageLimitWarning[] = [];

  for (const policy of policies) {
    const used = usage.metrics[policy.metric]?.units ?? 0;
    const limit = policy.dailyUnits;
    const evaluation: UsageLimitMetricEvaluation = {
      metric: policy.metric,
      used,
      limit,
      remaining: Math.max(0, limit - used),
      usageRatio: ratio(used, limit),
      status: statusFor({
        used,
        limit,
        warningThreshold: policy.warningThreshold
      }),
      source: policy.source
    };
    metrics[policy.metric] = evaluation;

    if (evaluation.status !== "ok") {
      warnings.push({
        metric: evaluation.metric,
        status: evaluation.status,
        used: evaluation.used,
        limit: evaluation.limit,
        remaining: evaluation.remaining,
        message: warningMessage(evaluation)
      });
    }
  }

  return {
    version: 1,
    period: "daily",
    mode: "enforce",
    metrics,
    warnings
  };
};

export const checkUsageLimit = async (
  env: Env,
  params: {
    metric: string;
    environment: string;
    orgSlug: string;
    repoSlug: string;
    units?: number;
    at?: Date;
  }
): Promise<UsageLimitCheck | null> => {
  const metric = params.metric.trim().toLowerCase();
  const requestedUnits = positiveInteger(params.units ?? 1) ?? 1;
  const at = params.at ?? new Date();
  const date = usageDate(at);
  const policies = await loadEffectiveUsageLimitPolicies(env, {
    environment: params.environment,
    orgSlug: params.orgSlug,
    repoSlug: params.repoSlug
  });
  const policy = policies.policy[metric];
  if (!policy) return null;

  const rollup = await loadUsageDailyRollup(env, {
    date,
    environment: params.environment,
    orgSlug: params.orgSlug,
    repoSlug: params.repoSlug
  });
  const used = rollup?.metrics[metric]?.units ?? 0;
  const projectedUnits = used + requestedUnits;
  const status = statusFor({
    used,
    limit: policy.dailyUnits,
    warningThreshold: policy.warningThreshold
  });
  const projectedStatus = statusFor({
    used: projectedUnits,
    limit: policy.dailyUnits,
    warningThreshold: policy.warningThreshold
  });

  return {
    version: 1,
    mode: "enforce",
    enforcement: "hard",
    metric,
    date,
    environment: params.environment,
    orgSlug: params.orgSlug,
    repoSlug: params.repoSlug,
    used,
    requestedUnits,
    projectedUnits,
    limit: policy.dailyUnits,
    remaining: Math.max(0, policy.dailyUnits - used),
    usageRatio: ratio(used, policy.dailyUnits),
    projectedUsageRatio: ratio(projectedUnits, policy.dailyUnits),
    status,
    projectedStatus,
    wouldBlock: projectedUnits > policy.dailyUnits,
    source: policy.source,
    policy
  };
};
