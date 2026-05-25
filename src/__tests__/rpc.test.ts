import { describe, expect, it } from "vitest";
import { app } from "../worker";
import { createTestEnv, MemoryAnalyticsEngine } from "./mocks";
import { hashRpcToken } from "../deploy/rpcBindings";
import { storeDeploymentRecord, type DeploymentRecord } from "../storage/deployments";

const workerRecord = (params: {
  orgSlug: string;
  repoSlug: string;
  scriptName: string;
  tokenHash?: string;
  allow?: string[];
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
        rpc: {
          binding: "W7S_RPC",
          tokenHash: params.tokenHash,
          allow: params.allow ?? []
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

describe("RPC API", () => {
  it("dispatches same-owner backend calls with caller identity headers", async () => {
    const calls: string[] = [];
    const analytics = new MemoryAnalyticsEngine();
    const env = createTestEnv({
      W7S_ANALYTICS: analytics as unknown as AnalyticsEngineDataset,
      DISPATCHER: {
        get: (scriptName: string) => ({
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            calls.push(scriptName);
            return Response.json({
              path: new URL(request.url).pathname,
              query: new URL(request.url).search,
              body: await request.text(),
              authorization: request.headers.get("authorization"),
              caller: request.headers.get("x-w7s-rpc-caller-repository")
            });
          }
        })
      }
    });
    const token = "caller-token";
    await storeDeploymentRecord(
      env,
      workerRecord({
        orgSlug: "acme",
        repoSlug: "caller",
        scriptName: "acme--caller",
        tokenHash: await hashRpcToken(token)
      })
    );
    await storeDeploymentRecord(
      env,
      workerRecord({
        orgSlug: "acme",
        repoSlug: "target",
        scriptName: "acme--target"
      })
    );

    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/rpc/acme/target/do-work?ok=1", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-w7s-rpc-caller": "acme/caller",
          "x-w7s-rpc-environment": "production"
        },
        body: "payload"
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      path: "/do-work",
      query: "?ok=1",
      body: "payload",
      authorization: null,
      caller: "acme/caller"
    });
    expect(calls[0]).toBe("acme--target");
    expect(analytics.points).toHaveLength(1);
    expect(analytics.points[0]).toMatchObject({
      indexes: ["acme/caller"],
      blobs: [
        "rpc",
        "acme/caller",
        "production",
        "acme",
        "caller",
        "success",
        "dispatch",
        "acme/target",
        "POST"
      ],
      doubles: [1, 200, expect.any(Number)]
    });
  });

  it("rejects invalid caller tokens", async () => {
    const env = createTestEnv();
    await storeDeploymentRecord(
      env,
      workerRecord({
        orgSlug: "acme",
        repoSlug: "caller",
        scriptName: "acme--caller",
        tokenHash: await hashRpcToken("correct-token")
      })
    );

    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/rpc/acme/target/", {
        headers: {
          authorization: "Bearer wrong-token",
          "x-w7s-rpc-caller": "acme/caller",
          "x-w7s-rpc-environment": "production"
        }
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it("requires target allowlists for cross-owner RPC", async () => {
    const env = createTestEnv({
      DISPATCHER: {
        get: () => ({
          fetch: async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok")
        })
      }
    });
    const token = "caller-token";
    await storeDeploymentRecord(
      env,
      workerRecord({
        orgSlug: "acme",
        repoSlug: "caller",
        scriptName: "acme--caller",
        tokenHash: await hashRpcToken(token)
      })
    );
    await storeDeploymentRecord(
      env,
      workerRecord({
        orgSlug: "tools",
        repoSlug: "target",
        scriptName: "tools--target",
        tokenHash: await hashRpcToken("target-token")
      })
    );

    const denied = await app.fetch(
      new Request("https://w7s.cloud/api/v1/rpc/tools/target/", {
        headers: {
          authorization: `Bearer ${token}`,
          "x-w7s-rpc-caller": "acme/caller",
          "x-w7s-rpc-environment": "production"
        }
      }),
      env
    );
    expect(denied.status).toBe(403);

    await storeDeploymentRecord(
      env,
      workerRecord({
        orgSlug: "tools",
        repoSlug: "target",
        scriptName: "tools--target",
        tokenHash: await hashRpcToken("target-token"),
        allow: ["acme/caller"]
      })
    );

    const allowed = await app.fetch(
      new Request("https://w7s.cloud/api/v1/rpc/tools/target/", {
        headers: {
          authorization: `Bearer ${token}`,
          "x-w7s-rpc-caller": "acme/caller",
          "x-w7s-rpc-environment": "production"
        }
      }),
      env
    );
    expect(allowed.status).toBe(200);
  });
});
