import type { Context } from "hono";
import type { Env } from "../env";
import { parseGitHubRepository, verifyGitHubRepoAccess } from "../deploy/githubAuth";
import { jsonError, jsonSuccess, parseBearerToken } from "../http";
import { requireSlug, resolveEnvironment } from "../names";
import { loadUsageDailyRollup, usageDate } from "../usage";
import { evaluateUsageLimits } from "../usageLimits";

type HonoContext = Context<{ Bindings: Env }>;

const pathSegments = (path: string) =>
  path.split("/").map((segment) => segment.trim()).filter(Boolean);

const parseUsageTarget = (c: HonoContext) => {
  const segments = pathSegments(new URL(c.req.url).pathname);
  const apiIndex = segments.findIndex((segment, index) =>
    segment === "api" && segments[index + 1] === "v1" && segments[index + 2] === "usage"
  );
  const owner = segments[apiIndex + 3];
  const repo = segments[apiIndex + 4];
  if (apiIndex < 0 || !owner || !repo) {
    throw new Error("Usage route must be /api/v1/usage/<owner>/<repo>.");
  }
  return {
    owner,
    repo,
    orgSlug: requireSlug(decodeURIComponent(owner), "usage owner"),
    repoSlug: requireSlug(decodeURIComponent(repo), "usage repo")
  };
};

const readUsageDate = (value: string | undefined) => {
  if (!value) return usageDate(new Date());
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error("date must be YYYY-MM-DD.");
  }
  return trimmed;
};

export const handleUsageGet = async (c: HonoContext) => {
  const token = parseBearerToken(c.req.raw);
  if (!token) return jsonError("Missing bearer token.", 401);

  let target: ReturnType<typeof parseUsageTarget>;
  let environment: string;
  let date: string;
  try {
    target = parseUsageTarget(c);
    environment = resolveEnvironment({
      branch: "main",
      queryValue: c.req.query("environment"),
      headerValue: c.req.header("x-w7s-environment")
    });
    date = readUsageDate(c.req.query("date"));
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

  const rollup = await loadUsageDailyRollup(c.env, {
    date,
    environment,
    orgSlug: target.orgSlug,
    repoSlug: target.repoSlug
  });

  const usage = rollup ?? {
    version: 1 as const,
    date,
    orgSlug: target.orgSlug,
    repoSlug: target.repoSlug,
    environment,
    repository: `${target.orgSlug}/${target.repoSlug}`,
    metrics: {},
    updatedAt: null
  };
  const limits = evaluateUsageLimits(usage);

  return jsonSuccess({
    usage,
    limits,
    warnings: limits.warnings
  });
};
