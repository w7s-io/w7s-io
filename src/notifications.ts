import type { Context } from "hono";
import type { Env } from "./env";
import { jsonError, jsonSuccess } from "./http";
import { resolveEnvironment, sanitizeScriptPart } from "./names";
import type { UsageLimitWarning } from "./usageLimits";

export type TelegramEvent =
  | "deploy_success"
  | "deploy_warning"
  | "deploy_error"
  | "app_suspended"
  | "usage_collection_error";

type RepoTelegramEvent =
  | TelegramEvent
  | "usage_warning"
  | "payment_request"
  | "all";

type NotifyOptions = {
  dedupeKey?: string;
  dedupeTtlSeconds?: number;
};

type JsonRecord = Record<string, unknown>;

type TelegramSubscription = {
  version: 1;
  chatId: string;
  events: RepoTelegramEvent[];
  environment: string;
  orgSlug: string;
  repoSlug: string;
  repository: string;
  branch?: string;
  commitSha?: string;
  updatedAt: string;
  source: "github_action";
};

type TelegramSubscriptionInput = {
  chatId: string;
  events: RepoTelegramEvent[];
};

const DEFAULT_EVENTS = new Set<TelegramEvent>([
  "deploy_success",
  "deploy_warning",
  "deploy_error",
  "app_suspended",
  "usage_collection_error"
]);

const DEFAULT_REPO_EVENTS: RepoTelegramEvent[] = [
  "deploy_success",
  "deploy_warning",
  "deploy_error",
  "app_suspended",
  "payment_request"
];

const VALID_REPO_EVENTS = new Set<RepoTelegramEvent>([
  ...DEFAULT_REPO_EVENTS,
  "usage_warning",
  "usage_collection_error",
  "all"
]);

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_SUBSCRIPTION_PREFIX = "telegram_subscription:v1";

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

