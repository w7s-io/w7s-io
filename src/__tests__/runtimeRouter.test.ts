import { describe, expect, it } from "vitest";
import { app } from "../worker";
import { createTestEnv } from "./mocks";
import { storeDeploymentRecord, storeStaticSiteManifest } from "../storage/deployments";
import type { DeploymentRecord, StaticSiteManifest } from "../storage/deployments";

describe("runtime router", () => {
  it("serves static assets from repo routes", async () => {
    const env = createTestEnv();
    await env.STATIC_ASSETS!.put("static/index.html", "<h1>App</h1>", {
      httpMetadata: {
        contentType: "text/html; charset=utf-8"
      }
    });
    const manifest: StaticSiteManifest = {
      version: 1,
      orgSlug: "w7s-io",
      repoSlug: "demo",
      environment: "production",
      assetPrefix: "static",
      deployedAt: new Date().toISOString(),
      files: {
        "index.html": {
          path: "index.html",
          r2Key: "static/index.html",
          contentType: "text/html; charset=utf-8",
          size: 12,
          etag: "etag"
        }
      },
      hasIndex: true
    };
    const manifestKey = await storeStaticSiteManifest(env, manifest);
    const record: DeploymentRecord = {
      version: 1,
      orgSlug: "w7s-io",
      repoSlug: "demo",
      environment: "production",
      repository: "w7s-io/demo",
      branch: "main",
      commitSha: "abc",
      deployedAt: new Date().toISOString(),
      targets: {
        static: {
          manifestKey,
          assetPrefix: "static",
          fileCount: 1,
          hasIndex: true
        }
      }
    };
    await storeDeploymentRecord(env, record);

    const response = await app.fetch(
      new Request("https://w7s-io.w7s.cloud/demo/", {
        headers: {
          host: "w7s-io.w7s.cloud"
        }
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("App");
  });

  it("dispatches native worker requests with repo path stripped", async () => {
    const calls: string[] = [];
    const env = createTestEnv({
      DISPATCHER: {
        get: () => ({
          fetch: async (input) => {
            const url = input instanceof Request ? input.url : String(input);
            calls.push(new URL(url).pathname);
            return new Response("native");
          }
        })
      }
    });
    await storeDeploymentRecord(env, {
      version: 1,
      orgSlug: "w7s-io",
      repoSlug: "api",
      environment: "production",
      repository: "w7s-io/api",
      branch: "main",
      commitSha: "abc",
      deployedAt: new Date().toISOString(),
      targets: {
        worker: {
          namespace: "w7s-isolate",
          scriptName: "w7s-io--api--production",
          entrypoint: "worker/index.js",
          compatibilityDate: "2026-05-23",
          startupTimeMs: null
        }
      }
    });

    const response = await app.fetch(
      new Request("https://w7s-io.w7s.cloud/api/users", {
        headers: {
          host: "w7s-io.w7s.cloud"
        }
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("native");
    expect(calls).toEqual(["/users"]);
  });
});
