import type { Context } from "hono";
import type { Env } from "../env";
import { parseGitHubRepository, verifyGitHubRepoAccess } from "../deploy/githubAuth";
import { jsonError, jsonSuccess, parseBearerToken } from "../http";
import { listAppLogs, type AppLogKind } from "../logs";
import { requireSlug, resolveEnvironment } from "../names";

type HonoContext = Context<{ Bindings: Env }>;

const pathSegments = (path: string) =>
  path.split("/").map((segment) => segment.trim()).filter(Boolean);

const parseLogsTarget = (c: HonoContext) => {
  const segments = pathSegments(new URL(c.req.url).pathname);
  const apiIndex = segments.findIndex((segment, index) =>
    segment === "api" && segments[index + 1] === "v1" && segments[index + 2] === "logs"
  );
  const owner = segments[apiIndex + 3];
  const repo = segments[apiIndex + 4];
  if (apiIndex < 0 || !owner || !repo) {
    throw new Error("Logs route must be /api/v1/logs/<owner>/<repo>.");
  }
  return {
    owner,
    repo,
    orgSlug: requireSlug(decodeURIComponent(owner), "logs owner"),
    repoSlug: requireSlug(decodeURIComponent(repo), "logs repo")
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

const readKind = (value: string | undefined): AppLogKind | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "console" || normalized === "exception" || normalized === "outcome") return normalized;
  throw new Error("kind must be console, exception, or outcome.");
};

const readLevel = (value: string | undefined) => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["debug", "info", "log", "warn", "error"].includes(normalized)) return normalized;
  throw new Error("level must be debug, info, log, warn, or error.");
};

export const handleLogsGet = async (c: HonoContext) => {
  const token = parseBearerToken(c.req.raw);
  if (!token) return jsonError("Missing bearer token.", 401);

  let target: ReturnType<typeof parseLogsTarget>;
  let environment: string;
  let hours: number;
  let limit: number;
  let from: Date;
  let to: Date;
  let kind: AppLogKind | undefined;
  let level: string | undefined;
  try {
    target = parseLogsTarget(c);
    environment = resolveEnvironment({
      branch: "main",
      queryValue: c.req.query("environment"),
      headerValue: c.req.header("x-w7s-environment")
    });
    hours = readPositiveInteger(c.req.query("hours"), 1, 1, 168, "hours");
    limit = readPositiveInteger(c.req.query("limit"), 100, 1, 500, "limit");
    to = readIsoDate(c.req.query("to"), "to") ?? new Date();
    from = readIsoDate(c.req.query("from"), "from") ?? new Date(to.getTime() - hours * 60 * 60 * 1000);
    if (from.getTime() >= to.getTime()) throw new Error("from must be before to.");
    kind = readKind(c.req.query("kind"));
    level = readLevel(c.req.query("level"));
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

  const result = await listAppLogs(c.env, {
    environment,
    orgSlug: target.orgSlug,
    repoSlug: target.repoSlug,
    from,
    to,
    limit,
    cursor: c.req.query("cursor") || undefined,
    kind,
    level
  });

  return jsonSuccess({
    logs: {
      repository: `${target.orgSlug}/${target.repoSlug}`,
      environment,
      from: from.toISOString(),
      to: to.toISOString(),
      limit,
      cursor: result.cursor,
      records: result.records
    }
  });
};
