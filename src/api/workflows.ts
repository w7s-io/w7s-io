import type { Context } from "hono";
import { writeAnalyticsEvent } from "../analytics";
import { hashBindingToken } from "../deploy/tokens";
import type { Env, W7SWorkflowPayload } from "../env";
import { jsonError, jsonSuccess, parseBearerToken } from "../http";
import { requireSlug, sanitizeScriptPart } from "../names";
import { loadDeploymentRecord } from "../storage/deployments";
import { recordUsageEvent } from "../usage";
import { enforceUsageLimit } from "../usageEnforcement";
import { enforceAppNotSuspended } from "../appLimits";
import { enforceActiveWorkflowLimit, trackActiveWorkflow } from "../workflowLimits";

type HonoContext = Context<{ Bindings: Env }>;

const WORKFLOW_PREFIX = "/api/v1/workflows/";
const MAX_INSTANCE_ID_LENGTH = 100;
const DEFAULT_MAX_WORKFLOW_PAYLOAD_BYTES = 64 * 1024;

class WorkflowRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const splitPath = (path: string) =>
  path.split("/").map((segment) => segment.trim()).filter(Boolean);

const shortHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0").slice(0, 7);
};

const parseTarget = (request: Request) => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(WORKFLOW_PREFIX)) {
    throw new Error("Invalid workflow route.");
  }
  const rawSegments = splitPath(url.pathname.slice(WORKFLOW_PREFIX.length));
  if (rawSegments.length < 3) {
    throw new Error("Workflow target must be /api/v1/workflows/<owner>/<repo>/<workflow>.");
  }
  return {
    orgSlug: requireSlug(decodeURIComponent(rawSegments[0] ?? ""), "workflow target owner"),
    repoSlug: requireSlug(decodeURIComponent(rawSegments[1] ?? ""), "workflow target repo"),
    workflow: requireSlug(decodeURIComponent(rawSegments[2] ?? ""), "workflow name"),
    instanceId:
      rawSegments.length > 3
        ? requireSlug(decodeURIComponent(rawSegments.slice(3).join("-")), "workflow instance id")
        : null
  };
};

const parseCaller = (c: HonoContext) => {
  const caller = c.req.header("x-w7s-workflow-caller")?.trim() ?? "";
  const [owner, repo, extra] = caller.split("/");
  if (!owner || !repo || extra) {
    throw new Error("x-w7s-workflow-caller must be in owner/repo form.");
  }
  return {
    orgSlug: requireSlug(owner, "workflow caller owner"),
    repoSlug: requireSlug(repo, "workflow caller repo"),
    environment: requireSlug(c.req.header("x-w7s-workflow-environment") ?? "", "workflow caller environment")
  };
};

const isAuthorizedCaller = (params: {
  callerOrg: string;
  callerRepo: string;
  targetOrg: string;
  targetAllow: string[];
}) => {
  if (params.callerOrg === params.targetOrg) return true;
  const callerRepository = `${params.callerOrg}/${params.callerRepo}`;
  return params.targetAllow.includes(params.callerOrg) || params.targetAllow.includes(callerRepository);
};

const maxWorkflowPayloadBytes = (env: Env) => {
  const parsed = Number(env.W7S_WORKFLOW_MAX_PAYLOAD_BYTES);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_MAX_WORKFLOW_PAYLOAD_BYTES;
};

const jsonByteLength = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const readJsonBody = async (request: Request, env: Env) => {
  if (!request.body) return null;
  const text = await request.text();
  if (!text.trim()) return null;
  if (new TextEncoder().encode(text).byteLength > maxWorkflowPayloadBytes(env)) {
    throw new WorkflowRequestError(`Workflow payload exceeds ${maxWorkflowPayloadBytes(env)} bytes.`, 413);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WorkflowRequestError("Workflow payload must be valid JSON.");
  }
};

