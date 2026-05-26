import type { Env } from "./env";
import { sanitizeScriptPart } from "./names";
import { loadWorkerScriptMapping, type WorkerScriptMapping } from "./storage/deployments";

export type AppLogKind = "console" | "exception" | "outcome";

export type AppLogRecord = {
  version: 1;
  id: string;
  kind: AppLogKind;
  timestamp: string;
  observedAt: string;
  environment: string;
  orgSlug: string;
  repoSlug: string;
  repository: string;
  scriptName: string;
  outcome: string;
  level?: string;
  message?: unknown[];
  text?: string;
  exception?: {
    name: string;
    message: string;
    stack?: string;
  };
  request?: {
    method?: string;
    path?: string;
    status?: number;
    colo?: string;
  };
};

type TailTrace = {
  scriptName?: string | null;
  eventTimestamp?: number | null;
  outcome?: string | null;
  event?: unknown;
  logs?: TailLog[];
  exceptions?: TailException[];
};

type TailLog = {
  timestamp?: number | null;
  level?: string | null;
  message?: unknown;
};

type TailException = {
  timestamp?: number | null;
  name?: string | null;
  message?: string | null;
  stack?: string | null;
};

type TailExecutionContext = {
  waitUntil?: (promise: Promise<unknown>) => void;
};

const LOG_PREFIX = "app_log:v1";
const MAX_REVERSE_TIMESTAMP = 9999999999999;
const DEFAULT_LOG_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const MAX_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const MAX_RECORDS_PER_TRACE = 100;
const MAX_STRING_LENGTH = 4096;
const MAX_ARRAY_ITEMS = 25;
const MAX_OBJECT_KEYS = 25;
const MAX_NORMALIZE_DEPTH = 4;

const retentionSeconds = (env: Env) => {
  const parsed = Number(env.W7S_LOG_RETENTION_SECONDS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LOG_RETENTION_SECONDS;
  return Math.min(Math.max(Math.floor(parsed), 60), MAX_RETENTION_SECONDS);
};

const timestampMs = (value: unknown, fallback: number) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return number < 10_000_000_000 ? number * 1000 : number;
};

const isoTimestamp = (value: unknown, fallback: number) =>
  new Date(timestampMs(value, fallback)).toISOString();

const reverseTimestamp = (timestamp: string) => {
  const millis = new Date(timestamp).getTime();
  const reverse = MAX_REVERSE_TIMESTAMP - (Number.isFinite(millis) ? millis : Date.now());
  return String(Math.max(0, reverse)).padStart(13, "0");
};

export const appLogPrefix = (params: {
  environment: string;
  orgSlug: string;
  repoSlug: string;
}) =>
  [
    LOG_PREFIX,
    sanitizeScriptPart(params.environment),
    sanitizeScriptPart(params.orgSlug),
    sanitizeScriptPart(params.repoSlug)
  ].join(":");

export const appLogKey = (record: Pick<AppLogRecord, "environment" | "orgSlug" | "repoSlug" | "timestamp" | "id">) =>
  `${appLogPrefix(record)}:${reverseTimestamp(record.timestamp)}:${record.id}`;

