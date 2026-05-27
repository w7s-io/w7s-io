import type { Env } from "./env";
import { json } from "./http";
import { sanitizeScriptPart } from "./names";
import type { UsageLimitScope } from "./usageLimits";

export type RateLimitCheck = {
  version: 1;
  mode: "enforce";
  enforcement: "rate";
  metric: string;
  scope: UsageLimitScope;
  environment: string;
  orgSlug: string;
  repoSlug: string;
  windowSeconds: number;
  windowStart: string;
  used: number;
  requestedUnits: number;
  projectedUnits: number;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  wouldBlock: boolean;
};

type BurstLimitPolicy = {
  metric: string;
  scope: UsageLimitScope;
  windowSeconds: number;
  units: number;
};

type RateLimitCounterRead = {
  check: RateLimitCheck;
  key: string;
  projectedUnits: number;
  retryAfterSeconds: number;
};

const BURST_LIMITS: BurstLimitPolicy[] = [
  { metric: "deploy", scope: "repo", windowSeconds: 600, units: 10 },
  { metric: "deploy", scope: "owner", windowSeconds: 600, units: 50 },
  { metric: "deploy", scope: "global", windowSeconds: 600, units: 500 },
  { metric: "runtime.request", scope: "repo", windowSeconds: 60, units: 300 },
  { metric: "runtime.request", scope: "owner", windowSeconds: 60, units: 2_000 },
  { metric: "runtime.request", scope: "global", windowSeconds: 60, units: 10_000 },
  { metric: "rpc.dispatch", scope: "repo", windowSeconds: 60, units: 120 },
  { metric: "rpc.dispatch", scope: "owner", windowSeconds: 60, units: 600 },
  { metric: "rpc.dispatch", scope: "global", windowSeconds: 60, units: 5_000 },
  { metric: "queue.send", scope: "repo", windowSeconds: 60, units: 120 },
  { metric: "queue.send", scope: "owner", windowSeconds: 60, units: 600 },
  { metric: "queue.send", scope: "global", windowSeconds: 60, units: 5_000 },
  { metric: "queue.delivery", scope: "repo", windowSeconds: 60, units: 300 },
  { metric: "queue.delivery", scope: "owner", windowSeconds: 60, units: 1_500 },
  { metric: "queue.delivery", scope: "global", windowSeconds: 60, units: 10_000 },
  { metric: "schedule.delivery", scope: "repo", windowSeconds: 60, units: 120 },
  { metric: "schedule.delivery", scope: "owner", windowSeconds: 60, units: 600 },
  { metric: "schedule.delivery", scope: "global", windowSeconds: 60, units: 5_000 },
  { metric: "workflow.create", scope: "repo", windowSeconds: 60, units: 60 },
  { metric: "workflow.create", scope: "owner", windowSeconds: 60, units: 300 },
  { metric: "workflow.create", scope: "global", windowSeconds: 60, units: 2_000 },
  { metric: "workflow.delivery", scope: "repo", windowSeconds: 60, units: 120 },
  { metric: "workflow.delivery", scope: "owner", windowSeconds: 60, units: 600 },
  { metric: "workflow.delivery", scope: "global", windowSeconds: 60, units: 5_000 },
  { metric: "log.write", scope: "repo", windowSeconds: 60, units: 500 },
  { metric: "log.write", scope: "owner", windowSeconds: 60, units: 2_000 },
  { metric: "log.write", scope: "global", windowSeconds: 60, units: 10_000 }
];

const positiveInteger = (value: number | undefined, fallback: number) =>
  Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;

const windowStartMs = (at: Date, windowSeconds: number) =>
  Math.floor(at.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000;

const scopeParts = (params: {
  scope: UsageLimitScope;
  environment: string;
  orgSlug: string;
  repoSlug: string;
}) => {
  const base = [sanitizeScriptPart(params.environment)];
  if (params.scope === "global") return base;
  base.push(sanitizeScriptPart(params.orgSlug));
  if (params.scope === "repo") base.push(sanitizeScriptPart(params.repoSlug));
  return base;
};

const rateLimitKey = (params: {
  metric: string;
  scope: UsageLimitScope;
  environment: string;
  orgSlug: string;
  repoSlug: string;
  windowSeconds: number;
  windowStart: string;
}) =>
  [
    "usage_rate:v1",
    sanitizeScriptPart(params.windowStart),
    String(params.windowSeconds),
    params.scope,
    sanitizeScriptPart(params.metric),
    ...scopeParts(params)
  ].join(":");

const readCounter = async (env: Env, key: string) => {
  const raw = await env.DEPLOYMENTS_KV.get(key);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
};

const matchingPolicies = (metric: string) =>
  BURST_LIMITS.filter((policy) => policy.metric === metric);

export const checkRateLimit = async (
  env: Env,
  params: {
    metric: string;
    environment: string;
    orgSlug: string;
    repoSlug: string;
    units?: number;
    at?: Date;
  }
) => {
  const metric = params.metric.trim().toLowerCase();
  const policies = matchingPolicies(metric);
  if (policies.length === 0) return null;

  const at = params.at ?? new Date();
  const requestedUnits = positiveInteger(params.units, 1);
  const checks = await Promise.all(
    policies.map(async (policy): Promise<RateLimitCounterRead> => {
      const startMs = windowStartMs(at, policy.windowSeconds);
      const windowStart = new Date(startMs).toISOString();
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((startMs + policy.windowSeconds * 1000 - at.getTime()) / 1000)
      );
      const key = rateLimitKey({
        metric,
        scope: policy.scope,
        environment: params.environment,
        orgSlug: params.orgSlug,
        repoSlug: params.repoSlug,
        windowSeconds: policy.windowSeconds,
        windowStart
      });
      const used = await readCounter(env, key);
      const projectedUnits = used + requestedUnits;
      return {
        key,
        projectedUnits,
        retryAfterSeconds,
        check: {
          version: 1,
          mode: "enforce",
          enforcement: "rate",
          metric,
          scope: policy.scope,
          environment: params.environment,
          orgSlug: params.orgSlug,
          repoSlug: params.repoSlug,
          windowSeconds: policy.windowSeconds,
          windowStart,
          used,
          requestedUnits,
          projectedUnits,
          limit: policy.units,
          remaining: Math.max(0, policy.units - used),
          retryAfterSeconds,
          wouldBlock: projectedUnits > policy.units
        }
      };
    })
  );
  const blocked = checks.find(({ check }) => check.wouldBlock)?.check ?? null;
  if (blocked) return blocked;
  await Promise.all(
    checks.map(({ key, projectedUnits, retryAfterSeconds, check }) =>
      env.DEPLOYMENTS_KV.put(key, String(projectedUnits), {
        expirationTtl: Math.max(check.windowSeconds * 2, retryAfterSeconds)
      })
    )
  );
  return checks[0]?.check ?? null;
};

export const rateLimitExceededMessage = (check: RateLimitCheck) =>
  `Short-window usage limit exceeded for ${check.metric} at ${check.scope} scope (${check.used}/${check.limit} used, requested ${check.requestedUnits}).`;

export const rateLimitExceededResponse = (check: RateLimitCheck) =>
  json(
    {
      status: "error",
      error: rateLimitExceededMessage(check),
      details: {
        rateLimit: check
      }
    },
    429,
    {
      "retry-after": String(check.retryAfterSeconds)
    }
  );
