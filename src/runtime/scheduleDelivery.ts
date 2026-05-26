import { responseOutcome, writeAnalyticsEvent } from "../analytics";
import { cleanupPlatformState } from "../cleanup";
import { collectHourlyCloudflareUsage } from "../cloudflareUsage";
import { isCronExpressionDue, scheduledMinuteIso } from "../cron";
import type { Env } from "../env";
import { recordUsageEvent } from "../usage";
import { checkBlockedUsageLimit, costGuardExceededMessage } from "../usageEnforcement";
import {
  listScheduleMappings,
  loadDeploymentRecord,
  scheduleLockKey,
  type ScheduleMapping
} from "../storage/deployments";
import { dispatchWorker } from "./dispatch";

const LOCK_TTL_SECONDS = 3600;

const acquireScheduleLock = async (
  env: Env,
  mapping: ScheduleMapping,
  scheduledMinute: string
) => {
  const key = scheduleLockKey(mapping.id, scheduledMinute);
  const existing = await env.DEPLOYMENTS_KV.get(key);
  if (existing) return false;
  await env.DEPLOYMENTS_KV.put(key, "1", {
    expirationTtl: LOCK_TTL_SECONDS
  });
  return true;
};

const dispatchSchedule = async (params: {
  env: Env;
  mapping: ScheduleMapping;
  scheduledMinute: string;
}) => {
  const startedAt = Date.now();
  const deployment = await loadDeploymentRecord(
    params.env,
    params.mapping.environment,
    params.mapping.orgSlug,
    params.mapping.repoSlug
  );
  const workerTarget = deployment?.targets.worker;
  if (!deployment || !workerTarget) {
    throw new Error(`W7S schedule target deployment was not found for ${params.mapping.repository}.`);
  }

  const blocked = await checkBlockedUsageLimit(params.env, {
    metric: "schedule.delivery",
    environment: params.mapping.environment,
    orgSlug: params.mapping.orgSlug,
    repoSlug: params.mapping.repoSlug,
    units: 1
  });
  if (blocked) {
    writeAnalyticsEvent(params.env, {
      event: "schedule_delivery",
      repository: params.mapping.repository,
      environment: params.mapping.environment,
      orgSlug: params.mapping.orgSlug,
      repoSlug: params.mapping.repoSlug,
      outcome: "error",
      source: params.mapping.cron,
      method: "POST",
      status: 429,
      durationMs: Date.now() - startedAt,
      count: 1
    });
    console.warn(costGuardExceededMessage(blocked));
    return;
  }

  const request = new Request(`https://${params.mapping.orgSlug}.w7s.internal${params.mapping.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      schedule: params.mapping.cron,
      scheduledTime: params.scheduledMinute,
      repository: params.mapping.repository,
      environment: params.mapping.environment
    })
  });

  const response = await dispatchWorker({
    env: params.env,
    request,
    repoPath: params.mapping.path,
    repoSlug: params.mapping.repoSlug,
    orgSlug: params.mapping.orgSlug,
    scriptName: workerTarget.scriptName,
    urlHost: `${params.mapping.orgSlug}.w7s.internal`,
    headers: {
      "x-w7s-schedule": "1",
      "x-w7s-schedule-cron": params.mapping.cron,
      "x-w7s-schedule-time": params.scheduledMinute
    }
  });

  writeAnalyticsEvent(params.env, {
    event: "schedule_delivery",
    repository: params.mapping.repository,
    environment: params.mapping.environment,
    orgSlug: params.mapping.orgSlug,
    repoSlug: params.mapping.repoSlug,
    outcome: responseOutcome(response.status),
    source: params.mapping.cron,
    method: "POST",
    status: response.status,
    durationMs: Date.now() - startedAt,
    count: 1
  });
  await recordUsageEvent(params.env, {
    metric: "schedule.delivery",
    repository: params.mapping.repository,
    environment: params.mapping.environment,
    orgSlug: params.mapping.orgSlug,
    repoSlug: params.mapping.repoSlug,
    outcome: responseOutcome(response.status),
    count: 1,
    units: 1
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`W7S schedule consumer failed with HTTP ${response.status}.`);
  }
};

export const dispatchDueSchedules = async (
  env: Env,
  scheduledTime: Date
) => {
  const scheduledMinute = scheduledMinuteIso(scheduledTime);
  const mappings = await listScheduleMappings(env);
  const dueMappings = mappings.filter((mapping) =>
    isCronExpressionDue(mapping.cron, scheduledTime)
  );
  const results = await Promise.allSettled(
    dueMappings.map(async (mapping) => {
      if (!(await acquireScheduleLock(env, mapping, scheduledMinute))) return;
      await dispatchSchedule({
        env,
        mapping,
        scheduledMinute
      });
    })
  );
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) {
    throw new Error(`W7S scheduled dispatch failed for ${failures.length} schedule(s).`);
  }
};

export const handleScheduled = (
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext
) => {
  const scheduledTime = new Date(controller.scheduledTime);
  ctx.waitUntil(dispatchDueSchedules(env, scheduledTime));
  ctx.waitUntil(collectHourlyCloudflareUsage(env, scheduledTime));
  ctx.waitUntil(cleanupPlatformState(env, scheduledTime));
};
