import { describe, expect, it, vi } from "vitest";
import { app } from "../worker";
import { createTestEnv, MemoryAnalyticsEngine } from "./mocks";
import { hashBindingToken } from "../deploy/tokens";
import {
  storeDeploymentRecord,
  storeQueueMappings,
  type DeploymentRecord
} from "../storage/deployments";
import { handleQueueBatch } from "../runtime/queueDelivery";
import { recordUsageEvent } from "../usage";
import { usageLimitPolicyKey } from "../usageLimits";

const workerRecord = (params: {
  orgSlug: string;
  repoSlug: string;
  scriptName: string;
  tokenHash?: string;
  allow?: string[];
  queues?: Array<{
    name: string;
    queueName: string;
    queueId: string;
    consumer: string;
  }>;
}): DeploymentRecord => ({
  version: 1,
  orgSlug: params.orgSlug,
  repoSlug: params.repoSlug,
  environment: "production",
  repository: `${params.orgSlug}/${params.repoSlug}`,
  branch: "main",
  commitSha: "abc",
  deployedAt: new Date().toISOString(),
  ...(params.tokenHash
    ? {
        queue: {
          binding: "W7S_QUEUE",
          tokenHash: params.tokenHash,
          allow: params.allow ?? [],
          queues: params.queues ?? []
        }
      }
    : {}),
  targets: {
    worker: {
      namespace: "w7s-isolate",
      scriptName: params.scriptName,
      entrypoint: "backend/index.js",
      compatibilityDate: "2026-05-23",
      startupTimeMs: null
    }
  }
});

describe("Queue API", () => {
  it("enqueues same-owner messages with caller metadata", async () => {
    const pushedMessages: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/queues/queue-1/messages")) {
          pushedMessages.push(JSON.parse(String(init?.body)));
          return Response.json({ success: true, result: { metadata: { metrics: {} } } });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const analytics = new MemoryAnalyticsEngine();
    const env = createTestEnv({
      W7S_ANALYTICS: analytics as unknown as AnalyticsEngineDataset,
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-123"
    });
    const token = "queue-token";
    await storeDeploymentRecord(
      env,
      workerRecord({
        orgSlug: "acme",
        repoSlug: "caller",
        scriptName: "acme--caller",
        tokenHash: await hashBindingToken(token)
      })
    );
    await storeDeploymentRecord(
      env,
      workerRecord({
        orgSlug: "acme",
        repoSlug: "target",
        scriptName: "acme--target",
        queues: [
          {
            name: "jobs",
            queueName: "w7s-production-acme-target-queue-jobs",
            queueId: "queue-1",
            consumer: "/_w7s/queues/jobs"
          }
        ],
        tokenHash: await hashBindingToken("target-token")
      })
    );

    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/queues/acme/target/jobs", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-w7s-queue-caller": "acme/caller",
          "x-w7s-queue-environment": "production"
        },
        body: JSON.stringify({ type: "work", id: "123" })
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(pushedMessages).toEqual([
      {
        body: expect.objectContaining({
          version: 1,
          body: { type: "work", id: "123" },
          caller: expect.objectContaining({
            repository: "acme/caller"
          }),
          target: expect.objectContaining({
            repository: "acme/target",
            queue: "jobs"
          })
        }),
        content_type: "json"
      }
    ]);
    expect(analytics.points).toHaveLength(1);
    expect(analytics.points[0]).toMatchObject({
      indexes: ["acme/caller"],
      blobs: [
        "queue_send",
        "acme/caller",
        "production",
        "acme",
        "caller",
        "success",
        "jobs",
        "acme/target",
        "POST"
      ],
      doubles: [1, 200, expect.any(Number)]
    });
  });

  it("rejects queue sends that exceed the caller daily limit", async () => {
    const pushedMessages: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/queues/queue-1/messages")) {
          pushedMessages.push(JSON.parse(String(init?.body)));
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-123"
    });
    const token = "queue-token";
    await storeDeploymentRecord(
      env,
      workerRecord({
        orgSlug: "acme",
        repoSlug: "caller",
        scriptName: "acme--caller",
        tokenHash: await hashBindingToken(token)
      })
    );
    await storeDeploymentRecord(
      env,
      workerRecord({
        orgSlug: "acme",
        repoSlug: "target",
        scriptName: "acme--target",
        queues: [
          {
            name: "jobs",
            queueName: "w7s-production-acme-target-queue-jobs",
            queueId: "queue-1",
            consumer: "/_w7s/queues/jobs"
          }
        ],
        tokenHash: await hashBindingToken("target-token")
      })
    );
    await env.DEPLOYMENTS_KV.put(
      usageLimitPolicyKey({
        scope: "repo",
        orgSlug: "acme",
        repoSlug: "caller"
      }),
      JSON.stringify({
        version: 1,
        metrics: {
          "queue.send": 1
        }
      })
    );
    await recordUsageEvent(env, {
      metric: "queue.send",
      repository: "acme/caller",
      environment: "production",
      orgSlug: "acme",
      repoSlug: "caller",
      outcome: "success",
      units: 1
    });

    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/queues/acme/target/jobs", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-w7s-queue-caller": "acme/caller",
          "x-w7s-queue-environment": "production"
        },
        body: "{}"
      }),
      env
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining("Daily usage limit exceeded for queue.send")
      })
    );
    expect(pushedMessages).toEqual([]);
  });

  it("rejects invalid queue caller tokens", async () => {
    const env = createTestEnv();
    await storeDeploymentRecord(
      env,
      workerRecord({
        orgSlug: "acme",
        repoSlug: "caller",
        scriptName: "acme--caller",
        tokenHash: await hashBindingToken("correct-token")
      })
    );

    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/queues/acme/target/jobs", {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-token",
          "content-type": "application/json",
          "x-w7s-queue-caller": "acme/caller",
          "x-w7s-queue-environment": "production"
        },
        body: "{}"
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it("requires target allowlists for cross-owner queue sends", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: true, result: {} }))
    );
    const token = "queue-token";
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-123"
    });
    await storeDeploymentRecord(
      env,
      workerRecord({
        orgSlug: "acme",
        repoSlug: "caller",
        scriptName: "acme--caller",
        tokenHash: await hashBindingToken(token)
      })
    );
    await storeDeploymentRecord(
      env,
      workerRecord({
        orgSlug: "tools",
        repoSlug: "target",
        scriptName: "tools--target",
        tokenHash: await hashBindingToken("target-token"),
        queues: [
          {
            name: "jobs",
            queueName: "w7s-production-tools-target-queue-jobs",
            queueId: "queue-1",
            consumer: "/_w7s/queues/jobs"
          }
        ]
      })
    );

    const request = () =>
      new Request("https://w7s.cloud/api/v1/queues/tools/target/jobs", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-w7s-queue-caller": "acme/caller",
          "x-w7s-queue-environment": "production"
        },
        body: "{}"
      });

    const denied = await app.fetch(request(), env);
    expect(denied.status).toBe(403);

    await storeDeploymentRecord(
      env,
      workerRecord({
        orgSlug: "tools",
        repoSlug: "target",
        scriptName: "tools--target",
        tokenHash: await hashBindingToken("target-token"),
        allow: ["acme/caller"],
        queues: [
          {
            name: "jobs",
            queueName: "w7s-production-tools-target-queue-jobs",
            queueId: "queue-1",
            consumer: "/_w7s/queues/jobs"
          }
        ]
      })
    );

    const allowed = await app.fetch(request(), env);
    expect(allowed.status).toBe(200);
  });
});

