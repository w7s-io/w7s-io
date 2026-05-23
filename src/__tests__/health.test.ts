import { describe, expect, it } from "vitest";
import { app } from "../worker";
import { createTestEnv } from "./mocks";

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
    expect(body).toContain("name: Deploy");
    expect(body).toContain("on: push");
    expect(body).toContain("w7s-io/w7s-cloud@v1");
    expect(body.indexOf("<pre><code>")).toBeLessThan(body.indexOf("Add this GitHub Actions workflow"));
    expect(body).toContain('<strong class="workflow-action">w7s-io/w7s-cloud@v1</strong>');
    expect(body).toContain("token: ${{ github.token }}");
    expect(body).not.toContain("workflow_dispatch");
    expect(body).not.toContain("branches:");
    expect(body).not.toContain("install-command");
    expect(body).not.toContain("build-command");
  });
});
