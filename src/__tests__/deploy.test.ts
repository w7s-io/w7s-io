import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { app } from "../worker";
import { createTestEnv } from "./mocks";
import { loadDeploymentRecord } from "../storage/deployments";

const zipBytes = (files: Record<string, string>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, value]) => [path, new TextEncoder().encode(value)])
    )
  );

const deployRequest = (files: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request("https://w7s.cloud/api/v1/deploy", {
    method: "POST",
    headers: {
      authorization: "Bearer github-token",
      "content-type": "application/zip",
      "x-github-repository": "w7s-io/demo",
      "x-github-sha": "abc123",
      "x-github-branch": "main",
      ...headers
    },
    body: zipBytes(files)
  });

describe("deploy API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes static deployments and stores metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/")) {
          return Response.json({ full_name: "w7s-io/demo" });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv();
    const response = await app.fetch(
      deployRequest({
        "frontend/dist/index.html": "<h1>Hello</h1>",
        "frontend/dist/assets/app.js": "console.log('ok')"
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { status: string };
    expect(body.status).toBe("success");

    const record = await loadDeploymentRecord(env, "production", "w7s-io", "demo");
    expect(record?.targets.static?.fileCount).toBe(2);
    expect(record?.targets.worker).toBeUndefined();
  });

  it("rejects unauthorized GitHub tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 }))
    );
    const env = createTestEnv();
    const response = await app.fetch(
      deployRequest({
        "frontend/dist/index.html": "<h1>Hello</h1>"
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it("accepts backend folders as native deployments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/")) {
          return Response.json({ full_name: "w7s-io/demo" });
        }
        if (
          url.includes("/workers/dispatch/namespaces/w7s-isolate/scripts/") &&
          init?.method === "PUT"
        ) {
          return Response.json({ success: true, result: { startup_time_ms: 5 } });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-123"
    });
    const response = await app.fetch(
      deployRequest({
        "backend/index.js": "export default { fetch(){ return new Response('backend') } }"
      }),
      env
    );

    expect(response.status).toBe(200);
    const record = await loadDeploymentRecord(env, "production", "w7s-io", "demo");
    expect(record?.targets.worker?.entrypoint).toBe("backend/index.js");
  });
});
