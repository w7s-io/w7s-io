import type { Env } from "./env";
import { json } from "./http";
import {
  checkRateLimit,
  rateLimitExceededMessage,
  rateLimitExceededResponse,
  type RateLimitCheck
} from "./rateLimits";
import { checkUsageLimit, type UsageLimitCheck } from "./usageLimits";

const secondsUntilNextUtcDay = (now = new Date()) => {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
};

export const usageLimitExceededMessage = (check: UsageLimitCheck) =>
  `Daily usage limit exceeded for ${check.metric} at ${check.scope} scope (${check.used}/${check.limit} used, requested ${check.requestedUnits}).`;

export const costGuardExceededMessage = (check: UsageLimitCheck | RateLimitCheck) =>
  check.enforcement === "rate"
    ? rateLimitExceededMessage(check)
    : usageLimitExceededMessage(check);

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
  const rateCheck = await checkRateLimit(env, params);
  if (rateCheck?.wouldBlock) return rateCheck;
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
  const rateCheck = await checkRateLimit(env, params);
  if (rateCheck?.wouldBlock) return rateLimitExceededResponse(rateCheck);
  const blocked = await checkUsageLimit(env, params);
  return blocked?.wouldBlock ? usageLimitExceededResponse(blocked) : null;
};