const buildInstanceId = (params: {
  environment: string;
  orgSlug: string;
  repoSlug: string;
  workflow: string;
  requestedId: string | null;
}) => {
  const generated = params.requestedId ?? crypto.randomUUID();
  const base = [
    params.environment,
    params.orgSlug,
    params.repoSlug,
    params.workflow,
    generated
  ].join(":");
  const suffix = sanitizeScriptPart(generated).slice(0, 40) || shortHash(base);
  const prefix = [
    sanitizeScriptPart(params.environment),
    sanitizeScriptPart(params.orgSlug),
    sanitizeScriptPart(params.repoSlug),
    sanitizeScriptPart(params.workflow)
  ].join("-");
  const compact = `${prefix}-${suffix}`;
  if (compact.length <= MAX_INSTANCE_ID_LENGTH) return compact;
  return `${prefix.slice(0, 58).replace(/-+$/g, "")}-${shortHash(base)}-${suffix}`.slice(0, MAX_INSTANCE_ID_LENGTH);
};

const requireWorkflowBinding = (env: Env) => {
  if (!env.W7S_WORKFLOWS) {
    throw new Error("W7S Workflows are not configured for this core deployment.");
  }
  return env.W7S_WORKFLOWS;
};

const requireAuthorizedContext = async (c: HonoContext) => {
  const token = parseBearerToken(c.req.raw);
  if (!token) throw new Response(JSON.stringify({ status: "error", error: "Missing workflow bearer token." }), { status: 401 });

  let caller: ReturnType<typeof parseCaller>;
  let target: ReturnType<typeof parseTarget>;
  try {
    caller = parseCaller(c);
    target = parseTarget(c.req.raw);
  } catch (error) {
    throw new Response(JSON.stringify({ status: "error", error: error instanceof Error ? error.message : String(error) }), { status: 400 });
  }

  const callerDeployment = await loadDeploymentRecord(
    c.env,
    caller.environment,
    caller.orgSlug,
    caller.repoSlug
  );
  if (!callerDeployment?.workflow?.tokenHash) {
    throw new Response(JSON.stringify({ status: "error", error: "Workflows are not enabled for the caller deployment. Redeploy the caller app." }), { status: 401 });
  }
  if (await hashBindingToken(token) !== callerDeployment.workflow.tokenHash) {
    throw new Response(JSON.stringify({ status: "error", error: "Invalid workflow bearer token." }), { status: 401 });
  }

  const targetDeployment = await loadDeploymentRecord(
    c.env,
    caller.environment,
    target.orgSlug,
    target.repoSlug
  );
  if (!targetDeployment) {
    throw new Response(JSON.stringify({ status: "error", error: "Workflow target deployment was not found." }), { status: 404 });
  }
  if (!targetDeployment.targets.worker) {
    throw new Response(JSON.stringify({ status: "error", error: "Workflow target deployment has no backend." }), { status: 404 });
  }
  const workflow = targetDeployment.workflow?.workflows.find((entry) => entry.name === target.workflow);
  if (!workflow) {
    throw new Response(JSON.stringify({ status: "error", error: "Workflow target was not declared by the deployment." }), { status: 404 });
  }
  if (
    !isAuthorizedCaller({
      callerOrg: caller.orgSlug,
      callerRepo: caller.repoSlug,
      targetOrg: target.orgSlug,
      targetAllow: targetDeployment.workflow?.allow ?? []
    })
  ) {
    throw new Response(JSON.stringify({ status: "error", error: "Workflow caller is not authorized for this target." }), { status: 403 });
  }

  return {
    caller,
    target,
    workflow
  };
};

const responseFromThrown = (error: unknown) => {
  if (error instanceof Response) {
    if (!error.headers.has("content-type")) {
      error.headers.set("content-type", "application/json; charset=utf-8");
    }
    return error;
  }
  return jsonError(error instanceof Error ? error.message : String(error), 500);
};

