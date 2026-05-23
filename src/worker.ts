import { Hono } from "hono";
import type { Env } from "./env";
import { handleDeploy } from "./api/deploy";
import { json } from "./http";
import { resolveRuntimeRequest } from "./runtime/router";
import { landingHtml } from "./static/landing";

export const app = new Hono<{ Bindings: Env }>();

app.get("/api/v1/health", (c) =>
  json({
    status: "ok",
    service: "w7s-io",
    commitId: c.env.APP_COMMIT_ID ?? null
  })
);

app.post("/api/v1/deploy", handleDeploy);

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
  fetch: app.fetch
};

