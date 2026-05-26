import type { Context } from "hono";
import type { Env } from "../env";
import { parseGitHubRepository, verifyGitHubRepoAccess } from "../deploy/githubAuth";
import { jsonError, jsonSuccess, parseBearerToken } from "../http";
import { requireSlug, resolveEnvironment } from "../names";
import { loadEffectiveUsageLimitPolicies } from "../usageLimits";

type HonoContext = Context<{ Bindings: Env }>;

const pathSegments = (path: string) =>
  path.split("/").map((segment) => segment.trim()).filter(Boolean);

const parseLimitsTarget = (c: HonoContext) => {
  const segments = pathSegments(new URL(c.req.url).pathname);
  const apiIndex = segments.findIndex((segment, index) =>
    segment === "api" && segments[index + 1] === "v1" && segments[index + 2] === "limits"
  );
  const owner = segments[apiIndex + 3];
  const repo = segments[apiIndex + 4];
  if (apiIndex < 0 || !owner || !repo) {
    throw new Error("Limits route must be /api/v1/limits/<owner>/<repo>.");
  }
  return {
    owner,
    repo,
    orgSlug: requireSlug(decodeURIComponent(owner), "limits owner"),
    repoSlug: requireSlug(decodeURIComponent(repo), "limits repo")
  };
};

export const handleLimitsGet = async (c: HonoContext) => {
  const token = parseBearerToken(c.req.raw);
  if (!token) return jsonError("Missing bearer token.", 401);

  let target: ReturnType<typeof parseLimitsTarget>;
  let environment: string;
  try {
    target = parseLimitsTarget(c);
    environment = resolveEnvironment({
      branch: "main",
      queryValue: c.req.query("environment"),
      headerValue: c.req.header("x-w7s-environment")
    });
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

  const limits = await loadEffectiveUsageLimitPolicies(c.env, {
    environment,
    orgSlug: target.orgSlug,
    repoSlug: target.repoSlug
  });

  return jsonSuccess({
    limits: {
      ...limits,
      repository: `${target.orgSlug}/${target.repoSlug}`
    }
  });
};
