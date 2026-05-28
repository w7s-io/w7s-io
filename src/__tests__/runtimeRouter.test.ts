import { describe, expect, it } from "vitest";
import { app } from "../worker";
import { createTestEnv, MemoryAnalyticsEngine } from "./mocks";
import {
  storeCustomDomainMappings,
  storeDeploymentRecord,
  storeStaticSiteManifest
} from "../storage/deployments";
import type { DeploymentRecord, StaticSiteManifest } from "../storage/deployments";
import { loadAppLimitState, suspendAppForLimits } from "../appLimits";
import { recordUsageEvent } from "../usage";
import { usageLimitPolicyKey } from "../usageLimits";

const storeStaticDeployment = async (
  env: ReturnType<typeof createTestEnv>,
  params: {
    orgSlug?: string;
    repoSlug?: string;
    environment?: string;
    files?: Record<string, { body: string; contentType?: string }>;
  } = {}
) => {
  const orgSlug = params.orgSlug ?? "w7s-io";
  const repoSlug = params.repoSlug ?? "demo";
  const environment = params.environment ?? "production";
  const files = params.files ?? {
    "index.html": {
      body: "<h1>App</h1>",
      contentType: "text/html; charset=utf-8"
    }
  };
  const manifestFiles: StaticSiteManifest["files"] = {};
  for (const [path, file] of Object.entries(files)) {
    const r2Key = `static/${orgSlug}/${repoSlug}/${path}`;
    await env.STATIC_ASSETS!.put(r2Key, file.body, {
      httpMetadata: {
        contentType: file.contentType ?? "text/plain; charset=utf-8"
      }
    });
    manifestFiles[path] = {
      path,
      r2Key,
      contentType: file.contentType ?? "text/plain; charset=utf-8",
      size: file.body.length,
      etag: "etag"
    };
  }
  const manifest: StaticSiteManifest = {
    version: 1,
    orgSlug,
    repoSlug,
    environment,
    assetPrefix: "static",
    deployedAt: new Date().toISOString(),
    files: manifestFiles,
    hasIndex: Boolean(manifestFiles["index.html"])
  };
  const manifestKey = await storeStaticSiteManifest(env, manifest);
  const record: DeploymentRecord = {
    version: 1,
    orgSlug,
    repoSlug,
    environment,
    repository: `${orgSlug}/${repoSlug}`,
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
  return record;
};

const storeStaticDemoDeployment = async (env: ReturnType<typeof createTestEnv>) =>
  storeStaticDeployment(env);

describe("runtime router", () => {
  it("serves static assets from repo routes", async () => {
    const analytics = new MemoryAnalyticsEngine();
    const env = createTestEnv({
      W7S_ANALYTICS: analytics as unknown as AnalyticsEngineDataset
    });
    await storeStaticDemoDeployment(env);

    const response = await app.fetch(
      new Request("https://w7s-io.w7s.cloud/demo/", {
        headers: {
          host: "w7s-io.w7s.cloud"
        }
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toContain("App");
    expect(analytics.points).toHaveLength(1);
    expect(analytics.points[0]).toMatchObject({
      indexes: ["w7s-io/demo"],
      blobs: [
        "runtime_request",
        "w7s-io/demo",
        "production",
        "w7s-io",
        "demo",
        "success",
        "static_exact:repo-prefix",
        "",
        "GET"
      ],
      doubles: [1, 200, expect.any(Number)]
    });
  });

  it("records and enforces runtime request limits", async () => {
    const env = createTestEnv();
    const record = await storeStaticDemoDeployment(env);
    await storeDeploymentRecord(env, {
      ...record,
      targets: {
        ...record.targets,
        worker: {
          namespace: "w7s-isolate",
          scriptName: "w7s-io--demo--production",
          entrypoint: "backend/index.js",
          compatibilityDate: "2026-05-23",
          startupTimeMs: null
        }
      }
    });
    await env.DEPLOYMENTS_KV.put(
      usageLimitPolicyKey({
        scope: "repo",
        orgSlug: "w7s-io",
        repoSlug: "demo"
      }),
      JSON.stringify({
        version: 1,
        metrics: {
          "runtime.request": 1
        }
      })
    );
    await recordUsageEvent(env, {
      metric: "runtime.request",
      repository: "w7s-io/demo",
      environment: "production",
      orgSlug: "w7s-io",
      repoSlug: "demo",
      units: 1
    });

    const response = await app.fetch(
      new Request("https://w7s-io.w7s.cloud/demo/", {
        headers: {
          host: "w7s-io.w7s.cloud"
        }
      }),
      env
    );

    expect(response.status).toBe(200);

    const blocked = await app.fetch(
      new Request("https://w7s-io.w7s.cloud/demo/", {
        headers: {
          host: "w7s-io.w7s.cloud"
        }
      }),
      env
    );

    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining("runtime.request")
      })
    );
  });

  it("serves static-only requests while scheduling daily cap suspension", async () => {
    const env = createTestEnv();
    await storeStaticDemoDeployment(env);
    await env.DEPLOYMENTS_KV.put(
      usageLimitPolicyKey({
        scope: "repo",
        orgSlug: "w7s-io",
        repoSlug: "demo"
      }),
      JSON.stringify({
        version: 1,
        metrics: {
          "runtime.request": 1
        }
      })
    );

    const first = await app.fetch(
      new Request("https://w7s-io.w7s.cloud/demo/", {
        headers: {
          host: "w7s-io.w7s.cloud"
        }
      }),
      env
    );
    expect(first.status).toBe(200);

    const second = await app.fetch(
      new Request("https://w7s-io.w7s.cloud/demo/", {
        headers: {
          host: "w7s-io.w7s.cloud",
          accept: "application/json"
        }
      }),
      env
    );
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining("runtime.request")
      })
    );
  });

  it("blocks suspended apps before serving runtime traffic", async () => {
    const env = createTestEnv();
    await storeStaticDemoDeployment(env);
    await suspendAppForLimits(env, {
      environment: "production",
      orgSlug: "w7s-io",
      repoSlug: "demo",
      reason: "W7S free-tier limit exceeded for d1.rows_read.",
      metrics: [
        {
          metric: "d1.rows_read",
          status: "exceeded",
          used: 100001,
          limit: 100000,
          remaining: 0,
          message: "d1.rows_read exceeded the daily limit."
        }
      ]
    });

    const response = await app.fetch(
      new Request("https://w7s-io.w7s.cloud/demo/", {
        headers: {
          host: "w7s-io.w7s.cloud",
          accept: "application/json"
        }
      }),
      env
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          appLimitState: expect.objectContaining({
            status: "suspended",
            reason: "W7S free-tier limit exceeded for d1.rows_read."
          })
        })
      })
    );
  });

  it("expires retry-window app suspensions without waiting for UTC reset", async () => {
    const env = createTestEnv();
    await suspendAppForLimits(env, {
      environment: "production",
      orgSlug: "w7s-io",
      repoSlug: "demo",
      reason: "Short-window usage limit exceeded for runtime.request.",
      resumeAfter: new Date("2026-05-26T12:05:00.000Z"),
      metrics: [
        {
          metric: "runtime.request",
          status: "exceeded",
          used: 300,
          limit: 300,
          remaining: 0,
          message: "Short-window usage limit exceeded for runtime.request."
        }
      ],
      at: new Date("2026-05-26T12:00:00.000Z")
    });

    await expect(
      loadAppLimitState(env, {
        environment: "production",
        orgSlug: "w7s-io",
        repoSlug: "demo",
        at: new Date("2026-05-26T12:04:59.000Z")
      })
    ).resolves.toEqual(expect.objectContaining({
      status: "suspended",
      resumeAfter: "2026-05-26T12:05:00.000Z"
    }));
    await expect(
      loadAppLimitState(env, {
        environment: "production",
        orgSlug: "w7s-io",
        repoSlug: "demo",
        at: new Date("2026-05-26T12:05:00.000Z")
      })
    ).resolves.toBeNull();
  });

  it("redirects static repo root routes to a directory path", async () => {
    const env = createTestEnv();
    await storeStaticDemoDeployment(env);

    const response = await app.fetch(
      new Request("https://w7s-io.w7s.cloud/demo?from=test", {
        headers: {
          host: "w7s-io.w7s.cloud"
        },
        redirect: "manual"
      }),
      env
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://w7s-io.w7s.cloud/demo/?from=test");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("serves branch environments from branch-prefixed hosts", async () => {
    const env = createTestEnv();
    await storeStaticDeployment(env, {
      environment: "feature-login",
      files: {
        "index.html": {
          body: "<h1>Feature App</h1>",
          contentType: "text/html; charset=utf-8"
        }
      }
    });

    const response = await app.fetch(
      new Request("https://feature-login--w7s-io.w7s.cloud/demo/", {
        headers: {
          host: "feature-login--w7s-io.w7s.cloud"
        }
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Feature App");
  });

  it("serves nested static directory indexes from repo routes", async () => {
    const env = createTestEnv();
    await storeStaticDeployment(env, {
      orgSlug: "w7s-io",
      repoSlug: "docs",
      files: {
        "index.html": {
          body: "<h1>Docs</h1>",
          contentType: "text/html; charset=utf-8"
        },
        "deploy-from-github": {
          body: "",
          contentType: "application/octet-stream"
        },
        "deploy-from-github/index.html": {
          body: "<h1>Deploy From GitHub</h1>",
          contentType: "text/html; charset=utf-8"
        }
      }
    });

    const response = await app.fetch(
      new Request("https://w7s-io.w7s.cloud/docs/deploy-from-github/", {
        headers: {
          host: "w7s-io.w7s.cloud"
        }
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toContain("Deploy From GitHub");
  });

  it("shows contextual deploy help for empty org root hosts", async () => {
    const env = createTestEnv();

    const response = await app.fetch(
      new Request("https://sadasant.w7s.cloud/", {
        headers: {
          host: "sadasant.w7s.cloud"
        }
      }),
      env
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("<h1>The Cloud that <em>just works</em>.</h1>");
    expect(body).toContain("Deploy target");
    expect(body).toContain("<h2>Nothing is deployed here yet.</h2>");
    expect(body).toContain("Nothing is deployed at <code>https://sadasant.w7s.cloud/</code> yet.");
    expect(body).toContain("https://github.com/sadasant/sadasant");
    expect(body).toContain("<code>sadasant/sadasant</code>");
    expect(body).toContain("https://sadasant.w7s.cloud/");
    expect(body).toContain("W7S uses one subdomain per GitHub owner");
    expect(body).toContain("every other repo deploys under <code>/repo-name/</code>");
    expect(body).toContain("same-name repo convention");
    expect(body).toContain("Every other repo owned by <code>sadasant</code> deploys on this same subdomain");
    expect(body).toContain("<code>https://sadasant.w7s.cloud/repo-name/</code>");
    expect(body).toContain("<code>sadasant/repo-name</code>");
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
    expect(body).not.toContain("example-fullstack-ts");
  });

  it("shows contextual deploy help for missing repo-prefixed deployments", async () => {
    const env = createTestEnv();

    const response = await app.fetch(
      new Request("https://sadasant.w7s.cloud/missing-repo/", {
        headers: {
          host: "sadasant.w7s.cloud"
        }
      }),
      env
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("<h1>The Cloud that <em>just works</em>.</h1>");
    expect(body).toContain("Deploy target");
    expect(body).toContain("<h2>Nothing is deployed here yet.</h2>");
    expect(body).toContain("Nothing is deployed at <code>https://sadasant.w7s.cloud/missing-repo/</code> yet.");
    expect(body).toContain("https://github.com/sadasant/missing-repo");
    expect(body).toContain("<code>sadasant/missing-repo</code>");
    expect(body).toContain("https://sadasant.w7s.cloud/missing-repo/");
    expect(body).toContain("W7S uses one subdomain per GitHub owner");
    expect(body).toContain("every other repo deploys under <code>/repo-name/</code>");
    expect(body).toContain("w7s-io/w7s-cloud@v1");
    expect(body).toContain("usage-check-only");
    expect(body).not.toContain("same-name repo convention");
  });

  it("serves same-name repo static deployments from the org root", async () => {
    const env = createTestEnv();
    await storeStaticDeployment(env, {
      orgSlug: "guerrerocarlos",
      repoSlug: "guerrerocarlos",
      files: {
        "index.html": {
          body: "<h1>Root App</h1>",
          contentType: "text/html; charset=utf-8"
        },
        "assets/app.js": {
          body: "console.log('root')",
          contentType: "application/javascript; charset=utf-8"
        }
      }
    });

    const rootResponse = await app.fetch(
      new Request("https://guerrerocarlos.w7s.cloud/", {
        headers: {
          host: "guerrerocarlos.w7s.cloud"
        }
      }),
      env
    );
    const assetResponse = await app.fetch(
      new Request("https://guerrerocarlos.w7s.cloud/assets/app.js", {
        headers: {
          host: "guerrerocarlos.w7s.cloud"
        }
      }),
      env
    );

    expect(rootResponse.status).toBe(200);
    expect(await rootResponse.text()).toContain("Root App");
    expect(assetResponse.status).toBe(200);
    expect(await assetResponse.text()).toContain("root");
  });

  it("keeps repo-prefixed deployments ahead of the org root app", async () => {
    const env = createTestEnv();
    await storeStaticDeployment(env, {
      orgSlug: "guerrerocarlos",
      repoSlug: "guerrerocarlos",
      files: {
        "index.html": {
          body: "<h1>Root App</h1>",
          contentType: "text/html; charset=utf-8"
        }
      }
    });
    await storeStaticDeployment(env, {
      orgSlug: "guerrerocarlos",
      repoSlug: "w7s-io-demo",
      files: {
        "index.html": {
          body: "<h1>Demo App</h1>",
          contentType: "text/html; charset=utf-8"
        }
      }
    });

    const response = await app.fetch(
      new Request("https://guerrerocarlos.w7s.cloud/w7s-io-demo/", {
        headers: {
          host: "guerrerocarlos.w7s.cloud"
        }
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Demo App");
  });

  it("serves static deployments from custom domain mappings", async () => {
    const env = createTestEnv();
    const record = await storeStaticDeployment(env, {
      orgSlug: "guerrerocarlos",
      repoSlug: "whereis",
      files: {
        "index.html": {
          body: "<h1>Where is Carlos?</h1>",
          contentType: "text/html; charset=utf-8"
        },
        "assets/app.js": {
          body: "console.log('whereis')",
          contentType: "application/javascript; charset=utf-8"
        }
      }
    });
    await storeCustomDomainMappings(env, record, ["whereis.carlosguerrero.com"]);

    const rootResponse = await app.fetch(
      new Request("https://whereis.carlosguerrero.com/", {
        headers: {
          host: "whereis.carlosguerrero.com"
        }
      }),
      env
    );
    const assetResponse = await app.fetch(
      new Request("https://whereis.carlosguerrero.com/assets/app.js", {
        headers: {
          host: "whereis.carlosguerrero.com"
        }
      }),
      env
    );

    expect(rootResponse.status).toBe(200);
    expect(rootResponse.headers.get("cache-control")).toBe("no-cache");
    expect(await rootResponse.text()).toContain("Where is Carlos?");
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await assetResponse.text()).toContain("whereis");
  });

  it("lets custom-domain worker redirects run before exact static assets", async () => {
    const calls: string[] = [];
    const redirectModes: string[] = [];
    const env = createTestEnv({
      DISPATCHER: {
        get: () => ({
          fetch: async (input) => {
            const request = input instanceof Request ? input : new Request(input);
            calls.push(new URL(request.url).pathname);
            redirectModes.push(request.redirect);
            return Response.redirect("https://community.w7s.io/docs/", 308);
          }
        })
      }
    });
    const record = await storeStaticDeployment(env, {
      orgSlug: "w7s-io",
      repoSlug: "docs",
      files: {
        "index.html": {
          body: "<h1>Docs</h1>",
          contentType: "text/html; charset=utf-8"
        }
      }
    });
    const fullstackRecord: DeploymentRecord = {
      ...record,
      targets: {
        ...record.targets,
        worker: {
          namespace: "w7s-isolate",
          scriptName: "w7s-io--docs--production",
          entrypoint: "backend/index.ts",
          compatibilityDate: "2026-05-23",
          startupTimeMs: null
        }
      }
    };
    await storeDeploymentRecord(env, fullstackRecord);
    await storeCustomDomainMappings(env, fullstackRecord, ["w7s.io"]);

    const response = await app.fetch(
      new Request("https://w7s.io/", {
        headers: {
          host: "w7s.io"
        },
        redirect: "manual"
      }),
      env
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://community.w7s.io/docs/");
    expect(calls).toEqual(["/"]);
    expect(redirectModes).toEqual(["manual"]);
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

  it("dispatches same-name repo native worker requests from the org root", async () => {
    const calls: string[] = [];
    const repoHeaders: string[] = [];
    const env = createTestEnv({
      DISPATCHER: {
        get: () => ({
          fetch: async (input) => {
            const request = input instanceof Request ? input : new Request(input);
            calls.push(new URL(request.url).pathname);
            repoHeaders.push(request.headers.get("x-w7s-repo-slug") ?? "");
            return new Response("root native");
          }
        })
      }
    });
    await storeDeploymentRecord(env, {
      version: 1,
      orgSlug: "guerrerocarlos",
      repoSlug: "guerrerocarlos",
      environment: "production",
      repository: "guerrerocarlos/guerrerocarlos",
      branch: "main",
      commitSha: "abc",
      deployedAt: new Date().toISOString(),
      targets: {
        worker: {
          namespace: "w7s-isolate",
          scriptName: "guerrerocarlos--guerrerocarlos--production",
          entrypoint: "backend/index.js",
          compatibilityDate: "2026-05-23",
          startupTimeMs: null
        }
      }
    });

    const response = await app.fetch(
      new Request("https://guerrerocarlos.w7s.cloud/api/status", {
        headers: {
          host: "guerrerocarlos.w7s.cloud"
        }
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("root native");
    expect(calls).toEqual(["/api/status"]);
    expect(repoHeaders).toEqual(["guerrerocarlos"]);
  });
});