export const handleWorkflowCreate = async (c: HonoContext) => {
  const startedAt = Date.now();
  try {
    const workflows = requireWorkflowBinding(c.env);
    const context = await requireAuthorizedContext(c);
    const payload = await readJsonBody(c.req.raw, c.env);
    const callerSuspended = await enforceAppNotSuspended(c.env, {
      environment: context.caller.environment,
      orgSlug: context.caller.orgSlug,
      repoSlug: context.caller.repoSlug,
      request: c.req.raw
    });
    if (callerSuspended) return callerSuspended;
    const targetSuspended = await enforceAppNotSuspended(c.env, {
      environment: context.caller.environment,
      orgSlug: context.target.orgSlug,
      repoSlug: context.target.repoSlug,
      request: c.req.raw
    });
    if (targetSuspended) return targetSuspended;
    const limitResponse = await enforceUsageLimit(c.env, {
      metric: "workflow.create",
      environment: context.caller.environment,
      orgSlug: context.caller.orgSlug,
      repoSlug: context.caller.repoSlug,
      units: 1
    });
    if (limitResponse) return limitResponse;
    const activeLimitResponse = await enforceActiveWorkflowLimit(c.env, {
      environment: context.caller.environment,
      orgSlug: context.target.orgSlug,
      repoSlug: context.target.repoSlug
    });
    if (activeLimitResponse) return activeLimitResponse;
    const requestedId = c.req.header("x-w7s-workflow-instance-id")?.trim() || null;
    const createdAt = new Date().toISOString();
    const instanceId = buildInstanceId({
      environment: context.caller.environment,
      orgSlug: context.target.orgSlug,
      repoSlug: context.target.repoSlug,
      workflow: context.target.workflow,
      requestedId
    });
    const instancePayload: W7SWorkflowPayload = {
      version: 1,
      createdAt,
      payload,
      caller: {
        orgSlug: context.caller.orgSlug,
        repoSlug: context.caller.repoSlug,
        repository: `${context.caller.orgSlug}/${context.caller.repoSlug}`,
        environment: context.caller.environment
      },
      target: {
        orgSlug: context.target.orgSlug,
        repoSlug: context.target.repoSlug,
        repository: `${context.target.orgSlug}/${context.target.repoSlug}`,
        environment: context.caller.environment,
        workflow: context.target.workflow,
        path: context.workflow.path
      }
    };
    if (jsonByteLength(instancePayload) > maxWorkflowPayloadBytes(c.env)) {
      return jsonError(`Workflow instance payload exceeds ${maxWorkflowPayloadBytes(c.env)} bytes.`, 413);
    }
    const instance = await workflows.create({
      id: instanceId,
      params: instancePayload
    });
    await trackActiveWorkflow(c.env, {
      environment: context.caller.environment,
      orgSlug: context.target.orgSlug,
      repoSlug: context.target.repoSlug,
      workflow: context.target.workflow,
      instanceId: instance.id,
      createdAt
    });
    const status = await instance.status();

    writeAnalyticsEvent(c.env, {
      event: "workflow_create",
      repository: instancePayload.caller.repository,
      environment: context.caller.environment,
      orgSlug: context.caller.orgSlug,
      repoSlug: context.caller.repoSlug,
      outcome: "success",
      source: context.target.workflow,
      target: instancePayload.target.repository,
      method: c.req.method,
      status: 200,
      durationMs: Date.now() - startedAt,
      count: 1
    });
    await recordUsageEvent(c.env, {
      metric: "workflow.create",
      repository: instancePayload.caller.repository,
      environment: context.caller.environment,
      orgSlug: context.caller.orgSlug,
      repoSlug: context.caller.repoSlug,
      outcome: "success",
      count: 1,
      units: 1
    });

    return jsonSuccess({
      workflow: {
        owner: context.target.orgSlug,
        repo: context.target.repoSlug,
        name: context.target.workflow
      },
      instance: {
        id: instance.id,
        status
      },
      createdAt
    });
  } catch (error) {
    if (error instanceof WorkflowRequestError) {
      return jsonError(error.message, error.status);
    }
    return responseFromThrown(error);
  }
};

export const handleWorkflowStatus = async (c: HonoContext) => {
  try {
    const workflows = requireWorkflowBinding(c.env);
    const context = await requireAuthorizedContext(c);
    if (!context.target.instanceId) {
      return jsonError("Workflow instance id is required.", 400);
    }
    const instance = await workflows.get(context.target.instanceId);
    return jsonSuccess({
      workflow: {
        owner: context.target.orgSlug,
        repo: context.target.repoSlug,
        name: context.target.workflow
      },
      instance: {
        id: instance.id,
        status: await instance.status()
      }
    });
  } catch (error) {
    return responseFromThrown(error);
  }
};
