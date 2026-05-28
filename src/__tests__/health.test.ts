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
    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/status"),
      createTestEnv()
    );
    const body = await response.json() as {
      status: { description: string };
      components: Array<{ status: string }>;
      regions: Array<{ status: string }>;
      incidents: unknown[];
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(body.status.description).toBe("All systems operational");
    expect(body.components).toHaveLength(12);
    expect(body.regions).toHaveLength(6);
    expect(body.components.every((component) => component.status === "operational")).toBe(true);
    expect(body.regions.every((region) => region.status === "operational")).toBe(true);
    expect(body.incidents).toHaveLength(0);
  });

  it("reports configured incidents and component overrides", async () => {
    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/status"),
      createTestEnv({
        W7S_STATUS_COMPONENTS_JSON: JSON.stringify({
          queues: "partial_outage"
        }),
        W7S_STATUS_INCIDENTS_JSON: JSON.stringify([
          {
            id: "incident-1",
            name: "Deploy queue latency",
            status: "investigating",
            impact: "minor",
            created_at: "2026-05-27T00:00:00.000Z",
            updated_at: "2026-05-27T00:01:00.000Z",
            components: ["queues"],
            component_names: ["Background queues"],
            incident_updates: [
              {
                status: "investigating",
                body: "Queue delivery is slower than expected.",
                created_at: "2026-05-27T00:01:00.000Z"
              }
            ]
          }
        ])
      })
    );
    const body = await response.json() as {
      status: { indicator: string; description: string };
      components: Array<{ id: string; name: string; status: string }>;
      incidents: Array<{ component_names: string[] }>;
    };

    expect(response.status).toBe(200);
    expect(body.status.indicator).toBe("minor");
    expect(body.status.description).toBe("Partial outage detected");
    expect(body.components.find((component) => component.id === "queues")).toMatchObject({
      name: "Background queues",
      status: "partial_outage"
    });
    expect(body.incidents).toHaveLength(2);
    expect(body.incidents.flatMap((incident) => incident.component_names)).toContain(
      "Background queues"
    );
  });

  it("reports configured regional status overrides", async () => {
    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/status"),
      createTestEnv({
        W7S_STATUS_REGIONS_JSON: JSON.stringify({
          europe: "degraded_performance"
        })
      })
    );
    const body = await response.json() as {
      status: { indicator: string; description: string };
      regions: Array<{ id: string; name: string; status: string }>;
      incidents: Array<{ component_names: string[] }>;
    };

    expect(response.status).toBe(200);
    expect(body.status.indicator).toBe("minor");
    expect(body.status.description).toBe("Some systems degraded");
    expect(body.regions.find((region) => region.id === "europe")).toMatchObject({
      name: "Europe",
      status: "degraded_performance"
    });
    expect(body.incidents).toHaveLength(1);
    expect(body.incidents[0]?.component_names).toContain("Europe");
  });

  it("ignores malformed incident overrides", async () => {
    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/status"),
      createTestEnv({
        W7S_STATUS_INCIDENTS_JSON: JSON.stringify({ impact: "critical" })
      })
    );
    const body = await response.json() as {
      status: { description: string };
      incidents: unknown[];
    };

    expect(response.status).toBe(200);
    expect(body.status.description).toBe("All systems operational");
    expect(body.incidents).toHaveLength(0);
  });
});
