import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../worker";
import { createTestEnv } from "./mocks";
import { loadUsageDailyRollup, recordUsageEvent } from "../usage";

describe("usage rollups", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records daily metric rollups per repository and environment", async () => {
    const env = createTestEnv();
    const at = new Date("2026-05-26T12:00:00.000Z");

    await recordUsageEvent(env, {
      metric: "queue.delivery",
      repository: "acme/app",
      environment: "production",
      orgSlug: "acme",
      repoSlug: "app",
      outcome: "success",
      count: 3,
      units: 3,
      at
    });
    await recordUsageEvent(env, {
      metric: "queue.delivery",
      repository: "acme/app",
      environment: "production",
      orgSlug: "acme",
      repoSlug: "app",
      outcome: "error",
      count: 1,
      units: 1,
      at
    });

    await expect(
      loadUsageDailyRollup(env, {
        date: "2026-05-26",
        environment: "production",
        orgSlug: "acme",
        repoSlug: "app"
      })
    ).resolves.toEqual({
      version: 1,
      date: "2026-05-26",
      orgSlug: "acme",
      repoSlug: "app",
      environment: "production",
      repository: "acme/app",
      updatedAt: "2026-05-26T12:00:00.000Z",
      metrics: {
        "queue.delivery": {
          count: 4,
          units: 4,
          success: 3,
          error: 1,
          lastAt: "2026-05-26T12:00:00.000Z"
        }
      }
    });
  });

  it("returns usage through an authenticated GitHub repo check", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://api.github.com/repos/acme/app") {
          return Response.json({ full_name: "acme/app" });
        }
        return new Response("not found", { status: 404 });
      })
    );
    const env = createTestEnv();
    await recordUsageEvent(env, {
      metric: "workflow.create",
      repository: "acme/app",
      environment: "production",
      orgSlug: "acme",
      repoSlug: "app",
      outcome: "success",
      at: new Date("2026-05-26T12:00:00.000Z")
    });

    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/usage/acme/app?date=2026-05-26", {
        headers: {
          authorization: "Bearer github-token"
        }
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        status: "success",
        data: {
          usage: expect.objectContaining({
            date: "2026-05-26",
            repository: "acme/app",
            metrics: {
              "workflow.create": expect.objectContaining({
                count: 1,
                units: 1,
                success: 1,
                error: 0
              })
            }
          })
        }
      })
    );
  });

  it("rejects unauthorized usage requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 }))
    );
    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/usage/acme/app?date=2026-05-26", {
        headers: {
          authorization: "Bearer github-token"
        }
      }),
      createTestEnv()
    );

    expect(response.status).toBe(401);
  });
});
