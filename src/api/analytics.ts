import type { Context } from "hono";
import type { Env } from "../env";
import { parseGitHubRepository, verifyGitHubRepoAccess } from "../deploy/githubAuth";
import { jsonError, jsonSuccess, parseBearerToken } from "../http";
import { requireSlug, resolveEnvironment } from "../names";

type HonoContext = Context<{ Bindings: Env }>;

const ANALYTICS_SQL_ENDPOINT = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`;

const DATASET_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const pathSegments = (path: string) =>
  path.split("/").map((segment) => segment.trim()).filter(Boolean);

const parseAnalyticsTarget = (c: HonoContext) => {
  const segments = pathSegments(new URL(c.req.url).pathname);
  const apiIndex = segments.findIndex((segment, index) =>
    segment === "api" && segments[index + 1] === "v1" && segments[index + 2] === "analytics"
  );
  const owner = segments[apiIndex + 3];
  const repo = segments[apiIndex + 4];
  if (apiIndex < 0 || !owner || !repo) {
    throw new Error("Analytics route must be /api/v1/analytics/<owner>/<repo>.");
  }
  return {
    owner,
    repo,
    orgSlug: requireSlug(decodeURIComponent(owner), "analytics owner"),
    repoSlug: requireSlug(decodeURIComponent(repo), "analytics repo")
  };
};

const readPositiveInteger = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
) => {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
};

const readIsoDate = (value: string | undefined, field: string) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid ISO date.`);
  return date;
};

const sqlDate = (date: Date) => date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");

const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

const numberValue = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const stringValue = (value: unknown) => String(value ?? "");

