import type { Env } from "./env";
import type { UsageLimitWarning } from "./usageLimits";

export type TelegramEvent =
  | "deploy_success"
  | "deploy_warning"
  | "deploy_error"
  | "app_suspended"
  | "usage_collection_error";

type NotifyOptions = {
  dedupeKey?: string;
  dedupeTtlSeconds?: number;
};

type JsonRecord = Record<string, unknown>;

const DEFAULT_EVENTS = new Set<TelegramEvent>([
  "deploy_success",
  "deploy_warning",
  "deploy_error",
  "app_suspended",
  "usage_collection_error"
]);

const TELEGRAM_API_BASE = "https://api.telegram.org";

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;

const stringValue = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const numberValue = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const arrayValue = (value: unknown) =>
  Array.isArray(value) ? value : [];

const shortSha = (value: unknown) => {
  const sha = stringValue(value);
  return sha ? sha.slice(0, 12) : null;
};

const eventEnabled = (env: Env, event: TelegramEvent) => {
  const configured = env.W7S_TELEGRAM_EVENTS?.trim();
  if (!configured) return DEFAULT_EVENTS.has(event);
  const enabled = new Set(
    configured
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
  return enabled.has("all") || enabled.has(event);
};

const dedupePart = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 160) || "event";

const notifyDedupeKey = (key: string) =>
  `telegram_notification:v1:${dedupePart(key)}`;

const readDedupeKey = async (env: Env, options?: NotifyOptions) => {
  if (!options?.dedupeKey || !options.dedupeTtlSeconds) return null;
  const key = notifyDedupeKey(options.dedupeKey);
  return await env.DEPLOYMENTS_KV.get(key) ? null : key;
};

const markDedupeKey = async (env: Env, key: string, ttlSeconds: number) => {
  await env.DEPLOYMENTS_KV.put(key, new Date().toISOString(), {
    expirationTtl: ttlSeconds
  });
};

