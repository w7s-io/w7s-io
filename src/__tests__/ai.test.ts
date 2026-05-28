import { describe, expect, it } from "vitest";
import { app } from "../worker";
import { hashBindingToken } from "../deploy/tokens";
import { storeDeploymentRecord, type DeploymentRecord } from "../storage/deployments";
import { usageLimitPolicyKey } from "../usageLimits";
import { recordUsageEvent } from "../usage";
import { createTestEnv, MemoryAnalyticsEngine } from "./mocks";

const aiRecord = async (params: {
  orgSlug: string;
  repoSlug: string;
  token: string;
}): Promise<DeploymentRecord> => ({
  version: 1,
  orgSlug: params.orgSlug,
  repoSlug: params.repoSlug,
  environment: "production",
  repository: `${params.orgSlug}/${params.repoSlug}`,
  branch: "main",
  commitSha: "abc",
  deployedAt: new Date().toISOString(),
  ai: {
    binding: "W7S_AI",
    tokenHash: await hashBindingToken(params.token)
  },
  targets: {
    worker: {
      namespace: "w7s-isolate",
      scriptName: `${params.orgSlug}--${params.repoSlug}`,
      entrypoint: "backend/index.js",
      compatibilityDate: "2026-05-23",
      startupTimeMs: null
    }
  }
});

const aiRequest = (params: {
  token: string;
  caller?: string;
  environment?: string;
  model?: string;
  input?: Record<string, unknown>;
}) =>
  new Request("https://w7s.cloud/api/v1/ai/run", {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.token}`,
      "content-type": "application/json",
      ...(params.caller ? { "x-w7s-ai-caller": params.caller } : {}),
      ...(params.environment ? { "x-w7s-ai-environment": params.environment } : {})
    },
    body: JSON.stringify({
      model: params.model ?? "@w7s/meta/llama-3.1-8b-instruct-fp8",
      input: params.input ?? { prompt: "Tell a deployment joke." }
    })
  });

describe("AI API", () => {
  it("runs an allowed model through the W7S AI binding", async () => {
    const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
    const analytics = new MemoryAnalyticsEngine();
    const env = createTestEnv({
      W7S_ANALYTICS: analytics as unknown as AnalyticsEngineDataset,
      AI: {
        run: async (model: string, input: Record<string, unknown>) => {
          calls.push({ model, input });
          return { response: "Deployment jokes always resolve at the edge." };
        }
      } as unknown as Ai
    });
    await storeDeploymentRecord(
      env,
      await aiRecord({
        orgSlug: "acme",
        repoSlug: "jokes",
        token: "ai-token"
      })
    );

    const response = await app.fetch(aiRequest({ token: "ai-token" }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "success",
      data: {
        model: "@w7s/meta/llama-3.1-8b-instruct-fp8",
        result: {
          response: "Deployment jokes always resolve at the edge."
        }
      }
    });
    expect(calls).toEqual([
      {
        model: "@cf/meta/llama-3.1-8b-instruct-fp8",
        input: { prompt: "Tell a deployment joke." }
      }
    ]);
    expect(analytics.points[0]).toMatchObject({
      indexes: ["acme/jokes"],
      blobs: [
        "ai_run",
        "acme/jokes",
        "production",
        "acme",
        "jokes",
        "success",
        "w7s_ai",
        "@w7s/meta/llama-3.1-8b-instruct-fp8",
        "POST"
      ],
      doubles: [1, 200, expect.any(Number)]
    });
  });

  it("supports legacy caller headers when the AI token mapping is missing", async () => {
    const calls: string[] = [];
    const env = createTestEnv({
      AI: {
        run: async () => {
          calls.push("run");
          return { response: "legacy app still works" };
        }
      } as unknown as Ai
    });
    const record = await aiRecord({
      orgSlug: "acme",
      repoSlug: "jokes",
      token: "legacy-token"
    });
    await env.DEPLOYMENTS_KV.put(
      "deployment:v1:production:acme:jokes",
      JSON.stringify(record)
    );

    const response = await app.fetch(
      aiRequest({
        token: "legacy-token",
        caller: "acme/jokes",
        environment: "production"
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual(["run"]);
  });

  it("rejects invalid AI tokens", async () => {
    const env = createTestEnv({
      AI: {
        run: async () => ({ response: "unused" })
      } as unknown as Ai
    });
    await storeDeploymentRecord(
      env,
      await aiRecord({
        orgSlug: "acme",
        repoSlug: "jokes",
        token: "correct-token"
      })
    );

    const response = await app.fetch(aiRequest({ token: "wrong-token" }), env);

    expect(response.status).toBe(401);
  });

  it("enforces AI usage limits before running the model", async () => {
    const calls: string[] = [];
    const env = createTestEnv({
      AI: {
        run: async () => {
          calls.push("run");
          return { response: "unused" };
        }
      } as unknown as Ai
    });
    await storeDeploymentRecord(
      env,
      await aiRecord({
        orgSlug: "acme",
        repoSlug: "jokes",
        token: "ai-token"
      })
    );
    await env.DEPLOYMENTS_KV.put(
      usageLimitPolicyKey({
        scope: "repo",
        orgSlug: "acme",
        repoSlug: "jokes"
      }),
      JSON.stringify({
        version: 1,
        metrics: {
          "ai.run": 1
        }
      })
    );
    await recordUsageEvent(env, {
      metric: "ai.run",
      repository: "acme/jokes",
      environment: "production",
      orgSlug: "acme",
      repoSlug: "jokes",
      outcome: "success",
      units: 1
    });

    const response = await app.fetch(aiRequest({ token: "ai-token" }), env);

    expect(response.status).toBe(429);
    expect(calls).toEqual([]);
  });
});
