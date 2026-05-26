import type { Env } from "./env";
import { json } from "./http";
import { checkUsageLimit, type UsageLimitCheck } from "./usageLimits";

const secondsUntilNextUtcDay = (now = new Date()) => {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
};

export const usageLimitExceededMessage = (check: UsageLimitCheck) =>
  `Daily usage limit exceeded for ${check.metric} (${check.used}/${check.limit} used, requested ${check.requestedUnits}).`;

export const usageLimitExceededResponse = (check: UsageLimitCheck) =>
  json(
    {
      status: "error",
      error: usageLimitExceededMessage(check),
      details: {
        usageLimit: check
      }
    },
    429,
    {
      "retry-after": String(secondsUntilNextUtcDay())
    }
  );

export const checkBlockedUsageLimit = async (
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
  const check = await checkUsageLimit(env, params);
  return check?.wouldBlock ? check : null;
};

export const enforceUsageLimit = async (
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
  const blocked = await checkBlockedUsageLimit(env, params);
  return blocked ? usageLimitExceededResponse(blocked) : null;
};
