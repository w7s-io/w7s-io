import type { Context } from "hono";
import { responseOutcome, writeAnalyticsEvent } from "../analytics";
import type { Env } from "../env";
import { recordUsageEvent } from "../usage";
import { enforceUsageLimit } from "../usageEnforcement";
import { jsonError, parseBearerToken } from "../http";
import { requireSlug } from "../names";
import { hashRpcToken } from "../deploy/rpcBindings";
import { loadDeploymentRecord } from "../storage/deployments";
import { dispatchWorker } from "../runtime/dispatch";
import { enforceAppNotSuspended } from "../appLimits";

type HonoContext = Context<{ Bindings: Env }>;

const RPC_PREFIX = "/api/v1/rpc/";

const splitPath = (path: string) =>
  path.split("/").map((segment) => segment.trim()).filter(Boolean);

const parseTarget = (request: Request) => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(RPC_PREFIX)) {
    throw new Error("Invalid RPC route.");
  }
  const relative = url.pathname.slice(RPC_PREFIX.length);
  const rawSegments = splitPath(relative);
  if (rawSegments.length < 2) {
    throw new Error("RPC target must be /api/v1/rpc/<owner>/<repo>/<path>.");
  }
  const orgSlug = requireSlug(decodeURIComponent(rawSegments[0] ?? ""), "RPC target owner");
  const repoSlug = requireSlug(decodeURIComponent(rawSegments[1] ?? ""), "RPC target repo");
  const trailingSlash = url.pathname.endsWith("/") ? "/" : "";
  const targetParts = rawSegments.slice(2).map((segment) => decodeURIComponent(segment));
  return {
    orgSlug,
    repoSlug,
    repoPath: targetParts.length > 0 ? `/${targetParts.join("/")}${trailingSlash}` : "/"
  };
};

const parseCaller = (c: HonoContext) => {
  const caller = c.req.header("x-w7s-rpc-caller")?.trim() ?? "";
  const [owner, repo, extra] = caller.split("/");
  if (!owner || !repo || extra) {
    throw new Error("x-w7s-rpc-caller must be in owner/repo form.");
  }
  return {
    orgSlug: requireSlug(owner, "RPC caller owner"),
    repoSlug: requireSlug(repo, "RPC caller repo"),
    environment: requireSlug(c.req.header("x-w7s-rpc-environment") ?? "", "RPC caller environment")
  };
};

const isAuthorizedCaller = (params: {
  callerOrg: string;
  callerRepo: string;
  targetOrg: string;
  targetAllow: string[];
}) => {
  if (params.callerOrg === params.targetOrg) return true;
  const callerRepository = `${params.callerOrg}/${params.callerRepo}`;
  return params.targetAllow.includes(params.callerOrg) || params.targetAllow.includes(callerRepository);
};

export const handleRpc = async (c: HonoContext) => {
  const startedAt = Date.now();
  const token = parseBearerToken(c.req.raw);
  if (!token) return jsonError("Missing RPC bearer token.", 401);

  let caller: ReturnType<typeof parseCaller>;
  let target: ReturnType<typeof parseTarget>;
  try {
    caller = parseCaller(c);
    target = parseTarget(c.req.raw);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 400);
  }

  const callerDeployment = await loadDeploymentRecord(
    c.env,
    caller.environment,
    caller.orgSlug,
    caller.repoSlug
  );
  if (!callerDeployment?.rpc?.tokenHash) {
    return jsonError("RPC is not enabled for the caller deployment. Redeploy the caller app.", 401);
  }
  if (await hashRpcToken(token) !== callerDeployment.rpc.tokenHash) {
    return jsonError("Invalid RPC bearer token.", 401);
  }

  const targetDeployment = await loadDeploymentRecord(
    c.env,
    caller.environment,
    target.orgSlug,
    target.repoSlug
  );
  if (!targetDeployment) {
    return jsonError("RPC target deployment was not found.", 404);
  }
  if (!targetDeployment.targets.worker) {
    return jsonError("RPC target deployment has no backend.", 404);
  }
  if (
    !isAuthorizedCaller({
      callerOrg: caller.orgSlug,
      callerRepo: caller.repoSlug,
      targetOrg: target.orgSlug,
      targetAllow: targetDeployment.rpc?.allow ?? []
    })
  ) {
    return jsonError("RPC caller is not authorized for this target.", 403);
  }

  const callerSuspended = await enforceAppNotSuspended(c.env, {
    environment: caller.environment,
    orgSlug: caller.orgSlug,
    repoSlug: caller.repoSlug,
    request: c.req.raw
  });
  if (callerSuspended) return callerSuspended;
  const targetSuspended = await enforceAppNotSuspended(c.env, {
    environment: caller.environment,
    orgSlug: target.orgSlug,
    repoSlug: target.repoSlug,
    request: c.req.raw
  });
  if (targetSuspended) return targetSuspended;

  const limitResponse = await enforceUsageLimit(c.env, {
    metric: "rpc.dispatch",
    environment: caller.environment,
    orgSlug: caller.orgSlug,
    repoSlug: caller.repoSlug,
    units: 1
  });
  if (limitResponse) return limitResponse;

  const response = await dispatchWorker({
    env: c.env,
    request: c.req.raw,
    repoPath: target.repoPath,
    repoSlug: target.repoSlug,
    orgSlug: target.orgSlug,
    scriptName: targetDeployment.targets.worker.scriptName,
    urlHost: `${target.orgSlug}.w7s.internal`,
    stripHeaders: [
      "authorization",
      "x-w7s-rpc-caller",
      "x-w7s-rpc-environment"
    ],
    headers: {
      "x-w7s-rpc": "1",
      "x-w7s-rpc-caller-owner": caller.orgSlug,
      "x-w7s-rpc-caller-repo": caller.repoSlug,
      "x-w7s-rpc-caller-repository": `${caller.orgSlug}/${caller.repoSlug}`,
      "x-w7s-rpc-caller-environment": caller.environment
    }
  });

  writeAnalyticsEvent(c.env, {
    event: "rpc",
    repository: `${caller.orgSlug}/${caller.repoSlug}`,
    environment: caller.environment,
    orgSlug: caller.orgSlug,
    repoSlug: caller.repoSlug,
    outcome: responseOutcome(response.status),
    source: "dispatch",
    target: `${target.orgSlug}/${target.repoSlug}`,
    method: c.req.method,
    status: response.status,
    durationMs: Date.now() - startedAt
  });
  await recordUsageEvent(c.env, {
    metric: "rpc.dispatch",
    repository: `${caller.orgSlug}/${caller.repoSlug}`,
    environment: caller.environment,
    orgSlug: caller.orgSlug,
    repoSlug: caller.repoSlug,
    outcome: responseOutcome(response.status),
    count: 1,
    units: 1
  });

  return response;
};
