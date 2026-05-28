import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../worker";
import { createTestEnv } from "./mocks";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("health endpoint", () => {
  it("exposes deploy metadata", async () => {
    const env = createTestEnv({
      APP_COMMIT_ID: "abc123",
      APP_DEPLOY_BRANCH: "main",
      APP_DEPLOYED_AT: "2026-05-23T19:31:42Z"
    });

    for (const path of ["/health", "/api/v1/health"]) {
      const response = await app.fetch(new Request(`https://w7s.cloud${path}`), env);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        status: "ok",
        service: "w7s-io",
        commitId: "abc123",
        branch: "main",
        deployedAt: "2026-05-23T19:31:42Z"
      });
    }
  });
});

describe("landing page", () => {
  it("shows the minimal GitHub Actions deploy workflow", async () => {
    const response = await app.fetch(new Request("https://w7s.cloud/"), createTestEnv());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("<title>W7S Cloud</title>");
    expect(body).toContain("<h1>The Cloud that <em>just works</em>.</h1>");
    expect(body).toContain("GitHub Actions builds your app");
    expect(body).toContain("https://www.w7s.io/docs/");
    expect(body).toContain("name: Deploy");
    expect(body).toContain("push:");
    expect(body).toContain("workflow_dispatch");
    expect(body).toContain("schedule:");
    expect(body).toContain("issues: write");
    expect(body).toContain("w7s-io/w7s-cloud@v1");
    expect(body.indexOf("<pre><code>")).toBeLessThan(body.indexOf("Add this GitHub Actions workflow"));
    expect(body).toContain('<strong class="workflow-action">w7s-io/w7s-cloud@v1</strong>');
    expect(body).toContain("token: ${{ github.token }}");
    expect(body).toContain("usage-check-only");
    expect(body).toContain("github.event_name == 'schedule'");
    expect(body).toContain("branches:");
    expect(body).not.toContain("install-command");
    expect(body).not.toContain("build-command");
  });
});

describe("status endpoint", () => {
  it("exposes a public component summary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes("/api/v1/limits/")) {
          return new Response(
            JSON.stringify({ status: "error", error: "Missing bearer token." }),
            { status: 401, headers: { "content-type": "application/json" } }
          );
        }

        if (
          url.includes("example-rpc-client") ||
          url.includes("example-queue-worker") ||
          url.includes("example-schedules")
        ) {
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        if (url.includes("example-durable-counter")) {
          return new Response(
            JSON.stringify({
              service: "example-durable-counter",
              object: "Counter"
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        if (url.includes("example-workflows")) {
          return new Response(JSON.stringify({ service: "example-workflows" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        return new Response("Deploy From GitHub", { status: 200 });
      })
    );

    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/status"),
      createTestEnv()
    );
    const body = await response.json() as {
      status: { description: string };
      components: Array<{ status: string }>;
      incidents: unknown[];
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(body.status.description).toBe("All systems operational");
    expect(body.components).toHaveLength(12);
    expect(body.components.every((component) => component.status === "operational")).toBe(true);
    expect(body.incidents).toHaveLength(0);
  });
});
