import type { Env } from "./env";
import { json } from "./http";
import { sanitizeScriptPart } from "./names";

const DEFAULT_ACTIVE_WORKFLOW_LIMIT = 50;
const DEFAULT_ACTIVE_WORKFLOW_TTL_SECONDS = 24 * 60 * 60;

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const activeLimit = (env: Env) =>
  positiveInteger(env.W7S_WORKFLOW_ACTIVE_LIMIT, DEFAULT_ACTIVE_WORKFLOW_LIMIT);

const activeTtlSeconds = (env: Env) =>
  positiveInteger(env.W7S_WORKFLOW_ACTIVE_TTL_SECONDS, DEFAULT_ACTIVE_WORKFLOW_TTL_SECONDS);

const activeWorkflowPrefix = (params: {
  environment: string;
  orgSlug: string;
  repoSlug: string;
}) =>
  [
    "workflow_active:v1",
    sanitizeScriptPart(params.environment),
    sanitizeScriptPart(params.orgSlug),
    sanitizeScriptPart(params.repoSlug)
  ].join(":");

export const activeWorkflowKey = (params: {
  environment: string;
  orgSlug: string;
  repoSlug: string;
  workflow: string;
  instanceId: string;
}) =>
  [
    activeWorkflowPrefix(params),
    sanitizeScriptPart(params.workflow),
    sanitizeScriptPart(params.instanceId)
  ].join(":");

export const countActiveWorkflows = async (env: Env, params: {
  environment: string;
  orgSlug: string;
  repoSlug: string;
}) => {
  let count = 0;
  let cursor: string | undefined;
  do {
    const listed = await env.DEPLOYMENTS_KV.list({
      prefix: `${activeWorkflowPrefix(params)}:`,
      cursor,
      limit: 1000
    });
    count += listed.keys.length;
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return count;
};

export const enforceActiveWorkflowLimit = async (env: Env, params: {
  environment: string;
  orgSlug: string;
  repoSlug: string;
}) => {
  const active = await countActiveWorkflows(env, params);
  const limit = activeLimit(env);
  if (active < limit) return null;
  return json(
    {
      status: "error",
      error: `Active workflow limit exceeded (${active}/${limit}).`,
      details: {
        activeWorkflowLimit: {
          active,
          limit,
          environment: params.environment,
          orgSlug: params.orgSlug,
          repoSlug: params.repoSlug
        }
      }
    },
    429,
    {
      "retry-after": "60"
    }
  );
};

export const trackActiveWorkflow = async (env: Env, params: {
  environment: string;
  orgSlug: string;
  repoSlug: string;
  workflow: string;
  instanceId: string;
  createdAt: string;
}) => {
  await env.DEPLOYMENTS_KV.put(
    activeWorkflowKey(params),
    JSON.stringify({
      version: 1,
      ...params
    }),
    {
      expirationTtl: activeTtlSeconds(env)
    }
  );
};

export const clearActiveWorkflow = async (env: Env, params: {
  environment: string;
  orgSlug: string;
  repoSlug: string;
  workflow: string;
  instanceId: string;
}) => {
  await env.DEPLOYMENTS_KV.delete(activeWorkflowKey(params));
};
