import type { Context } from "hono";
import { responseOutcome, writeAnalyticsEvent } from "../analytics";
import { hashBindingToken } from "../deploy/tokens";
import type { Env } from "../env";
import { jsonError, jsonSuccess, parseBearerToken } from "../http";
import { requireSlug } from "../names";
import { loadDeploymentRecord } from "../storage/deployments";
import { recordUsageEvent } from "../usage";
import { enforceUsageLimit } from "../usageEnforcement";
import { enforceAppNotSuspended } from "../appLimits";

type HonoContext = Context<{ Bindings: Env }>;

const W7S_MODEL_PREFIX = "@w7s/";
const PROVIDER_MODEL_PREFIX = "@cf/";
const DEFAULT_AI_MODEL = "@w7s/meta/llama-3.1-8b-instruct-fp8";
const DEFAULT_MAX_AI_REQUEST_BYTES = 32 * 1024;

class AiRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const maxAiRequestBytes = (env: Env) =>
  positiveInteger(env.W7S_AI_MAX_REQUEST_BYTES, DEFAULT_MAX_AI_REQUEST_BYTES);

const parseCaller = (c: HonoContext) => {
  const caller = c.req.header("x-w7s-ai-caller")?.trim() ?? "";
  const [owner, repo, extra] = caller.split("/");
  if (!owner || !repo || extra) {
    throw new Error("x-w7s-ai-caller must be in owner/repo form.");
  }
  return {
    orgSlug: requireSlug(owner, "AI caller owner"),
    repoSlug: requireSlug(repo, "AI caller repo"),
    environment: requireSlug(c.req.header("x-w7s-ai-environment") ?? "", "AI caller environment")
  };
};

const publicModelName = (model: string) =>
  model.startsWith(PROVIDER_MODEL_PREFIX)
    ? `${W7S_MODEL_PREFIX}${model.slice(PROVIDER_MODEL_PREFIX.length)}`
    : model;

const providerModelName = (model: string) =>
  model.startsWith(W7S_MODEL_PREFIX)
    ? `${PROVIDER_MODEL_PREFIX}${model.slice(W7S_MODEL_PREFIX.length)}`
    : model;

const allowedModels = (env: Env) => {
  const configured = env.W7S_AI_ALLOWED_MODELS?.trim();
  if (!configured) return [publicModelName(env.W7S_AI_DEFAULT_MODEL?.trim() || DEFAULT_AI_MODEL)];
  return configured
    .split(",")
    .map((entry) => entry.trim())
    .map(publicModelName)
    .filter(Boolean);
};

const defaultModel = (env: Env) =>
  publicModelName(env.W7S_AI_DEFAULT_MODEL?.trim() || allowedModels(env)[0] || DEFAULT_AI_MODEL);

const readAiRunRequest = async (request: Request, env: Env) => {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxAiRequestBytes(env)) {
    throw new AiRequestError(`AI request body exceeds ${maxAiRequestBytes(env)} bytes.`, 413);
  }
  let parsed: unknown;
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new AiRequestError("AI request body must be valid JSON.");
  }
  const record = isRecord(parsed) ? parsed : {};
  const modelValue = record.model;
  if (modelValue !== undefined && typeof modelValue !== "string") {
    throw new AiRequestError("model must be a string.");
  }
  const model = publicModelName(modelValue?.trim() || defaultModel(env));
  const input = record.input ?? record.inputs;
  if (!isRecord(input)) {
    throw new AiRequestError("input must be a JSON object.");
  }
  const options = record.options;
  if (options !== undefined && !isRecord(options)) {
    throw new AiRequestError("options must be a JSON object.");
  }
  if (input.stream === true) {
    throw new AiRequestError("Streaming AI responses are not supported through W7S_AI yet.");
  }
  if (options?.returnRawResponse || options?.websocket || options?.queueRequest) {
    throw new AiRequestError("Raw, WebSocket, and batch AI responses are not supported through W7S_AI yet.");
  }
  return {
    model,
    input,
    options: options ?? {}
  };
};

const writeAiUsage = async (params: {
  env: Env;
  caller: ReturnType<typeof parseCaller>;
  model: string;
  status: number;
  durationMs: number;
}) => {
  const repository = `${params.caller.orgSlug}/${params.caller.repoSlug}`;
  const outcome = responseOutcome(params.status);
  writeAnalyticsEvent(params.env, {
    event: "ai_run",
    repository,
    environment: params.caller.environment,
    orgSlug: params.caller.orgSlug,
    repoSlug: params.caller.repoSlug,
    outcome,
    source: "w7s_ai",
    target: params.model,
    method: "POST",
    status: params.status,
    durationMs: params.durationMs
  });
  await recordUsageEvent(params.env, {
    metric: "ai.run",
    repository,
    environment: params.caller.environment,
    orgSlug: params.caller.orgSlug,
    repoSlug: params.caller.repoSlug,
    outcome,
    count: 1,
    units: 1
  });
};

export const handleAiRun = async (c: HonoContext) => {
  const startedAt = Date.now();
  const token = parseBearerToken(c.req.raw);
  if (!token) return jsonError("Missing AI bearer token.", 401);

  let caller: ReturnType<typeof parseCaller>;
  let aiRequest: Awaited<ReturnType<typeof readAiRunRequest>>;
  try {
    caller = parseCaller(c);
    aiRequest = await readAiRunRequest(c.req.raw, c.env);
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : String(error),
      error instanceof AiRequestError ? error.status : 400
    );
  }

  const deployment = await loadDeploymentRecord(
    c.env,
    caller.environment,
    caller.orgSlug,
    caller.repoSlug
  );
  if (!deployment?.ai?.tokenHash) {
    return jsonError("AI is not enabled for this deployment. Declare bindings.ai in w7s.json and redeploy.", 401);
  }
  if (await hashBindingToken(token) !== deployment.ai.tokenHash) {
    return jsonError("Invalid AI bearer token.", 401);
  }
  if (!c.env.AI) {
    return jsonError("W7S AI is not configured for this core deployment.", 503);
  }

  const allowed = allowedModels(c.env);
  if (allowed.length > 0 && !allowed.includes(aiRequest.model)) {
    return jsonError("AI model is not allowed for this W7S deployment.", 400, {
      model: aiRequest.model,
      allowedModels: allowed
    });
  }

  const suspended = await enforceAppNotSuspended(c.env, {
    environment: caller.environment,
    orgSlug: caller.orgSlug,
    repoSlug: caller.repoSlug,
    request: c.req.raw
  });
  if (suspended) return suspended;

  const limitResponse = await enforceUsageLimit(c.env, {
    metric: "ai.run",
    environment: caller.environment,
    orgSlug: caller.orgSlug,
    repoSlug: caller.repoSlug,
    units: 1
  });
  if (limitResponse) return limitResponse;

  try {
    const result = await c.env.AI.run(
      providerModelName(aiRequest.model),
      aiRequest.input,
      aiRequest.options as AiOptions
    );
    const response = jsonSuccess({
      model: aiRequest.model,
      result
    });
    await writeAiUsage({
      env: c.env,
      caller,
      model: aiRequest.model,
      status: response.status,
      durationMs: Date.now() - startedAt
    });
    return response;
  } catch (error) {
    const response = jsonError(
      error instanceof Error ? error.message : "Workers AI request failed.",
      502
    );
    await writeAiUsage({
      env: c.env,
      caller,
      model: aiRequest.model,
      status: response.status,
      durationMs: Date.now() - startedAt
    });
    return response;
  }
};
