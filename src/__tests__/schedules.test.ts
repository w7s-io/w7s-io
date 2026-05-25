import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { app } from "../worker";
import { createTestEnv } from "./mocks";
import { dispatchDueSchedules } from "../runtime/scheduleDelivery";
import {
  listScheduleMappings,
  loadDeploymentRecord,
  replaceScheduleMappings,
  storeDeploymentRecord,
  storeScheduleMappings,
  type DeploymentRecord
} from "../storage/deployments";

const zipBytes = (files: Record<string, string>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, value]) => [path, new TextEncoder().encode(value)])
    )
  );

const deployRequest = (files: Record<string, string>) =>
  new Request("https://w7s.cloud/api/v1/deploy", {
    method: "POST",
    headers: {
      authorization: "Bearer github-token",
      "content-type": "application/zip",
      "x-github-repository": "w7s-io/scheduled-worker",
      "x-github-sha": "abc123",
      "x-github-branch": "main"
    },
    body: zipBytes(files)
  });

const workerRecord = (): DeploymentRecord => ({
  version: 1,
  orgSlug: "w7s-io",
  repoSlug: "scheduled-worker",
  environment: "production",
  repository: "w7s-io/scheduled-worker",
  branch: "main",
  commitSha: "abc123",
  deployedAt: "2026-05-25T12:00:00.000Z",
  schedules: [
    {
      cron: "*/5 * * * *",
      path: "/_w7s/schedules/sync"
    }
  ],
  targets: {
    worker: {
      namespace: "w7s-isolate",
      scriptName: "w7s-io--scheduled-worker--production--abc123",
      entrypoint: "backend/index.js",
      compatibilityDate: "2026-05-23",
      startupTimeMs: null
    }
  }
});

describe("scheduled deploys", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores schedule declarations and schedule mappings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/")) {
          return Response.json({ full_name: "w7s-io/scheduled-worker" });
        }
        if (
          url.includes("/workers/dispatch/namespaces/w7s-isolate/scripts/") &&
          init?.method === "PUT"
        ) {
          return Response.json({ success: true, result: { startup_time_ms: 5 } });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-123"
    });

    const response = await app.fetch(
      deployRequest({
        "backend/index.js": "export default { fetch(){ return new Response('ok') } }",
        "w7s.json": JSON.stringify({
          schedules: [
            {
              cron: "*/5 * * * *",
              path: "/_w7s/schedules/sync"
            }
          ]
        })
      }),
      env
    );

    expect(response.status).toBe(200);
    const record = await loadDeploymentRecord(env, "production", "w7s-io", "scheduled-worker");
    expect(record?.schedules).toEqual([
      {
        cron: "*/5 * * * *",
        path: "/_w7s/schedules/sync"
      }
    ]);
    expect(await listScheduleMappings(env)).toEqual([
      expect.objectContaining({
        cron: "*/5 * * * *",
        path: "/_w7s/schedules/sync",
        repository: "w7s-io/scheduled-worker"
      })
    ]);
  });

  it("rejects schedules on static-only deployments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/")) {
          return Response.json({ full_name: "w7s-io/scheduled-worker" });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv();

    const response = await app.fetch(
      deployRequest({
        "dist/index.html": "<h1>Hello</h1>",
        "w7s.json": JSON.stringify({
          schedules: [
            {
              cron: "* * * * *",
              path: "/_w7s/schedules/sync"
            }
          ]
        })
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        error: "Schedules require a native backend deployment."
      })
    );
  });
});

describe("scheduled dispatch", () => {
  it("removes stale schedule mappings for the same deployment", async () => {
    const env = createTestEnv();
    const record = workerRecord();
    const previous = [
      ...(record.schedules ?? []),
      {
        cron: "0 * * * *",
        path: "/_w7s/schedules/hourly"
      }
    ];
    await storeScheduleMappings(env, record, previous);
    await replaceScheduleMappings(env, record, record.schedules ?? []);

    expect(await listScheduleMappings(env)).toEqual([
      expect.objectContaining({
        cron: "*/5 * * * *",
        path: "/_w7s/schedules/sync"
      })
    ]);
  });

  it("dispatches due schedules to mapped deployment paths once per scheduled minute", async () => {
    const calls: Array<{ scriptName: string; path: string; headers: Record<string, string>; body: unknown }> = [];
    const env = createTestEnv({
      DISPATCHER: {
        get: (scriptName: string) => ({
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            calls.push({
              scriptName,
              path: new URL(request.url).pathname,
              headers: {
                schedule: request.headers.get("x-w7s-schedule") ?? "",
                cron: request.headers.get("x-w7s-schedule-cron") ?? "",
                time: request.headers.get("x-w7s-schedule-time") ?? ""
              },
              body: await request.json()
            });
            return Response.json({ ok: true });
          }
        })
      }
    });
    const record = workerRecord();
    await storeDeploymentRecord(env, record);
    await storeScheduleMappings(env, record, record.schedules ?? []);

    await dispatchDueSchedules(env, new Date("2026-05-25T12:10:42.000Z"));
    await dispatchDueSchedules(env, new Date("2026-05-25T12:10:50.000Z"));
    await dispatchDueSchedules(env, new Date("2026-05-25T12:11:00.000Z"));

    expect(calls).toEqual([
      {
        scriptName: "w7s-io--scheduled-worker--production--abc123",
        path: "/_w7s/schedules/sync",
        headers: {
          schedule: "1",
          cron: "*/5 * * * *",
          time: "2026-05-25T12:10:00.000Z"
        },
        body: {
          schedule: "*/5 * * * *",
          scheduledTime: "2026-05-25T12:10:00.000Z",
          repository: "w7s-io/scheduled-worker",
          environment: "production"
        }
      }
    ]);
  });
});