export const notifyTelegramManager = async (
  env: Env,
  event: TelegramEvent,
  text: string,
  options?: NotifyOptions
) => {
  const botToken = env.W7S_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.W7S_TELEGRAM_CHAT_ID?.trim();
  if (!botToken || !chatId || !eventEnabled(env, event)) return;

  try {
    const dedupeKey = await readDedupeKey(env, options);
    if (options?.dedupeKey && options.dedupeTtlSeconds && !dedupeKey) return;
    const response = await fetch(
      `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.slice(0, 3900),
          disable_web_page_preview: true
        })
      }
    );
    if (!response.ok) {
      console.warn(`W7S Telegram notification failed with HTTP ${response.status}.`);
      return;
    }
    if (dedupeKey && options?.dedupeTtlSeconds) {
      await markDedupeKey(env, dedupeKey, options.dedupeTtlSeconds);
    }
  } catch (error) {
    console.warn(`W7S Telegram notification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const deployTargetSummary = (deployment: JsonRecord) => {
  const targets = asRecord(deployment.targets);
  const staticTarget = asRecord(targets?.static);
  const workerTarget = asRecord(targets?.worker);
  const parts: string[] = [];
  if (staticTarget) {
    const fileCount = numberValue(staticTarget.fileCount);
    parts.push(fileCount === null ? "static" : `static ${fileCount} files`);
  }
  if (workerTarget) parts.push("backend");
  return parts.length > 0 ? parts.join(", ") : "none";
};

const warningLines = (label: string, warnings: unknown[]) => {
  if (warnings.length === 0) return [];
  const messages = warnings
    .map((warning) => stringValue(asRecord(warning)?.message))
    .filter((message): message is string => Boolean(message))
    .slice(0, 3);
  return [
    `${label}: ${warnings.length}`,
    ...messages.map((message) => `- ${message}`)
  ];
};

const deployRepositoryFromRequest = (request: Request) =>
  request.headers.get("x-github-repository")?.trim() || "unknown";

const deploymentMessage = (
  request: Request,
  body: JsonRecord,
  status: number
) => {
  const data = asRecord(body.data);
  const deployment = asRecord(data?.deployment);
  if (!deployment) return null;
  const deploymentWarnings = arrayValue(data?.deploymentWarnings);
  const customDomainWarnings = arrayValue(data?.customDomainWarnings);
  const blockedCustomDomains = arrayValue(data?.blockedCustomDomains);
  const event: TelegramEvent =
    deploymentWarnings.length > 0 || customDomainWarnings.length > 0 || blockedCustomDomains.length > 0
      ? "deploy_warning"
      : "deploy_success";
  const repository = stringValue(deployment.repository) ?? deployRepositoryFromRequest(request);
  const url = stringValue(data?.url);
  const lines = [
    event === "deploy_warning" ? "W7S deploy completed with warnings" : "W7S deploy succeeded",
    `Repository: ${repository}`,
    `Environment: ${stringValue(deployment.environment) ?? "unknown"}`,
    `Branch: ${stringValue(deployment.branch) ?? "unknown"}`,
    `Commit: ${shortSha(deployment.commitSha) ?? "unknown"}`,
    `Targets: ${deployTargetSummary(deployment)}`,
    `Status: HTTP ${status}`,
    ...(url ? [`URL: ${url}`] : []),
    ...warningLines("Deployment warnings", deploymentWarnings),
    ...warningLines("Custom domain warnings", customDomainWarnings),
    ...warningLines("Blocked custom domains", blockedCustomDomains)
  ];
  return {
    event,
    repository,
    text: lines.join("\n")
  };
};

const deployErrorMessage = (
  request: Request,
  body: JsonRecord | null,
  status: number
) => {
  const repository = deployRepositoryFromRequest(request);
  const error = stringValue(body?.error) ?? `Deploy failed with HTTP ${status}`;
  const branch = request.headers.get("x-github-branch")?.trim();
  const sha = request.headers.get("x-github-sha")?.trim();
  return {
    repository,
    text: [
      "W7S deploy failed",
      `Repository: ${repository}`,
      ...(branch ? [`Branch: ${branch}`] : []),
      ...(sha ? [`Commit: ${shortSha(sha)}`] : []),
      `Status: HTTP ${status}`,
      `Error: ${error}`
    ].join("\n")
  };
};

export const notifyDeployResponse = async (
  env: Env,
  request: Request,
  response: Response
) => {
  let body: JsonRecord | null = null;
  try {
    body = asRecord(await response.clone().json());
  } catch {
    body = null;
  }

  if (response.status >= 200 && response.status < 400 && body?.status === "success") {
    const message = deploymentMessage(request, body, response.status);
    if (!message) return;
    await notifyTelegramManager(env, message.event, message.text);
    return;
  }

  if (response.status >= 400) {
    const message = deployErrorMessage(request, body, response.status);
    await notifyTelegramManager(env, "deploy_error", message.text, {
      dedupeKey: `deploy_error:${message.repository}:${response.status}:${message.text}`,
      dedupeTtlSeconds: 600
    });
  }
};

export const notifyAppSuspended = async (
  env: Env,
  params: {
    environment: string;
    orgSlug: string;
    repoSlug: string;
    reason?: string;
    metrics?: UsageLimitWarning[];
    resumeAfter?: string;
    at?: Date;
  }
) => {
  const repository = `${params.orgSlug}/${params.repoSlug}`;
  const metricLines = (params.metrics ?? []).slice(0, 5).map((metric) =>
    `- ${metric.metric}: ${metric.used}/${metric.limit} (${metric.status})`
  );
  const at = params.at ?? new Date();
  await notifyTelegramManager(
    env,
    "app_suspended",
    [
      "W7S app suspended",
      `Repository: ${repository}`,
      `Environment: ${params.environment}`,
      `Reason: ${params.reason ?? "usage limit exceeded"}`,
      ...(params.resumeAfter ? [`Resume after: ${params.resumeAfter}`] : []),
      ...(metricLines.length > 0 ? ["Metrics:", ...metricLines] : [])
    ].join("\n"),
    {
      dedupeKey: `app_suspended:${params.environment}:${repository}:${at.toISOString().slice(0, 10)}`,
      dedupeTtlSeconds: 86_400
    }
  );
};

export const notifyUsageCollectionFailures = async (
  env: Env,
  params: {
    hour: string;
    deployments: number;
    failures: number;
  }
) => {
  await notifyTelegramManager(
    env,
    "usage_collection_error",
    [
      "W7S usage collection failures",
      `Hour: ${params.hour}`,
      `Deployments scanned: ${params.deployments}`,
      `Failures: ${params.failures}`
    ].join("\n"),
    {
      dedupeKey: `usage_collection_error:${params.hour}`,
      dedupeTtlSeconds: 7_200
    }
  );
};
