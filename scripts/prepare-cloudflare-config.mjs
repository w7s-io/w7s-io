import { mkdir, writeFile } from "node:fs/promises";

const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || process.env.ACCOUNT_ID?.trim();
const zoneName = process.env.W7S_ZONE_NAME?.trim() || "w7s.cloud";
const deploymentsKvName = process.env.W7S_DEPLOYMENTS_KV_NAME?.trim() || "w7s-io-deployments";
const staticBucketName = process.env.W7S_STATIC_ASSETS_BUCKET?.trim() || "w7s-io-static-assets";
const dispatchNamespace = process.env.W7S_DISPATCH_NAMESPACE?.trim() || "w7s-isolate";
const workerName = "w7s-io";
const analyticsDataset = process.env.W7S_ANALYTICS_DATASET?.trim() || "";
const logRetentionSeconds = process.env.W7S_LOG_RETENTION_SECONDS?.trim() || "604800";
const logTailConsumer = process.env.W7S_LOG_TAIL_CONSUMER?.trim() || workerName;
const disableWorkerLogs = process.env.W7S_DISABLE_WORKER_LOGS?.trim() || "";
const queueMaxMessageBytes = process.env.W7S_QUEUE_MAX_MESSAGE_BYTES?.trim() || "65536";
const queueBatchSize = process.env.W7S_QUEUE_BATCH_SIZE?.trim() || "10";
const queueMaxRetries = process.env.W7S_QUEUE_MAX_RETRIES?.trim() || "3";
const queueRetryDelaySeconds = process.env.W7S_QUEUE_RETRY_DELAY_SECONDS?.trim() || "10";
const queueVisibilityTimeoutMs = process.env.W7S_QUEUE_VISIBILITY_TIMEOUT_MS?.trim() || "300000";
const workflowMaxPayloadBytes = process.env.W7S_WORKFLOW_MAX_PAYLOAD_BYTES?.trim() || "65536";
const workflowActiveLimit = process.env.W7S_WORKFLOW_ACTIVE_LIMIT?.trim() || "50";
const workflowActiveTtlSeconds = process.env.W7S_WORKFLOW_ACTIVE_TTL_SECONDS?.trim() || "86400";
const workflowMaxRetries = process.env.W7S_WORKFLOW_MAX_RETRIES?.trim() || "3";
const workflowRetryDelaySeconds = process.env.W7S_WORKFLOW_RETRY_DELAY_SECONDS?.trim() || "10";
const workflowTimeoutSeconds = process.env.W7S_WORKFLOW_TIMEOUT_SECONDS?.trim() || "300";
const staticRetentionDays = process.env.W7S_STATIC_RETENTION_DAYS?.trim() || "7";
const usageRetentionDays = process.env.W7S_USAGE_RETENTION_DAYS?.trim() || "14";
const workerScriptRetentionDays = process.env.W7S_WORKER_SCRIPT_RETENTION_DAYS?.trim() || "7";
const workflowName = process.env.W7S_WORKFLOW_NAME?.trim() || "w7s-workflows";
const userWorkerCpuMs = process.env.W7S_USER_WORKER_CPU_MS?.trim() || "50";
const userWorkerSubrequests = process.env.W7S_USER_WORKER_SUBREQUESTS?.trim() || "25";
const scheduleCron = process.env.W7S_CORE_CRON?.trim() || "* * * * *";
const attachWildcardRoute = /^(1|true|yes|on)$/i.test(
  process.env.W7S_ATTACH_WILDCARD_ROUTE?.trim() || ""
);
const compatibilityDate =
  process.env.W7S_COMPATIBILITY_DATE?.trim() ||
  process.env.CLOUDFLARE_ISOLATE_COMPATIBILITY_DATE?.trim() ||
  "2026-05-23";
const appCommitId = process.env.GITHUB_SHA?.trim() || null;
const appDeployBranch =
  process.env.W7S_DEPLOY_BRANCH?.trim() ||
  process.env.GITHUB_REF_NAME?.trim() ||
  null;
const appDeployedAt = process.env.W7S_DEPLOYED_AT?.trim() || null;
const statusComponentsJson = process.env.W7S_STATUS_COMPONENTS_JSON?.trim() || "";
const statusRegionsJson = process.env.W7S_STATUS_REGIONS_JSON?.trim() || "";
const statusIncidentsJson = process.env.W7S_STATUS_INCIDENTS_JSON?.trim() || "";
const telegramEvents = process.env.W7S_TELEGRAM_EVENTS?.trim() || "";
const telegramBotToken = process.env.W7S_TELEGRAM_BOT_TOKEN?.trim() || "";
const telegramChatId = process.env.W7S_TELEGRAM_CHAT_ID?.trim() || "";

