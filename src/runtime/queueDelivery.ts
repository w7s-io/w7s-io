import { responseOutcome, writeAnalyticsEvent } from "../analytics";
import type { Env } from "../env";
import {
  loadDeploymentRecord,
  loadQueueMapping
} from "../storage/deployments";
import { dispatchWorker } from "./dispatch";

type QueueEnvelope = {
  version?: number;
  body?: unknown;
  enqueuedAt?: string;
  caller?: {
    orgSlug?: string;
    repoSlug?: string;
    repository?: string;
    environment?: string;
  };
};

const isEnvelope = (value: unknown): value is QueueEnvelope =>
  !!value && typeof value === "object" && (value as QueueEnvelope).version === 1;

export const handleQueueBatch = async (
  batch: MessageBatch<unknown>,
  env: Env
) => {
  const startedAt = Date.now();
  const mapping = await loadQueueMapping(env, batch.queue);
  if (!mapping) {
    throw new Error(`W7S queue mapping was not found for ${batch.queue}.`);
  }

  const deployment = await loadDeploymentRecord(
    env,
    mapping.environment,
    mapping.orgSlug,
    mapping.repoSlug
  );
  const workerTarget = deployment?.targets.worker;
  if (!deployment || !workerTarget) {
    throw new Error(`W7S queue target deployment was not found for ${batch.queue}.`);
  }

  const messages = batch.messages.map((message) => {
    const envelope = isEnvelope(message.body) ? message.body : null;
    return {
      id: message.id,
      attempts: message.attempts,
      timestamp: message.timestamp.toISOString(),
      enqueuedAt: envelope?.enqueuedAt ?? null,
      caller: envelope?.caller ?? null,
      body: envelope ? envelope.body : message.body
    };
  });
  const request = new Request(`https://${mapping.orgSlug}.w7s.internal${mapping.consumer}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      queue: mapping.queue,
      queueName: mapping.queueName,
      messages
    })
  });

  const response = await dispatchWorker({
    env,
    request,
    repoPath: mapping.consumer,
    repoSlug: mapping.repoSlug,
    orgSlug: mapping.orgSlug,
    scriptName: workerTarget.scriptName,
    urlHost: `${mapping.orgSlug}.w7s.internal`,
    headers: {
      "x-w7s-queue": mapping.queue,
      "x-w7s-queue-name": mapping.queueName
    }
  });

  writeAnalyticsEvent(env, {
    event: "queue_delivery",
    repository: mapping.repository,
    environment: mapping.environment,
    orgSlug: mapping.orgSlug,
    repoSlug: mapping.repoSlug,
    outcome: responseOutcome(response.status),
    source: mapping.queue,
    method: "POST",
    status: response.status,
    durationMs: Date.now() - startedAt,
    count: messages.length
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`W7S queue consumer failed with HTTP ${response.status}.`);
  }
};
