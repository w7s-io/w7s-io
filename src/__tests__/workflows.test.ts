import { describe, expect, it } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { app, W7SWorkflow } from "../worker";
import { hashBindingToken } from "../deploy/tokens";
import { deploymentKey, storeDeploymentRecord, type DeploymentRecord } from "../storage/deployments";
import { createTestEnv, MemoryAnalyticsEngine, MemoryWorkflowBinding } from "./mocks";
import type { W7SWorkflowPayload } from "../env";
import { recordUsageEvent } from "../usage";
import { usageLimitPolicyKey } from "../usageLimits";

const workerRecord = (params: {
  orgSlug: string;
  repoSlug: string;
  scriptName: string;
  tokenHash?: string;
  allow?: string[];
  workflows?: Array<{
    name: string;
    path: string;
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
        workflow: {
          binding: "W7S_WORKFLOW",
          tokenHash: params.tokenHash,
          allow: params.allow ?? [],
          workflows: params.workflows ?? []
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

describe("Workflow API", () => {
  it("creates same-owner workflow instances with caller metadata", async () => {
    const workflows = new MemoryWorkflowBinding();
    const analytics = new MemoryAnalyticsEngine();
    const env = createTestEnv({
      W7S_WORKFLOWS: workflows as unknown as Workflow<W7SWorkflowPayload>,
      W7S_ANALYTICS: analytics as unknown as AnalyticsEngineDataset
    });
    const token = "workflow-token";
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
        tokenHash: await hashBindingToken("target-token"),
        workflows: [
          {
            name: "process-order",
            path: "/_w7s/workflows/process-order"
          }
        ]
      })
    );

    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/workflows/acme/target/process-order", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-w7s-workflow-instance-id": "order-123"
        },
        body: JSON.stringify({ orderId: "123" })
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data?: { instance?: { id?: string } } };
    expect(body.data?.instance?.id).toContain("order-123");
    expect(workflows.created).toHaveLength(1);
    expect(workflows.created[0]?.params).toEqual(
      expect.objectContaining({
        version: 1,
        payload: { orderId: "123" },
        caller: expect.objectContaining({
          repository: "acme/caller"
        }),
        target: expect.objectContaining({
          repository: "acme/target",
          workflow: "process-order",
          path: "/_w7s/workflows/process-order"
        })
      })
    );
    expect(analytics.points[0]).toMatchObject({
      indexes: ["acme/caller"],
      blobs: [
        "workflow_create",
        "acme/caller",
        "production",
        "acme",
        "caller",
        "success",
        "process-order",
        "acme/target",
        "POST"
      ],
      doubles: [1, 200, expect.any(Number)]
    });
  });

  it("rejects workflow creates that exceed the caller daily limit", async () => {
    const workflows = new MemoryWorkflowBinding();
    const env = createTestEnv({
      W7S_WORKFLOWS: workflows as unknown as Workflow<W7SWorkflowPayload>
    });
    const token = "workflow-token";
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
        tokenHash: await hashBindingToken("target-token"),
        workflows: [
          {
            name: "process-order",
            path: "/_w7s/workflows/process-order"
          }
        ]
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
          "workflow.create": 1
        }
      })
    );
    await recordUsageEvent(env, {
      metric: "workflow.create",
      repository: "acme/caller",
      environment: "production",
      orgSlug: "acme",
      repoSlug: "caller",
      outcome: "success",
      units: 1
    });

    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/workflows/acme/target/process-order", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: "{}"
      }),
      env
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining("Daily usage limit exceeded for workflow.create")
      })
    );
    expect(workflows.created).toEqual([]);
  });

  it("rejects workflow creates when the target has too many active instances", async () => {
    const workflows = new MemoryWorkflowBinding();
    const env = createTestEnv({
      W7S_WORKFLOWS: workflows as unknown as Workflow<W7SWorkflowPayload>,
      W7S_WORKFLOW_ACTIVE_LIMIT: "1"
    });
    const token = "workflow-token";
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
        tokenHash: await hashBindingToken("target-token"),
        workflows: [
          {
            name: "process-order",
            path: "/_w7s/workflows/process-order"
          }
        ]
      })
    );

    const request = (id: string) =>
      new Request(`https://w7s.cloud/api/v1/workflows/acme/target/process-order/${id}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-w7s-workflow-instance-id": id
        },
        body: "{}"
      });

    expect((await app.fetch(request("first"), env)).status).toBe(200);
    const response = await app.fetch(request("second"), env);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining("Active workflow limit exceeded")
      })
    );
    expect(workflows.created).toHaveLength(1);
  });

  it("returns workflow instance status", async () => {
    const workflows = new MemoryWorkflowBinding();
    workflows.statuses.set("production-acme-target-process-order-order-123", {
      status: "complete",
      output: { ok: true }
    });
    const env = createTestEnv({
      W7S_WORKFLOWS: workflows as unknown as Workflow<W7SWorkflowPayload>
    });
    const token = "workflow-token";
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
        tokenHash: await hashBindingToken("target-token"),
        workflows: [
          {
            name: "process-order",
            path: "/_w7s/workflows/process-order"
          }
        ]
      })
    );

    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/workflows/acme/target/process-order/production-acme-target-process-order-order-123", {
        headers: {
          authorization: `Bearer ${token}`
        }
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          instance: {
            id: "production-acme-target-process-order-order-123",
            status: {
              status: "complete",
              output: { ok: true }
            }
          }
        })
      })
    );
  });

  it("supports legacy caller headers when the token mapping is missing", async () => {
    const workflows = new MemoryWorkflowBinding();
    const env = createTestEnv({
      W7S_WORKFLOWS: workflows as unknown as Workflow<W7SWorkflowPayload>
    });
    const token = "legacy-token";
    const callerRecord = workerRecord({
      orgSlug: "acme",
      repoSlug: "caller",
      scriptName: "acme--caller",
      tokenHash: await hashBindingToken(token)
    });
    await env.DEPLOYMENTS_KV.put(
      deploymentKey("production", "acme", "caller"),
      JSON.stringify(callerRecord)
    );
    await storeDeploymentRecord(
      env,
      workerRecord({
        orgSlug: "acme",
        repoSlug: "target",
        scriptName: "acme--target",
        tokenHash: await hashBindingToken("target-token"),
        workflows: [
          {
            name: "process-order",
            path: "/_w7s/workflows/process-order"
          }
        ]
      })
    );

    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/workflows/acme/target/process-order", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-w7s-workflow-caller": "acme/caller",
          "x-w7s-workflow-environment": "production"
        },
        body: "{}"
      }),
      env
    );

    expect(response.status).toBe(200);
  });
});

describe("Workflow delivery", () => {
  it("dispatches workflow instances to the target consumer path", async () => {
    const calls: Array<{ scriptName: string; path: string; headers: Record<string, string>; body: unknown }> = [];
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
              headers: {
                workflow: request.headers.get("x-w7s-workflow") ?? "",
                name: request.headers.get("x-w7s-workflow-name") ?? "",
                instance: request.headers.get("x-w7s-workflow-instance") ?? ""
              },
              body: await request.json()
            });
            return Response.json({ processed: true });
          }
        })
      }
    });
    await storeDeploymentRecord(
      env,
      workerRecord({
        orgSlug: "acme",
        repoSlug: "target",
        scriptName: "acme--target",
        tokenHash: await hashBindingToken("target-token"),
        workflows: [
          {
            name: "process-order",
            path: "/_w7s/workflows/process-order"
          }
        ]
      })
    );
    const workflow = new W7SWorkflow({} as ExecutionContext, env);
    const step = {
      do: async (_name: string, _config: unknown, callback: () => Promise<unknown>) => callback()
    } as unknown as WorkflowStep;

    const output = await workflow.run(
      {
        instanceId: "instance-1",
        timestamp: new Date("2026-05-26T00:00:00.000Z"),
        payload: {
          version: 1,
          createdAt: "2026-05-26T00:00:00.000Z",
          payload: { orderId: "123" },
          caller: {
            orgSlug: "acme",
            repoSlug: "caller",
            repository: "acme/caller",
            environment: "production"
          },
          target: {
            orgSlug: "acme",
            repoSlug: "target",
            repository: "acme/target",
            environment: "production",
            workflow: "process-order",
            path: "/_w7s/workflows/process-order"
          }
        }
      },
      step
    );

    expect(output).toEqual({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ processed: true })
    });
    expect(calls).toEqual([
      {
        scriptName: "acme--target",
        path: "/_w7s/workflows/process-order",
        headers: {
          workflow: "1",
          name: "process-order",
          instance: "instance-1"
        },
        body: {
          workflow: "process-order",
          workflowName: "process-order",
          instanceId: "instance-1",
          createdAt: "2026-05-26T00:00:00.000Z",
          caller: expect.objectContaining({
            repository: "acme/caller"
          }),
          target: expect.objectContaining({
            repository: "acme/target"
          }),
          payload: { orderId: "123" }
        }
      }
    ]);
    expect(analytics.points[0]).toMatchObject({
      indexes: ["acme/target"],
      blobs: [
        "workflow_delivery",
        "acme/target",
        "production",
        "acme",
        "target",
        "success",
        "process-order",
        "acme/caller",
        "POST"
      ],
      doubles: [1, 200, expect.any(Number)]
    });
  });
});