if (!apiToken) {
  throw new Error("CLOUDFLARE_API_TOKEN is required.");
}

if (!accountId) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID or ACCOUNT_ID is required.");
}

const cfRequest = async (method, path, body) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (response.ok && parsed?.success !== false) return parsed?.result ?? null;
  const message =
    parsed?.errors?.map((entry) => entry?.message).filter(Boolean).join("; ") ||
    text ||
    `Cloudflare API request failed with ${response.status}`;
  const error = new Error(message);
  error.status = response.status;
  throw error;
};

const ensureKvNamespace = async (title) => {
  const result = await cfRequest(
    "GET",
    `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces?per_page=100`
  );
  const namespaces = Array.isArray(result) ? result : [];
  const existing = namespaces.find((entry) => entry?.title === title);
  if (existing?.id) return existing.id;

  const created = await cfRequest(
    "POST",
    `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces`,
    { title }
  );
  if (!created?.id) throw new Error(`Cloudflare did not return an id for KV namespace ${title}.`);
  return created.id;
};

const ensureR2Bucket = async (name) => {
  const result = await cfRequest(
    "GET",
    `/accounts/${encodeURIComponent(accountId)}/r2/buckets?per_page=100`
  );
  const buckets = Array.isArray(result?.buckets)
    ? result.buckets
    : Array.isArray(result)
      ? result
      : [];
  if (buckets.some((entry) => entry?.name === name)) return;

  try {
    await cfRequest("POST", `/accounts/${encodeURIComponent(accountId)}/r2/buckets`, { name });
  } catch (error) {
    if (error?.status === 409) return;
    throw error;
  }
};

