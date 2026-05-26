import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../worker";
import { handleTailEvents } from "../logs";
import { storeDeploymentRecord, type DeploymentRecord } from "../storage/deployments";
import { createTestEnv } from "./mocks";

const deployment = (overrides: Partial<DeploymentRecord> = {}): DeploymentRecord => ({
  version: 1,
  orgSlug: "acme",
  repoSlug: "app",
  environment: "production",
  repository: "acme/app",
  branch: "main",
  commitSha: "abc123",
  deployedAt: "2026-05-26T12:00:00.000Z",
  targets: {
    worker: {
      namespace: "w7s-isolate",
      scriptName: "acme--app--production--abc123",
      entrypoint: "backend/index.ts",
      compatibilityDate: "2026-05-23",
      startupTimeMs: 0
    }
  },
  ...overrides
});

describe("worker log retrieval", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists tail console logs and exceptions for mapped user workers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "https://api.github.com/repos/acme/app") {
          return Response.json({ full_name: "acme/app" });
        }
        return new Response("not found", { status: 404 });
      })
    );

    const env = createTestEnv();
    await storeDeploymentRecord(env, deployment());

    await handleTailEvents(
      [
        {
          scriptName: "w7s-io",
          eventTimestamp: 1779796800000,
          outcome: "ok",
          logs: [{ timestamp: 1779796800001, level: "log", message: ["core log"] }],
          exceptions: []
        },
        {
          scriptName: "acme--app--production--abc123",
          eventTimestamp: 1779796800000,
          outcome: "exception",
          event: {
            request: {
              method: "GET",
              url: "https://acme.w7s.cloud/app?token=secret",
              cf: { colo: "IAD" }
            },
            response: { status: 500 }
          },
          logs: [
            {
              timestamp: 1779796801000,
              level: "log",
              message: ["hello", { ok: true }]
            }
          ],
          exceptions: [
            {
              timestamp: 1779796802000,
              name: "Error",
              message: "boom",
              stack: "Error: boom\n    at test"
            }
          ]
        }
      ],
      env
    );

    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/logs/acme/app?from=2026-05-26T11:00:00.000Z&to=2026-05-26T13:00:00.000Z&limit=10", {
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
          logs: expect.objectContaining({
            repository: "acme/app",
            environment: "production",
            cursor: null,
            records: [
              expect.objectContaining({
                kind: "exception",
                level: "error",
                text: "Error: boom",
                exception: expect.objectContaining({
                  name: "Error",
                  message: "boom"
                }),
                request: {
                  method: "GET",
                  path: "/app",
                  status: 500,
                  colo: "IAD"
                }
              }),
              expect.objectContaining({
                kind: "console",
                level: "log",
                message: ["hello", { ok: true }],
                text: "hello {\"ok\":true}"
              })
            ]
          })
        }
      })
    );
  });

  it("filters logs by kind and requires repository authorization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "https://api.github.com/repos/acme/app") {
          return Response.json({ full_name: "acme/app" });
        }
        return new Response("not found", { status: 404 });
      })
    );

    const env = createTestEnv();
    await storeDeploymentRecord(env, deployment());
    await handleTailEvents(
      [
        {
          scriptName: "acme--app--production--abc123",
          eventTimestamp: 1779796800000,
          outcome: "ok",
          logs: [{ timestamp: 1779796800000, level: "warn", message: ["watch it"] }],
          exceptions: []
        }
      ],
      env
    );

    const filtered = await app.fetch(
      new Request("https://w7s.cloud/api/v1/logs/acme/app?from=2026-05-26T11:00:00.000Z&to=2026-05-26T13:00:00.000Z&kind=console&level=warn", {
        headers: {
          authorization: "Bearer github-token"
        }
      }),
      env
    );
    expect(filtered.status).toBe(200);
    const filteredBody = await filtered.json() as { data: { logs: { records: unknown[] } } };
    expect(filteredBody.data.logs.records).toHaveLength(1);

    const missingAuth = await app.fetch(
      new Request("https://w7s.cloud/api/v1/logs/acme/app"),
      env
    );
    expect(missingAuth.status).toBe(401);
  });
});
