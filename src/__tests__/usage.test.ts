import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../worker";
import { createTestEnv } from "./mocks";
import { loadUsageDailyRollup, recordUsageEvent } from "../usage";
import {
  checkUsageLimit,
  evaluateUsageLimits,
  loadEffectiveUsageLimitPolicies,
  usageLimitPolicyKey
} from "../usageLimits";

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
          }),
          limits: expect.objectContaining({
            mode: "warn",
            metrics: expect.objectContaining({
              "workflow.create": expect.objectContaining({
                used: 1,
                limit: 10000,
                status: "ok",
                source: "default"
              })
            }),
            warnings: []
          }),
          policy: expect.objectContaining({
            policy: expect.objectContaining({
              "workflow.create": expect.objectContaining({
                dailyUnits: 10000,
                source: "default"
              })
            })
          }),
          warnings: []
        }
      })
    );
  });

  it("layers platform-owned limit policy overrides", async () => {
    const env = createTestEnv();
    await env.DEPLOYMENTS_KV.put(
      usageLimitPolicyKey({
        scope: "owner",
        orgSlug: "acme"
      }),
      JSON.stringify({
        version: 1,
        metrics: {
          "workflow.create": { dailyUnits: 50 },
          "queue.send": 10,
          "not.real": 1
        }
      })
    );
    await env.DEPLOYMENTS_KV.put(
      usageLimitPolicyKey({
        scope: "repo_environment",
        environment: "production",
        orgSlug: "acme",
        repoSlug: "app"
      }),
      JSON.stringify({
        version: 1,
        metrics: {
          "workflow.create": { warningThreshold: 0.5 }
        }
      })
    );

    const limits = await loadEffectiveUsageLimitPolicies(env, {
      environment: "production",
      orgSlug: "acme",
      repoSlug: "app"
    });

    expect(limits.policy["workflow.create"]).toEqual(
      expect.objectContaining({
        dailyUnits: 50,
        warningThreshold: 0.5,
        source: "repo_environment"
      })
    );
    expect(limits.policy["queue.send"]).toEqual(
      expect.objectContaining({
        dailyUnits: 10,
        source: "owner"
      })
    );
    expect(limits.policy["not.real"]).toBeUndefined();
    expect(limits.lookups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "owner",
          found: true,
          metrics: ["workflow.create", "queue.send"]
        }),
        expect.objectContaining({
          scope: "repo_environment",
          found: true,
          metrics: ["workflow.create"]
        })
      ])
    );
  });

  it("returns effective limits through an authenticated GitHub repo check", async () => {
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
    await env.DEPLOYMENTS_KV.put(
      usageLimitPolicyKey({
        scope: "repo",
        orgSlug: "acme",
        repoSlug: "app"
      }),
      JSON.stringify({
        version: 1,
        metrics: {
          "workflow.create": {
            dailyUnits: 25,
            warningThreshold: 0.6
          }
        }
      })
    );

    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/limits/acme/app", {
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
          limits: expect.objectContaining({
            repository: "acme/app",
            policy: expect.objectContaining({
              "workflow.create": expect.objectContaining({
                dailyUnits: 25,
                warningThreshold: 0.6,
                source: "repo"
              })
            })
          })
        }
      })
    );
  });

  it("evaluates usage warnings against effective policy overrides", async () => {
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
    await env.DEPLOYMENTS_KV.put(
      usageLimitPolicyKey({
        scope: "repo",
        orgSlug: "acme",
        repoSlug: "app"
      }),
      JSON.stringify({
        version: 1,
        metrics: {
          "workflow.create": {
            dailyUnits: 10,
            warningThreshold: 0.5
          }
        }
      })
    );
    await recordUsageEvent(env, {
      metric: "workflow.create",
      repository: "acme/app",
      environment: "production",
      orgSlug: "acme",
      repoSlug: "app",
      outcome: "success",
      count: 6,
      units: 6,
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
        data: expect.objectContaining({
          limits: expect.objectContaining({
            metrics: expect.objectContaining({
              "workflow.create": expect.objectContaining({
                used: 6,
                limit: 10,
                status: "warning",
                source: "repo"
              })
            })
          }),
          warnings: [
            expect.objectContaining({
              metric: "workflow.create",
              status: "warning"
            })
          ]
        })
      })
    );
  });

  it("reports whether a future usage event would exceed the effective policy", async () => {
    const env = createTestEnv();
    await env.DEPLOYMENTS_KV.put(
      usageLimitPolicyKey({
        scope: "repo",
        orgSlug: "acme",
        repoSlug: "app"
      }),
      JSON.stringify({
        version: 1,
        metrics: {
          "workflow.create": {
            dailyUnits: 10,
            warningThreshold: 0.5
          }
        }
      })
    );
    await recordUsageEvent(env, {
      metric: "workflow.create",
      repository: "acme/app",
      environment: "production",
      orgSlug: "acme",
      repoSlug: "app",
      outcome: "success",
      count: 8,
      units: 8,
      at: new Date("2026-05-26T12:00:00.000Z")
    });

    await expect(
      checkUsageLimit(env, {
        metric: "workflow.create",
        environment: "production",
        orgSlug: "acme",
        repoSlug: "app",
        units: 3,
        at: new Date("2026-05-26T12:30:00.000Z")
      })
    ).resolves.toEqual(
      expect.objectContaining({
        mode: "report",
        enforcement: "off",
        metric: "workflow.create",
        used: 8,
        requestedUnits: 3,
        projectedUnits: 11,
        limit: 10,
        status: "warning",
        projectedStatus: "exceeded",
        wouldBlock: true,
        source: "repo"
      })
    );
  });

  it("returns null when checking an unknown usage metric", async () => {
    await expect(
      checkUsageLimit(createTestEnv(), {
        metric: "unknown.metric",
        environment: "production",
        orgSlug: "acme",
        repoSlug: "app"
      })
    ).resolves.toBeNull();
  });

  it("evaluates soft limit warnings from usage units", () => {
    const limits = evaluateUsageLimits({
      metrics: {
        "workflow.create": {
          count: 9000,
          units: 9000,
          success: 9000,
          error: 0,
          lastAt: "2026-05-26T12:00:00.000Z"
        },
        "queue.delivery": {
          count: 1,
          units: 100001,
          success: 1,
          error: 0,
          lastAt: "2026-05-26T12:00:00.000Z"
        }
      }
    });

    expect(limits).toEqual(
      expect.objectContaining({
        mode: "warn",
        metrics: expect.objectContaining({
          "workflow.create": expect.objectContaining({
            used: 9000,
            limit: 10000,
            remaining: 1000,
            usageRatio: 0.9,
            status: "warning"
          }),
          "queue.delivery": expect.objectContaining({
            used: 100001,
            limit: 100000,
            remaining: 0,
            status: "exceeded"
          })
        }),
        warnings: [
          expect.objectContaining({
            metric: "queue.delivery",
            status: "exceeded"
          }),
          expect.objectContaining({
            metric: "workflow.create",
            status: "warning"
          })
        ]
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
