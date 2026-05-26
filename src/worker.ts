import { Hono, type Context } from "hono";
import type { Env } from "./env";
import { handleDeploy } from "./api/deploy";
import { handleRpc } from "./api/rpc";
import { handleQueueSend } from "./api/queues";
import { handleWorkflowCreate, handleWorkflowStatus } from "./api/workflows";
import { handleUsageGet } from "./api/usage";
import { handleLimitsGet } from "./api/limits";
import { handleAnalyticsGet } from "./api/analytics";
import { handleLogsGet } from "./api/logs";
import { json } from "./http";
import { handleQueueBatch } from "./runtime/queueDelivery";
import { handleScheduled } from "./runtime/scheduleDelivery";
import { W7SWorkflow } from "./runtime/workflowDelivery";
import { resolveRuntimeRequest } from "./runtime/router";
import { landingHtml } from "./static/landing";
import { handleTailEvents } from "./logs";

export { W7SWorkflow };

export const app = new Hono<{ Bindings: Env }>();

const health = (c: Context<{ Bindings: Env }>) =>
  json({
    status: "ok",
    service: "w7s-io",
    commitId: c.env.APP_COMMIT_ID ?? null,
    branch: c.env.APP_DEPLOY_BRANCH ?? null,
    deployedAt: c.env.APP_DEPLOYED_AT ?? null
  });

app.get("/health", health);
app.get("/api/v1/health", health);

app.post("/api/v1/deploy", handleDeploy);
app.all("/api/v1/rpc/*", handleRpc);
app.post("/api/v1/queues/*", handleQueueSend);
app.post("/api/v1/workflows/*", handleWorkflowCreate);
app.get("/api/v1/workflows/*", handleWorkflowStatus);
app.get("/api/v1/usage/*", handleUsageGet);
app.get("/api/v1/limits/*", handleLimitsGet);
app.get("/api/v1/analytics/*", handleAnalyticsGet);
app.get("/api/v1/logs/*", handleLogsGet);

app.all("*", async (c) => {
  const runtimeResponse = await resolveRuntimeRequest(c.req.raw, c.env);
  if (runtimeResponse) return runtimeResponse;

  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return c.notFound();
  }

  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache"
  });
  return new Response(c.req.method === "HEAD" ? null : landingHtml(), {
    status: 200,
    headers
  });
});

export default {
  fetch: app.fetch,
  queue: handleQueueBatch,
  scheduled: handleScheduled,
  tail: handleTailEvents
};