const repoEventEnabled = (subscription: TelegramSubscription, event: TelegramEvent) => {
  const events = new Set(subscription.events);
  return events.has("all") || events.has(event);
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

const sendTelegramMessage = async (
  env: Env,
  chatId: string,
  text: string,
  options?: NotifyOptions
) => {
  const botToken = env.W7S_TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken || !chatId.trim()) return false;

  try {
    const dedupeKey = await readDedupeKey(env, options);
    if (options?.dedupeKey && options.dedupeTtlSeconds && !dedupeKey) return true;
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
      return false;
    }
    if (dedupeKey && options?.dedupeTtlSeconds) {
      await markDedupeKey(env, dedupeKey, options.dedupeTtlSeconds);
    }
    return true;
  } catch (error) {
    console.warn(`W7S Telegram notification failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
};

export const notifyTelegramManager = async (
  env: Env,
  event: TelegramEvent,
  text: string,
  options?: NotifyOptions
) => {
  const chatId = env.W7S_TELEGRAM_CHAT_ID?.trim();
  if (!chatId || !eventEnabled(env, event)) return;
  await sendTelegramMessage(env, chatId, text, options);
};

const telegramSubscriptionKey = (params: {
  environment: string;
  orgSlug: string;
  repoSlug: string;
  chatId: string;
}) =>
  [
    TELEGRAM_SUBSCRIPTION_PREFIX,
    sanitizeScriptPart(params.environment),
    sanitizeScriptPart(params.orgSlug),
    sanitizeScriptPart(params.repoSlug),
    dedupePart(params.chatId)
  ].join(":");

const telegramSubscriptionPrefix = (params: {
  environment: string;
  orgSlug: string;
  repoSlug: string;
}) =>
  [
    TELEGRAM_SUBSCRIPTION_PREFIX,
    sanitizeScriptPart(params.environment),
    sanitizeScriptPart(params.orgSlug),
    sanitizeScriptPart(params.repoSlug),
    ""
  ].join(":");

const parseRepoEvents = (value: string | null) => {
  if (!value) return DEFAULT_REPO_EVENTS;
  const events = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean) as RepoTelegramEvent[];
  const filtered = events.filter((event) => VALID_REPO_EVENTS.has(event));
  return filtered.length > 0 ? [...new Set(filtered)] : DEFAULT_REPO_EVENTS;
};

const normalizeTelegramChatId = (value: string | null) => {
  if (!value) return null;
  const chatId = value.trim();
  if (!chatId) return null;
  if (/^-?\d{3,32}$/.test(chatId)) return chatId;
  if (/^@[a-zA-Z0-9_]{5,64}$/.test(chatId)) return chatId;
  return null;
};

const subscriptionInputFromRequest = (request: Request): TelegramSubscriptionInput | null => {
  const chatId = normalizeTelegramChatId(
    request.headers.get("x-w7s-telegram-chat-id") ??
    request.headers.get("x-w7s-telegram-user-id")
  );
  if (!chatId) return null;
  return {
    chatId,
    events: parseRepoEvents(request.headers.get("x-w7s-telegram-events"))
  };
};

const upsertTelegramSubscription = async (
  env: Env,
  params: TelegramSubscriptionInput & {
    environment: string;
    orgSlug: string;
    repoSlug: string;
    repository: string;
    branch?: string;
    commitSha?: string;
  }
) => {
  const record: TelegramSubscription = {
    version: 1,
    chatId: params.chatId,
    events: params.events,
    environment: params.environment,
    orgSlug: params.orgSlug,
    repoSlug: params.repoSlug,
    repository: params.repository,
    branch: params.branch,
    commitSha: params.commitSha,
    updatedAt: new Date().toISOString(),
    source: "github_action"
  };
  await env.DEPLOYMENTS_KV.put(telegramSubscriptionKey(record), JSON.stringify(record));
  return record;
};

const listTelegramSubscriptions = async (
  env: Env,
  params: {
    environment: string;
    orgSlug: string;
    repoSlug: string;
    event: TelegramEvent;
  }
) => {
  const records: TelegramSubscription[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.DEPLOYMENTS_KV.list({
      prefix: telegramSubscriptionPrefix(params),
      cursor
    });
    for (const key of listed.keys) {
      const raw = await env.DEPLOYMENTS_KV.get(key.name, "json");
      const record = asRecord(raw);
      if (
        record?.version !== 1 ||
        !stringValue(record.chatId) ||
        !Array.isArray(record.events)
      ) continue;
      const subscription = record as TelegramSubscription;
      if (repoEventEnabled(subscription, params.event)) records.push(subscription);
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return records;
};

const notifyTelegramSubscribers = async (
  env: Env,
  params: {
    event: TelegramEvent;
    environment: string;
    orgSlug: string;
    repoSlug: string;
    text: string;
    dedupeKey?: string;
    dedupeTtlSeconds?: number;
  }
) => {
  const subscriptions = await listTelegramSubscriptions(env, params);
  await Promise.all(
    subscriptions.map((subscription) =>
      sendTelegramMessage(env, subscription.chatId, params.text, {
        dedupeKey: params.dedupeKey
          ? `subscriber:${subscription.chatId}:${params.dedupeKey}`
          : undefined,
        dedupeTtlSeconds: params.dedupeTtlSeconds
      })
    )
  );
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

const deployEnvironmentFromRequest = (request: Request) => {
  try {
    const url = new URL(request.url);
    return resolveEnvironment({
      branch: request.headers.get("x-github-branch")?.trim() || "main",
      queryValue: url.searchParams.get("environment"),
      headerValue: request.headers.get("x-w7s-environment")
    });
  } catch {
    return "production";
  }
};

const parseRepositoryParts = (repository: string) => {
  const [owner, repo] = repository.split("/", 2);
  if (!owner || !repo) return null;
  return {
    orgSlug: sanitizeScriptPart(owner),
    repoSlug: sanitizeScriptPart(repo)
  };
};

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
  const orgSlug = stringValue(deployment.orgSlug);
  const repoSlug = stringValue(deployment.repoSlug);
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
    orgSlug,
    repoSlug,
    environment: stringValue(deployment.environment),
    branch: stringValue(deployment.branch),
    commitSha: stringValue(deployment.commitSha),
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
    environment: deployEnvironmentFromRequest(request),
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
    const subscriptionInput = subscriptionInputFromRequest(request);
    if (
      subscriptionInput &&
      message.orgSlug &&
      message.repoSlug &&
      message.environment
    ) {
      await upsertTelegramSubscription(env, {
        ...subscriptionInput,
        environment: message.environment,
        orgSlug: message.orgSlug,
        repoSlug: message.repoSlug,
        repository: message.repository,
        branch: message.branch ?? undefined,
        commitSha: message.commitSha ?? undefined
      });
    }
    await Promise.all([
      notifyTelegramManager(env, message.event, message.text),
      message.orgSlug && message.repoSlug && message.environment
        ? notifyTelegramSubscribers(env, {
            event: message.event,
            environment: message.environment,
            orgSlug: message.orgSlug,
            repoSlug: message.repoSlug,
            text: message.text
          })
        : Promise.resolve()
    ]);
    return;
  }

  if (response.status >= 400) {
    const message = deployErrorMessage(request, body, response.status);
    const parts = parseRepositoryParts(message.repository);
    await Promise.all([
      notifyTelegramManager(env, "deploy_error", message.text, {
        dedupeKey: `deploy_error:${message.repository}:${response.status}:${message.text}`,
        dedupeTtlSeconds: 600
      }),
      parts
        ? notifyTelegramSubscribers(env, {
            event: "deploy_error",
            environment: message.environment,
            orgSlug: parts.orgSlug,
            repoSlug: parts.repoSlug,
            text: message.text,
            dedupeKey: `deploy_error:${message.environment}:${message.repository}:${response.status}:${message.text}`,
            dedupeTtlSeconds: 600
          })
        : Promise.resolve()
    ]);
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
  const text = [
    "W7S app suspended",
    `Repository: ${repository}`,
    `Environment: ${params.environment}`,
    `Reason: ${params.reason ?? "usage limit exceeded"}`,
    ...(params.resumeAfter ? [`Resume after: ${params.resumeAfter}`] : []),
    ...(metricLines.length > 0 ? ["Metrics:", ...metricLines] : [])
  ].join("\n");
  const dedupeKey = `app_suspended:${params.environment}:${repository}:${at.toISOString().slice(0, 10)}`;
  await Promise.all([
    notifyTelegramManager(
      env,
      "app_suspended",
      text,
      {
        dedupeKey,
        dedupeTtlSeconds: 86_400
      }
    ),
    notifyTelegramSubscribers(env, {
      event: "app_suspended",
      environment: params.environment,
      orgSlug: params.orgSlug,
      repoSlug: params.repoSlug,
      text,
      dedupeKey,
      dedupeTtlSeconds: 86_400
    })
  ]);
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

const botInstructions = (chatId: string, fromId?: string | null) => [
  "W7S Telegram notifications",
  "",
  "Use this chat id in your GitHub Actions workflow:",
  "",
  `telegram-chat-id: "${chatId}"`,
  ...(fromId && fromId !== chatId ? ["", `Your Telegram user id is ${fromId}.`] : []),
  "",
  "Example:",
  "",
  "name: Deploy",
  "on:",
  "  push:",
  "  workflow_dispatch:",
  "permissions:",
  "  contents: read",
  "jobs:",
  "  deploy:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v5",
  "      - uses: w7s-io/w7s-cloud@v1",
  "        with:",
  "          token: ${{ github.token }}",
  `          telegram-chat-id: "${chatId}"`,
  "          telegram-events: deploy_success,deploy_warning,deploy_error,app_suspended,payment_request",
  "",
  "The bot can only send private messages after you have started this chat."
].join("\n");

const handleTelegramUpdate = async (env: Env, update: JsonRecord) => {
  const message =
    asRecord(update.message) ??
    asRecord(update.edited_message) ??
    asRecord(update.channel_post);
  const chat = asRecord(message?.chat);
  const from = asRecord(message?.from);
  const chatId = stringValue(chat?.id) ?? (numberValue(chat?.id) !== null ? String(numberValue(chat?.id)) : null);
  if (!chatId) return;
  const fromId = stringValue(from?.id) ?? (numberValue(from?.id) !== null ? String(numberValue(from?.id)) : null);
  await sendTelegramMessage(env, chatId, botInstructions(chatId, fromId));
};

export const handleTelegramWebhook = async (c: Context<{ Bindings: Env }>) => {
  const configuredSecret = c.env.W7S_TELEGRAM_WEBHOOK_SECRET?.trim();
  if (configuredSecret) {
    const receivedSecret = c.req.header("x-telegram-bot-api-secret-token")?.trim();
    if (receivedSecret !== configuredSecret) return jsonError("Invalid Telegram webhook secret.", 401);
  }

  let update: JsonRecord | null;
  try {
    update = asRecord(await c.req.json());
  } catch {
    update = null;
  }
  if (!update) return jsonError("Invalid Telegram update.", 400);
  await handleTelegramUpdate(c.env, update);
  return jsonSuccess({ ok: true });
};

export const handleTelegramWebhookInfo = () =>
  jsonSuccess({
    webhook: "/api/v1/telegram/webhook",
    setup: "Send /start to the W7S Telegram bot. It will reply with your chat id and a GitHub Actions workflow example.",
    actionInputs: {
      "telegram-chat-id": "Telegram private, group, or channel chat id",
      "telegram-events": "Comma-separated events: deploy_success, deploy_warning, deploy_error, app_suspended, payment_request, or all"
    }
  });
