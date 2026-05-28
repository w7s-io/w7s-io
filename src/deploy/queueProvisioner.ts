import type { Env } from "../env";
import { sanitizeScriptPart } from "../names";
import {
  loadManagedResourceRecord,
  storeManagedResourceRecord,
  type DeploymentQueue,
  type ManagedResourceRecord
} from "../storage/deployments";
import type { AppManifest, QueueDeclaration } from "./appManifest";
import {
  buildCloudflareHeaders,
  parseCloudflareEnvelope,
  requireCloudflareCredentials
} from "./cloudflareApi";

type CloudflareCredentials = ReturnType<typeof requireCloudflareCredentials>;

type QueueRecord = {
  queue_id?: string;
  queue_name?: string;
};

type QueueConsumer = {
  consumer_id?: string;
  script_name?: string;
  type?: string;
};

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const queueConsumerSettings = (env: Env) => ({
  batch_size: positiveInteger(env.W7S_QUEUE_BATCH_SIZE, 10),
  max_retries: positiveInteger(env.W7S_QUEUE_MAX_RETRIES, 3),
  retry_delay: positiveInteger(env.W7S_QUEUE_RETRY_DELAY_SECONDS, 10)
});

const shortHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0").slice(0, 7);
};

const compactQueueName = (name: string) => {
  if (name.length <= 63) return name;
  const suffix = shortHash(name);
  return `${name.slice(0, 55).replace(/-+$/g, "")}-${suffix}`;
};

const defaultQueueName = (
  orgSlug: string,
  repoSlug: string,
  environment: string,
  queueName: string
) =>
  compactQueueName(
    [
      "w7s",
      sanitizeScriptPart(environment),
      sanitizeScriptPart(orgSlug),
      sanitizeScriptPart(repoSlug),
      "queue",
      sanitizeScriptPart(queueName)
    ].join("-")
  );

const queueResourceRecord = (params: {
  orgSlug: string;
  repoSlug: string;
  environment: string;
  binding: string;
  name: string;
  id: string;
}) => {
  const now = new Date().toISOString();
  return {
    version: 1,
    kind: "queue",
    orgSlug: params.orgSlug,
    repoSlug: params.repoSlug,
    environment: params.environment,
    binding: params.binding,
    name: params.name,
    id: params.id,
    createdAt: now,
    updatedAt: now
  } satisfies ManagedResourceRecord;
};

const findOrCreateQueue = async (
  credentials: CloudflareCredentials,
  queueName: string
) => {
  const listResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/queues?per_page=1000`,
    {
      headers: buildCloudflareHeaders(credentials.apiToken)
    }
  );
  const queues = await parseCloudflareEnvelope<QueueRecord[]>(listResponse);
  const existing = queues?.find((queue) => queue.queue_name === queueName);
  if (existing?.queue_id) return existing.queue_id;

  const createResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/queues`,
    {
      method: "POST",
      headers: buildCloudflareHeaders(credentials.apiToken, "application/json"),
      body: JSON.stringify({ queue_name: queueName })
    }
  );
  const created = await parseCloudflareEnvelope<QueueRecord>(createResponse);
  if (!created?.queue_id) throw new Error(`Cloudflare did not return a Queue id for ${queueName}.`);
  return created.queue_id;
};

const getOrCreateQueueRecord = async (params: {
  env: Env;
  credentials: CloudflareCredentials;
  orgSlug: string;
  repoSlug: string;
  environment: string;
  declaration: QueueDeclaration;
}) => {
  const name = defaultQueueName(
    params.orgSlug,
    params.repoSlug,
    params.environment,
    params.declaration.name
  );
  const existing = await loadManagedResourceRecord(
    params.env,
    params.environment,
    params.orgSlug,
    params.repoSlug,
    "queue",
    params.declaration.name
  );
  if (existing) return existing;

  const id = await findOrCreateQueue(params.credentials, name);
  const record = queueResourceRecord({
    orgSlug: params.orgSlug,
    repoSlug: params.repoSlug,
    environment: params.environment,
    binding: params.declaration.name,
    name,
    id
  });
  await storeManagedResourceRecord(params.env, record);
  return record;
};

const ensureQueueConsumer = async (params: {
  env: Env;
  credentials: CloudflareCredentials;
  queueId: string;
  scriptName: string;
}) => {
  const listResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(params.credentials.accountId)}/queues/${encodeURIComponent(params.queueId)}/consumers`,
    {
      headers: buildCloudflareHeaders(params.credentials.apiToken)
    }
  );
  const consumers = await parseCloudflareEnvelope<QueueConsumer[]>(listResponse);
  const existing = consumers?.find(
    (consumer) => consumer.type === "worker" && consumer.script_name === params.scriptName
  );
  if (existing) return;

  const createResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(params.credentials.accountId)}/queues/${encodeURIComponent(params.queueId)}/consumers`,
    {
      method: "POST",
      headers: buildCloudflareHeaders(params.credentials.apiToken, "application/json"),
      body: JSON.stringify({
        type: "worker",
        script_name: params.scriptName,
        settings: queueConsumerSettings(params.env)
      })
    }
  );
  try {
    await parseCloudflareEnvelope<QueueConsumer>(createResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("already has a consumer")) return;
    throw error;
  }
};

export const provisionAppQueues = async (params: {
  env: Env;
  manifest: AppManifest;
  orgSlug: string;
  repoSlug: string;
  environment: string;
}) => {
  if (params.manifest.queues.length === 0) return [];
  const credentials = requireCloudflareCredentials(params.env);
  const consumerScriptName = params.env.W7S_WORKER_NAME?.trim() || "w7s-io";
  const queues: DeploymentQueue[] = [];

  for (const declaration of params.manifest.queues) {
    const record = await getOrCreateQueueRecord({
      env: params.env,
      credentials,
      orgSlug: params.orgSlug,
      repoSlug: params.repoSlug,
      environment: params.environment,
      declaration
    });
    await ensureQueueConsumer({
      env: params.env,
      credentials,
      queueId: record.id,
      scriptName: consumerScriptName
    });
    queues.push({
      name: declaration.name,
      queueName: record.name,
      queueId: record.id,
      consumer: declaration.consumer
    });
  }

  return queues;
};

export const sendQueueMessage = async (params: {
  env: Env;
  queueId: string;
  body: unknown;
  delaySeconds?: number;
}) => {
  const credentials = requireCloudflareCredentials(params.env);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/queues/${encodeURIComponent(params.queueId)}/messages`,
    {
      method: "POST",
      headers: buildCloudflareHeaders(credentials.apiToken, "application/json"),
      body: JSON.stringify({
        body: params.body,
        content_type: "json",
        ...(params.delaySeconds === undefined ? {} : { delay_seconds: params.delaySeconds })
      })
    }
  );
  return parseCloudflareEnvelope(response);
};