const ensureDispatchNamespace = async (name) => {
  const encodedAccount = encodeURIComponent(accountId);
  const encodedName = encodeURIComponent(name);
  try {
    await cfRequest("GET", `/accounts/${encodedAccount}/workers/dispatch/namespaces/${encodedName}`);
    return;
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  await cfRequest("POST", `/accounts/${encodedAccount}/workers/dispatch/namespaces`, { name });
};

const resolveZoneId = async (name) => {
  const result = await cfRequest(
    "GET",
    `/zones?name=${encodeURIComponent(name)}&per_page=50`
  );
  const zones = Array.isArray(result) ? result : [];
  const exact = zones.find((entry) => entry?.name === name);
  if (!exact?.id) {
    throw new Error(`Unable to find Cloudflare zone id for ${name}.`);
  }
  return exact.id;
};

const [kvNamespaceId, zoneId] = await Promise.all([
  ensureKvNamespace(deploymentsKvName),
  resolveZoneId(zoneName),
  ensureR2Bucket(staticBucketName),
  ensureDispatchNamespace(dispatchNamespace)
]);

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: workerName,
  main: "src/worker.ts",
  compatibility_date: compatibilityDate,
  workers_dev: true,
  triggers: {
    crons: [scheduleCron]
  },
  workflows: [
    {
      name: workflowName,
      binding: "W7S_WORKFLOWS",
      class_name: "W7SWorkflow"
    }
  ],
  vars: {
    W7S_BASE_DOMAIN: zoneName,
    W7S_WORKER_NAME: workerName,
    CLOUDFLARE_DISPATCH_NAMESPACE: dispatchNamespace,
    CLOUDFLARE_ISOLATE_COMPATIBILITY_DATE: compatibilityDate,
    W7S_USER_WORKER_CPU_MS: userWorkerCpuMs,
    W7S_USER_WORKER_SUBREQUESTS: userWorkerSubrequests,
    W7S_LOG_RETENTION_SECONDS: logRetentionSeconds,
    W7S_LOG_TAIL_CONSUMER: logTailConsumer,
    W7S_QUEUE_MAX_MESSAGE_BYTES: queueMaxMessageBytes,
    W7S_QUEUE_BATCH_SIZE: queueBatchSize,
    W7S_QUEUE_MAX_RETRIES: queueMaxRetries,
    W7S_QUEUE_RETRY_DELAY_SECONDS: queueRetryDelaySeconds,
    W7S_QUEUE_VISIBILITY_TIMEOUT_MS: queueVisibilityTimeoutMs,
    W7S_WORKFLOW_MAX_PAYLOAD_BYTES: workflowMaxPayloadBytes,
    W7S_WORKFLOW_ACTIVE_LIMIT: workflowActiveLimit,
    W7S_WORKFLOW_ACTIVE_TTL_SECONDS: workflowActiveTtlSeconds,
    W7S_WORKFLOW_MAX_RETRIES: workflowMaxRetries,
    W7S_WORKFLOW_RETRY_DELAY_SECONDS: workflowRetryDelaySeconds,
    W7S_WORKFLOW_TIMEOUT_SECONDS: workflowTimeoutSeconds,
    W7S_STATIC_RETENTION_DAYS: staticRetentionDays,
    W7S_USAGE_RETENTION_DAYS: usageRetentionDays,
    W7S_WORKER_SCRIPT_RETENTION_DAYS: workerScriptRetentionDays,
    ...(disableWorkerLogs ? { W7S_DISABLE_WORKER_LOGS: disableWorkerLogs } : {}),
    ...(analyticsDataset ? { W7S_ANALYTICS_DATASET: analyticsDataset } : {}),
    ...(appCommitId ? { APP_COMMIT_ID: appCommitId } : {}),
    ...(appDeployBranch ? { APP_DEPLOY_BRANCH: appDeployBranch } : {}),
    ...(appDeployedAt ? { APP_DEPLOYED_AT: appDeployedAt } : {}),
    ...(statusComponentsJson ? { W7S_STATUS_COMPONENTS_JSON: statusComponentsJson } : {}),
    ...(statusRegionsJson ? { W7S_STATUS_REGIONS_JSON: statusRegionsJson } : {}),
    ...(statusIncidentsJson ? { W7S_STATUS_INCIDENTS_JSON: statusIncidentsJson } : {}),
    ...(telegramEvents ? { W7S_TELEGRAM_EVENTS: telegramEvents } : {})
  },
  dispatch_namespaces: [
    {
      binding: "DISPATCHER",
      namespace: dispatchNamespace,
      remote: true
    }
  ],
  kv_namespaces: [
    {
      binding: "DEPLOYMENTS_KV",
      id: kvNamespaceId,
      preview_id: kvNamespaceId
    }
  ],
  r2_buckets: [
    {
      binding: "STATIC_ASSETS",
      bucket_name: staticBucketName,
      preview_bucket_name: staticBucketName
    }
  ],
  ...(analyticsDataset
    ? {
        analytics_engine_datasets: [
          {
            binding: "W7S_ANALYTICS",
            dataset: analyticsDataset
          }
        ]
      }
    : {})
};

await mkdir(".wrangler", { recursive: true });
await writeFile("wrangler.generated.jsonc", `${JSON.stringify(config, null, 2)}\n`);
await writeFile(
  ".wrangler/secrets.json",
  `${JSON.stringify(
    {
      CLOUDFLARE_API_TOKEN: apiToken,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      ...(telegramBotToken ? { W7S_TELEGRAM_BOT_TOKEN: telegramBotToken } : {}),
      ...(telegramChatId ? { W7S_TELEGRAM_CHAT_ID: telegramChatId } : {})
    },
    null,
    2
  )}\n`
);

console.log(
  JSON.stringify(
    {
      generated: "wrangler.generated.jsonc",
      secretsFile: ".wrangler/secrets.json",
      zoneName,
      zoneId,
      deploymentsKvName,
      deploymentsKvId: kvNamespaceId,
      staticBucketName,
      dispatchNamespace,
      analyticsDataset: analyticsDataset || null,
      workflowName,
      userWorkerCpuMs,
      userWorkerSubrequests,
      logRetentionSeconds,
      logTailConsumer,
      disableWorkerLogs: disableWorkerLogs || null,
      queueMaxMessageBytes,
      queueBatchSize,
      queueMaxRetries,
      queueRetryDelaySeconds,
      queueVisibilityTimeoutMs,
      workflowMaxPayloadBytes,
      workflowActiveLimit,
      workflowActiveTtlSeconds,
      workflowMaxRetries,
      workflowRetryDelaySeconds,
      workflowTimeoutSeconds,
      staticRetentionDays,
      usageRetentionDays,
      workerScriptRetentionDays,
      scheduleCron,
      attachWildcardRoute,
      routeManagement: "post-deploy"
    },
    null,
    2
  )
);