describe("Queue delivery", () => {
  it("dispatches queue batches to the mapped deployment consumer path", async () => {
    const calls: Array<{ scriptName: string; path: string; body: unknown }> = [];
    const analytics = new MemoryAnalyticsEngine();
    const env = createTestEnv({
      W7S_ANALYTICS: analytics as unknown as AnalyticsEngineDataset,
      DISPATCHER: {
        get: (scriptName: string) => ({
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            calls.push({
              scriptName,
              path: new URL(request.url).pathname,
              body: await request.json()
            });
            return Response.json({ ok: true });
          }
        })
      }
    });
    const record = workerRecord({
      orgSlug: "acme",
      repoSlug: "target",
      scriptName: "acme--target",
      tokenHash: await hashBindingToken("target-token"),
      queues: [
        {
          name: "jobs",
          queueName: "w7s-production-acme-target-queue-jobs",
          queueId: "queue-1",
          consumer: "/_w7s/queues/jobs"
        }
      ]
    });
    await storeDeploymentRecord(env, record);
    await storeQueueMappings(env, record, record.queue?.queues ?? []);

    await handleQueueBatch(
      {
        queue: "w7s-production-acme-target-queue-jobs",
        messages: [
          {
            id: "message-1",
            attempts: 1,
            timestamp: new Date("2026-05-24T22:00:00.000Z"),
            body: {
              version: 1,
              body: { type: "work" },
              enqueuedAt: "2026-05-24T21:59:00.000Z",
              caller: {
                repository: "acme/caller"
              }
            },
            ack: () => undefined,
            retry: () => undefined
          }
        ],
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        ackAll: () => undefined,
        retryAll: () => undefined
      } as unknown as MessageBatch,
      env
    );

    expect(calls).toEqual([
      {
        scriptName: "acme--target",
        path: "/_w7s/queues/jobs",
        body: {
          queue: "jobs",
          queueName: "w7s-production-acme-target-queue-jobs",
          messages: [
            {
              id: "message-1",
              attempts: 1,
              timestamp: "2026-05-24T22:00:00.000Z",
              enqueuedAt: "2026-05-24T21:59:00.000Z",
              caller: {
                repository: "acme/caller"
              },
              body: { type: "work" }
            }
          ]
        }
      }
    ]);
    expect(analytics.points).toHaveLength(1);
    expect(analytics.points[0]).toMatchObject({
      indexes: ["acme/target"],
      blobs: [
        "queue_delivery",
        "acme/target",
        "production",
        "acme",
        "target",
        "success",
        "jobs",
        "",
        "POST"
      ],
      doubles: [1, 200, expect.any(Number)]
    });
  });
});
