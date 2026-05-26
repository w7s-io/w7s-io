import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupPlatformState } from "../cleanup";
import {
  storeDeploymentRecord,
  storeStaticSiteManifest,
  workerScriptMappingKey,
  type DeploymentRecord,
  type StaticSiteManifest,
  type WorkerScriptMapping
} from "../storage/deployments";
import { createTestEnv } from "./mocks";

const deployment = (scriptName: string, manifestKey?: string): DeploymentRecord => ({
  version: 1,
  orgSlug: "acme",
  repoSlug: "app",
  environment: "production",
  repository: "acme/app",
  branch: "main",
  commitSha: "new",
  deployedAt: "2026-05-26T12:00:00.000Z",
  targets: {
    worker: {
      namespace: "w7s-isolate",
      scriptName,
      entrypoint: "backend/index.ts",
      compatibilityDate: "2026-05-23",
      startupTimeMs: 0
    },
    ...(manifestKey
      ? {
          static: {
            manifestKey,
            assetPrefix: "static/current",
            fileCount: 1,
            hasIndex: true
          }
        }
      : {})
  }
});

const manifest = (assetPrefix: string, deployedAt: string): StaticSiteManifest => ({
  version: 1,
  orgSlug: "acme",
  repoSlug: "app",
  environment: "production",
  assetPrefix,
  deployedAt,
  hasIndex: true,
  files: {
    "index.html": {
      path: "index.html",
      r2Key: `${assetPrefix}/index.html`,
      contentType: "text/html; charset=utf-8",
      size: 10,
      etag: "etag"
    }
  }
});

describe("platform cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes stale static manifests, stale script mappings, expired limits, and old usage records", async () => {
    const deletedScripts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "DELETE" && url.includes("/workers/dispatch/namespaces/w7s-isolate/scripts/")) {
          deletedScripts.push(decodeURIComponent(url.split("/scripts/")[1] ?? ""));
          return Response.json({ success: true, result: {} });
        }
        return Response.json({ success: true, result: {} });
      })
    );

    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-123",
      W7S_STATIC_RETENTION_DAYS: "7",
      W7S_USAGE_RETENTION_DAYS: "7",
      W7S_WORKER_SCRIPT_RETENTION_DAYS: "7"
    });
    const oldManifest = manifest("static/old", "2026-05-01T00:00:00.000Z");
    const currentManifest = manifest("static/current", "2026-05-26T12:00:00.000Z");
    const oldManifestKey = await storeStaticSiteManifest(env, oldManifest);
    const currentManifestKey = await storeStaticSiteManifest(env, currentManifest);
    await env.STATIC_ASSETS!.put("static/old/index.html", "old");
    await env.STATIC_ASSETS!.put("static/current/index.html", "current");
    await storeDeploymentRecord(env, deployment("current-script", currentManifestKey));
    await env.DEPLOYMENTS_KV.put(
      workerScriptMappingKey("old-script"),
      JSON.stringify({
        version: 1,
        scriptName: "old-script",
        orgSlug: "acme",
        repoSlug: "app",
        environment: "production",
        repository: "acme/app",
        branch: "main",
        commitSha: "old",
        deployedAt: "2026-05-01T00:00:00.000Z"
      } satisfies WorkerScriptMapping)
    );
    await env.DEPLOYMENTS_KV.put(
      "app_limit_state:v1:production:acme:app",
      JSON.stringify({
        version: 1,
        status: "suspended",
        resumeAfter: "2026-05-02T00:00:00.000Z"
      })
    );
    await env.DEPLOYMENTS_KV.put(
      "usage_daily:v1:2026-05-01:production:acme:app",
      JSON.stringify({ version: 1, date: "2026-05-01", metrics: {} })
    );

    const result = await cleanupPlatformState(env, new Date("2026-05-26T13:00:00.000Z"));

    expect(result).toEqual(
      expect.objectContaining({
        cleaned: true,
        staticManifests: 1,
        appLimits: 1,
        usageRollups: 1,
        workerScripts: 1
      })
    );
    await expect(env.DEPLOYMENTS_KV.get(oldManifestKey)).resolves.toBeNull();
    await expect(env.DEPLOYMENTS_KV.get(currentManifestKey)).resolves.not.toBeNull();
    await expect(env.STATIC_ASSETS!.get("static/old/index.html")).resolves.toBeNull();
    await expect(env.STATIC_ASSETS!.get("static/current/index.html")).resolves.not.toBeNull();
    await expect(env.DEPLOYMENTS_KV.get(workerScriptMappingKey("old-script"))).resolves.toBeNull();
    expect(deletedScripts).toEqual(["old-script"]);
  });
});
