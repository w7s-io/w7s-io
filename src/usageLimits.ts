import type { UsageDailyRollup } from "./usage";

export type UsageLimitStatus = "ok" | "warning" | "exceeded";

export type UsageLimitPolicy = {
  metric: string;
  dailyUnits: number;
  warningThreshold: number;
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
};

export type UsageLimitEvaluation = {
  version: 1;
  period: "daily";
  mode: "warn";
  metrics: Record<string, UsageLimitMetricEvaluation>;
  warnings: UsageLimitWarning[];
};

export const DEFAULT_DAILY_USAGE_LIMITS: UsageLimitPolicy[] = [
  { metric: "deploy", dailyUnits: 100, warningThreshold: 0.8 },
  { metric: "rpc.dispatch", dailyUnits: 100_000, warningThreshold: 0.8 },
  { metric: "queue.send", dailyUnits: 100_000, warningThreshold: 0.8 },
  { metric: "queue.delivery", dailyUnits: 100_000, warningThreshold: 0.8 },
  { metric: "schedule.delivery", dailyUnits: 10_000, warningThreshold: 0.8 },
  { metric: "workflow.create", dailyUnits: 10_000, warningThreshold: 0.8 },
  { metric: "workflow.delivery", dailyUnits: 10_000, warningThreshold: 0.8 }
];

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
  return `${evaluation.metric} ${action} the daily soft limit (${evaluation.used}/${evaluation.limit}).`;
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
      })
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
    mode: "warn",
    metrics,
    warnings
  };
};