const truncateString = (value: string) =>
  value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]` : value;

const normalizeValue = (value: unknown, depth = 0, seen = new WeakSet<object>()): unknown => {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(value.message),
      ...(value.stack ? { stack: truncateString(value.stack) } : {})
    };
  }
  if (depth >= MAX_NORMALIZE_DEPTH) return "[max-depth]";
  if (typeof value !== "object") return truncateString(String(value));
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => normalizeValue(item, depth + 1, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    output[key] = normalizeValue(entry, depth + 1, seen);
  }
  return output;
};

const normalizeMessage = (message: unknown) => {
  const parts = Array.isArray(message) ? message : [message];
  return parts.slice(0, MAX_ARRAY_ITEMS).map((part) => normalizeValue(part));
};

const textPart = (value: unknown) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const messageText = (message: unknown[]) =>
  truncateString(message.map(textPart).join(" "));

const requestDetails = (event: unknown): AppLogRecord["request"] | undefined => {
  if (!event || typeof event !== "object" || !("request" in event)) return undefined;
  const fetchEvent = event as {
    request?: {
      method?: unknown;
      url?: unknown;
      cf?: Record<string, unknown>;
    };
    response?: {
      status?: unknown;
    };
  };
  const request = fetchEvent.request;
  const response = fetchEvent.response;
  const details: NonNullable<AppLogRecord["request"]> = {};
  if (typeof request?.method === "string") details.method = request.method;
  if (typeof request?.url === "string") {
    try {
      details.path = new URL(request.url).pathname || "/";
    } catch {
      details.path = truncateString(request.url);
    }
  }
  const status = Number(response?.status);
  if (Number.isFinite(status) && status > 0) details.status = Math.floor(status);
  const colo = request?.cf?.colo;
  if (typeof colo === "string" && colo) details.colo = colo;
  return Object.keys(details).length > 0 ? details : undefined;
};

const baseLogRecord = (params: {
  trace: TailTrace;
  mapping: WorkerScriptMapping;
  scriptName: string;
  timestamp: string;
  observedAt: string;
}): Omit<AppLogRecord, "id" | "kind"> => {
  const request = requestDetails(params.trace.event);
  return {
    version: 1,
    timestamp: params.timestamp,
    observedAt: params.observedAt,
    environment: params.mapping.environment,
    orgSlug: params.mapping.orgSlug,
    repoSlug: params.mapping.repoSlug,
    repository: params.mapping.repository,
    scriptName: params.scriptName,
    outcome: params.trace.outcome || "unknown",
    ...(request ? { request } : {})
  };
};

const randomId = () => crypto.randomUUID().replace(/-/g, "");

const recordsFromTrace = (trace: TailTrace, mapping: WorkerScriptMapping) => {
  const observedAt = new Date().toISOString();
  const scriptName = trace.scriptName || mapping.scriptName;
  const fallbackTimestamp = timestampMs(trace.eventTimestamp, Date.now());
  const records: AppLogRecord[] = [];

  for (const log of trace.logs ?? []) {
    if (records.length >= MAX_RECORDS_PER_TRACE) break;
    const message = normalizeMessage(log.message);
    records.push({
      ...baseLogRecord({
        trace,
        mapping,
        scriptName,
        timestamp: isoTimestamp(log.timestamp, fallbackTimestamp),
        observedAt
      }),
      id: randomId(),
      kind: "console",
      level: log.level || "log",
      message,
      text: messageText(message)
    });
  }

  for (const exception of trace.exceptions ?? []) {
    if (records.length >= MAX_RECORDS_PER_TRACE) break;
    const name = exception.name || "Error";
    const message = truncateString(exception.message || trace.outcome || "Unhandled Worker exception.");
    records.push({
      ...baseLogRecord({
        trace,
        mapping,
        scriptName,
        timestamp: isoTimestamp(exception.timestamp, fallbackTimestamp),
        observedAt
      }),
      id: randomId(),
      kind: "exception",
      level: "error",
      text: `${name}: ${message}`,
      exception: {
        name,
        message,
        ...(exception.stack ? { stack: truncateString(exception.stack) } : {})
      }
    });
  }

  if (
    records.length === 0 &&
    trace.outcome &&
    trace.outcome !== "ok" &&
    trace.outcome !== "unknown"
  ) {
    records.push({
      ...baseLogRecord({
        trace,
        mapping,
        scriptName,
        timestamp: isoTimestamp(trace.eventTimestamp, fallbackTimestamp),
        observedAt
      }),
      id: randomId(),
      kind: "outcome",
      level: "error",
      text: `Worker invocation finished with outcome ${trace.outcome}.`
    });
  }

  return records;
};

export const storeAppLogRecords = async (env: Env, records: AppLogRecord[]) => {
  const expirationTtl = retentionSeconds(env);
  await Promise.all(
    records.map((record) =>
      env.DEPLOYMENTS_KV.put(appLogKey(record), JSON.stringify(record), { expirationTtl })
    )
  );
};

export const persistTailEvents = async (events: unknown[], env: Env) => {
  const mappings = new Map<string, WorkerScriptMapping | null>();
  const records: AppLogRecord[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const trace = event as TailTrace;
    const scriptName = trace.scriptName?.trim();
    if (!scriptName) continue;
    if (!mappings.has(scriptName)) {
      mappings.set(scriptName, await loadWorkerScriptMapping(env, scriptName));
    }
    const mapping = mappings.get(scriptName);
    if (!mapping) continue;
    records.push(...recordsFromTrace(trace, mapping));
  }
  if (records.length > 0) await storeAppLogRecords(env, records);
  return records.length;
};

export const handleTailEvents = (
  events: unknown[],
  env: Env,
  context?: TailExecutionContext
) => {
  const promise = persistTailEvents(Array.isArray(events) ? events : [], env).catch((error) => {
    console.warn(`W7S log tail persistence failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (context?.waitUntil) {
    context.waitUntil(promise);
    return;
  }
  return promise;
};

export const listAppLogs = async (env: Env, params: {
  environment: string;
  orgSlug: string;
  repoSlug: string;
  from: Date;
  to: Date;
  limit: number;
  cursor?: string;
  kind?: AppLogKind;
  level?: string;
}) => {
  const output: AppLogRecord[] = [];
  const prefix = appLogPrefix(params);
  let cursor = params.cursor || undefined;
  do {
    const listed = await env.DEPLOYMENTS_KV.list({
      prefix,
      cursor,
      limit: Math.max(1, Math.min(1000, params.limit - output.length))
    });
    for (const entry of listed.keys) {
      const raw = await env.DEPLOYMENTS_KV.get(entry.name, "json");
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Partial<AppLogRecord>;
      if (record.version !== 1 || typeof record.timestamp !== "string") continue;
      const timestamp = new Date(record.timestamp);
      if (timestamp.getTime() > params.to.getTime()) continue;
      if (timestamp.getTime() < params.from.getTime()) {
        cursor = undefined;
        return { records: output, cursor: null };
      }
      if (params.kind && record.kind !== params.kind) continue;
      if (params.level && record.level !== params.level) continue;
      output.push(record as AppLogRecord);
      if (output.length >= params.limit) break;
    }
    cursor = listed.list_complete || output.length >= params.limit ? undefined : listed.cursor;
    if (listed.list_complete || output.length >= params.limit) {
      return {
        records: output,
        cursor: listed.list_complete ? null : listed.cursor || null
      };
    }
  } while (cursor);
  return { records: output, cursor: null };
};
