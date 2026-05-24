import type { Context } from "hono";
import type { Env } from "../env";
import { jsonError, jsonSuccess, parseBearerToken } from "../http";
import { requireSlug } from "../names";
import { hashBindingToken } from "../deploy/tokens";
import { sendQueueMessage } from "../deploy/queueProvisioner";
import { loadDeploymentRecord } from "../storage/deployments";

type HonoContext = Context<{ Bindings: Env }>;

const QUEUE_PREFIX = "/api/v1/queues/";

const splitPath = (path: string) =>
  path.split("/").map((segment) => segment.trim()).filter(Boolean);

const parseTarget = (request: Request) => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(QUEUE_PREFIX)) {
    throw new Error("Invalid queue route.");
  }
  const rawSegments = splitPath(url.pathname.slice(QUEUE_PREFIX.length));
  if (rawSegments.length !== 3) {
    throw new Error("Queue target must be /api/v1/queues/<owner>/<repo>/<queue>.");
  }
  return {
    orgSlug: requireSlug(decodeURIComponent(rawSegments[0] ?? ""), "queue target owner"),
    repoSlug: requireSlug(decodeURIComponent(rawSegments[1] ?? ""), "queue target repo"),
    queue: requireSlug(decodeURIComponent(rawSegments[2] ?? ""), "queue name")
  };
};

const parseCaller = (c: HonoContext) => {
  const caller = c.req.header("x-w7s-queue-caller")?.trim() ?? "";
  const [owner, repo, extra] = caller.split("/");
  if (!owner || !repo || extra) {
    throw new Error("x-w7s-queue-caller must be in owner/repo form.");
  }
  return {
    orgSlug: requireSlug(owner, "queue caller owner"),
    repoSlug: requireSlug(repo, "queue caller repo"),
    environment: requireSlug(c.req.header("x-w7s-queue-environment") ?? "", "queue caller environment")
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

const readJsonBody = async (request: Request) => {
  if (!request.body) return null;
  try {
    return await request.json();
  } catch {
    throw new Error("Queue message body must be valid JSON.");
  }
};

const readDelaySeconds = (c: HonoContext) => {
  const value = c.req.header("x-w7s-queue-delay-seconds")?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 86400) {
    throw new Error("x-w7s-queue-delay-seconds must be an integer from 0 to 86400.");
  }
  return parsed;
};

export const handleQueueSend = async (c: HonoContext) => {
  const token = parseBearerToken(c.req.raw);
  if (!token) return jsonError("Missing queue bearer token.", 401);

  let caller: ReturnType<typeof parseCaller>;
  let target: ReturnType<typeof parseTarget>;
  let body: unknown;
  let delaySeconds: number | undefined;
  try {
    caller = parseCaller(c);
    target = parseTarget(c.req.raw);
    body = await readJsonBody(c.req.raw);
    delaySeconds = readDelaySeconds(c);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 400);
  }

  const callerDeployment = await loadDeploymentRecord(
    c.env,
    caller.environment,
    caller.orgSlug,
    caller.repoSlug
  );
  if (!callerDeployment?.queue?.tokenHash) {
    return jsonError("Queues are not enabled for the caller deployment. Redeploy the caller app.", 401);
  }
  if (await hashBindingToken(token) !== callerDeployment.queue.tokenHash) {
    return jsonError("Invalid queue bearer token.", 401);
  }

  const targetDeployment = await loadDeploymentRecord(
    c.env,
    caller.environment,
    target.orgSlug,
    target.repoSlug
  );
  if (!targetDeployment) {
    return jsonError("Queue target deployment was not found.", 404);
  }
  const targetQueue = targetDeployment.queue?.queues.find((queue) => queue.name === target.queue);
  if (!targetQueue) {
    return jsonError("Queue target was not declared by the deployment.", 404);
  }
  if (
    !isAuthorizedCaller({
      callerOrg: caller.orgSlug,
      callerRepo: caller.repoSlug,
      targetOrg: target.orgSlug,
      targetAllow: targetDeployment.queue?.allow ?? []
    })
  ) {
    return jsonError("Queue caller is not authorized for this target.", 403);
  }

  const enqueuedAt = new Date().toISOString();
  const result = await sendQueueMessage({
    env: c.env,
    queueId: targetQueue.queueId,
    delaySeconds,
    body: {
      version: 1,
      body,
      enqueuedAt,
      caller: {
        orgSlug: caller.orgSlug,
        repoSlug: caller.repoSlug,
        repository: `${caller.orgSlug}/${caller.repoSlug}`,
        environment: caller.environment
      },
      target: {
        orgSlug: target.orgSlug,
        repoSlug: target.repoSlug,
        repository: `${target.orgSlug}/${target.repoSlug}`,
        queue: target.queue
      }
    }
  });

  return jsonSuccess({
    queue: {
      owner: target.orgSlug,
      repo: target.repoSlug,
      name: target.queue
    },
    enqueuedAt,
    result
  });
};