const queryAnalyticsEngine = async (
  env: Env,
  query: string
) => {
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !accountId) {
    throw new Error("Cloudflare analytics credentials are not configured.");
  }
  const response = await fetch(ANALYTICS_SQL_ENDPOINT(accountId), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "text/plain; charset=utf-8"
    },
    body: query
  });
  const raw = await response.text();
  let payload: { data?: unknown[]; errors?: unknown[] } | null = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.errors) {
    const message = payload?.errors?.map((entry) =>
      typeof entry === "object" && entry && "message" in entry
        ? String((entry as { message?: unknown }).message)
        : String(entry)
    ).join("; ") || raw || `Analytics Engine query failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  return Array.isArray(payload?.data) ? payload.data : [];
};

const buildWhere = (params: {
  repository: string;
  environment: string;
  from: Date;
  to: Date;
}) => [
  `index1 = ${sqlString(params.repository)}`,
  `blob3 = ${sqlString(params.environment)}`,
  `timestamp >= toDateTime(${sqlString(sqlDate(params.from))})`,
  `timestamp < toDateTime(${sqlString(sqlDate(params.to))})`
].join(" AND ");

const summaryQuery = (dataset: string, where: string) => `
  SELECT
    blob1 AS event,
    blob6 AS outcome,
    SUM(_sample_interval * double1) AS count,
    SUM(_sample_interval) AS samples,
    SUM(_sample_interval * double3) / SUM(_sample_interval) AS avgDurationMs
  FROM ${dataset}
  WHERE ${where}
  GROUP BY event, outcome
  ORDER BY count DESC
  LIMIT 200
  FORMAT JSON
`;

const timeseriesQuery = (dataset: string, where: string, bucket: "hour" | "day") => `
  SELECT
    ${bucket === "day" ? "toStartOfDay(timestamp)" : "toStartOfHour(timestamp)"} AS bucket,
    blob1 AS event,
    SUM(_sample_interval * double1) AS count
  FROM ${dataset}
  WHERE ${where}
  GROUP BY bucket, event
  ORDER BY bucket ASC, event ASC
  LIMIT 1000
  FORMAT JSON
`;

const eventsQuery = (dataset: string, where: string, limit: number) => `
  SELECT
    timestamp,
    blob1 AS event,
    blob6 AS outcome,
    blob7 AS source,
    blob8 AS target,
    blob9 AS method,
    double1 AS count,
    double2 AS status,
    double3 AS durationMs
  FROM ${dataset}
  WHERE ${where}
  ORDER BY timestamp DESC
  LIMIT ${limit}
  FORMAT JSON
`;

export const handleAnalyticsGet = async (c: HonoContext) => {
  const token = parseBearerToken(c.req.raw);
  if (!token) return jsonError("Missing bearer token.", 401);

  let target: ReturnType<typeof parseAnalyticsTarget>;
  let environment: string;
  let hours: number;
  let limit: number;
  let from: Date;
  let to: Date;
  let bucket: "hour" | "day";
  try {
    target = parseAnalyticsTarget(c);
    environment = resolveEnvironment({
      branch: "main",
      queryValue: c.req.query("environment"),
      headerValue: c.req.header("x-w7s-environment")
    });
    hours = readPositiveInteger(c.req.query("hours"), 24, 1, 168, "hours");
    limit = readPositiveInteger(c.req.query("limit"), 50, 1, 200, "limit");
    to = readIsoDate(c.req.query("to"), "to") ?? new Date();
    from = readIsoDate(c.req.query("from"), "from") ?? new Date(to.getTime() - hours * 60 * 60 * 1000);
    if (from.getTime() >= to.getTime()) throw new Error("from must be before to.");
    bucket = c.req.query("bucket") === "day" ? "day" : "hour";
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 400);
  }

  const repository = parseGitHubRepository(`${target.owner}/${target.repo}`);
  if (!repository) return jsonError("Repository must be in owner/repo form.", 400);
  const allowed = await verifyGitHubRepoAccess({
    token,
    owner: repository.owner,
    repo: repository.repo
  });
  if (!allowed) {
    return jsonError("Bearer token is not authorized for this GitHub repository.", 401);
  }

  const dataset = c.env.W7S_ANALYTICS_DATASET?.trim();
  if (!dataset) {
    return jsonSuccess({
      analytics: {
        configured: false,
        repository: `${target.orgSlug}/${target.repoSlug}`,
        environment,
        from: from.toISOString(),
        to: to.toISOString(),
        summary: [],
        timeseries: [],
        events: [],
        message: "W7S_ANALYTICS_DATASET is not configured."
      }
    });
  }
  if (!DATASET_PATTERN.test(dataset)) {
    return jsonError("W7S_ANALYTICS_DATASET is invalid.", 500);
  }

  const where = buildWhere({
    repository: `${target.orgSlug}/${target.repoSlug}`,
    environment,
    from,
    to
  });
  try {
    const [summaryRows, timeseriesRows, eventRows] = await Promise.all([
      queryAnalyticsEngine(c.env, summaryQuery(dataset, where)),
      queryAnalyticsEngine(c.env, timeseriesQuery(dataset, where, bucket)),
      queryAnalyticsEngine(c.env, eventsQuery(dataset, where, limit))
    ]);

    return jsonSuccess({
      analytics: {
        configured: true,
        dataset,
        repository: `${target.orgSlug}/${target.repoSlug}`,
        environment,
        from: from.toISOString(),
        to: to.toISOString(),
        bucket,
        summary: summaryRows.map((row) => ({
          event: stringValue((row as Record<string, unknown>).event),
          outcome: stringValue((row as Record<string, unknown>).outcome),
          count: numberValue((row as Record<string, unknown>).count),
          samples: numberValue((row as Record<string, unknown>).samples),
          avgDurationMs: numberValue((row as Record<string, unknown>).avgDurationMs)
        })),
        timeseries: timeseriesRows.map((row) => ({
          bucket: stringValue((row as Record<string, unknown>).bucket),
          event: stringValue((row as Record<string, unknown>).event),
          count: numberValue((row as Record<string, unknown>).count)
        })),
        events: eventRows.map((row) => ({
          timestamp: stringValue((row as Record<string, unknown>).timestamp),
          event: stringValue((row as Record<string, unknown>).event),
          outcome: stringValue((row as Record<string, unknown>).outcome),
          source: stringValue((row as Record<string, unknown>).source),
          target: stringValue((row as Record<string, unknown>).target),
          method: stringValue((row as Record<string, unknown>).method),
          count: numberValue((row as Record<string, unknown>).count),
          status: numberValue((row as Record<string, unknown>).status),
          durationMs: numberValue((row as Record<string, unknown>).durationMs)
        }))
      }
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 502);
  }
};
