import { afterEach, describe, expect, it, vi } from "vitest";
import { collectHourlyCloudflareUsage, listCloudflareUsageHourlyRecords } from "../cloudflareUsage";
import { loadAppLimitState } from "../appLimits";
import { createTestEnv } from "./mocks";
import { storeDeploymentRecord, type DeploymentRecord } from "../storage/deployments";
import { loadUsageDailyRollup } from "../usage";
import { usageLimitPolicyKey } from "../usageLimits";

const deployment = (): DeploymentRecord => ({
  version: 1,
  orgSlug: "acme",
  repoSlug: "app",
  environment: "production",
  repository: "acme/app",
  branch: "main",
  commitSha: "abc123",
  deployedAt: "2026-05-26T10:00:00.000Z",
  bindings: {
    kv: [
      {
        binding: "CACHE",
        name: "w7s-production-acme-app-kv-cache",
        namespaceId: "kv-ns"
      }
    ],
    d1: [
      {
        binding: "DB",
        name: "w7s-production-acme-app-d1-db",
        databaseId: "d1-db"
      }
    ],
    r2: [
      {
        binding: "FILES",
        bucketName: "w7s-production-acme-app-r2-files"
      }
    ],
    durableObjects: [
      {
        binding: "COUNTER",
        className: "Counter"
      }
    ]
  },
  targets: {
    worker: {
      namespace: "w7s-isolate",
      scriptName: "acme--app--production--abc123",
      entrypoint: "backend/index.js",
      compatibilityDate: "2026-05-23",
      startupTimeMs: 5
    }
  }
});

describe("Cloudflare usage collector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collects hourly Cloudflare metrics into daily usage and suspends exceeded apps", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
        if (body.query?.includes("workersInvocationsAdaptive")) {
          return Response.json({
            data: {
              viewer: {
                accounts: [
                  {
                    workersInvocationsAdaptive: [
                      {
                        sum: { requests: 7, errors: 0, subrequests: 2 },
                        quantiles: { cpuTimeP99: 2 },
                        dimensions: { scriptName: "acme--app--production--abc123" }
                      }
                    ]
                  }
                ]
              }
            }
          });
        }
        if (body.query?.includes("durableObjectsInvocationsAdaptiveGroups")) {
          return Response.json({
            data: {
              viewer: {
                accounts: [
                  {
                    durableObjectsInvocationsAdaptiveGroups: [
                      {
                        sum: { requests: 6, wallTime: 150, errors: 0 },
                        dimensions: { scriptName: "acme--app--production--abc123" }
                      }
                    ]
                  }
                ]
              }
            }
          });
        }
        if (body.query?.includes("kvOperationsAdaptiveGroups")) {
          return Response.json({
            data: {
              viewer: {
                accounts: [
                  {
                    kvOperationsAdaptiveGroups: [
                      {
                        sum: { requests: 8 },
                        dimensions: { actionType: "read" }
                      },
                      {
                        sum: { requests: 3 },
                        dimensions: { actionType: "write" }
                      },
                      {
                        sum: { requests: 2 },
                        dimensions: { actionType: "delete" }
                      },
                      {
                        sum: { requests: 1 },
                        dimensions: { actionType: "list" }
                      }
                    ],
                    kvStorageAdaptiveGroups: [
                      {
                        max: { byteCount: 2048 },
                        dimensions: { namespaceId: "kv-ns" }
                      }
                    ]
                  }
                ]
              }
            }
          });
        }
        if (body.query?.includes("d1AnalyticsAdaptiveGroups")) {
          return Response.json({
            data: {
              viewer: {
                accounts: [
                  {
                    d1AnalyticsAdaptiveGroups: [
                      {
                        sum: {
                          rowsRead: 5,
                          rowsWritten: 2,
                          readQueries: 4,
                          writeQueries: 1
                        },
                        dimensions: { databaseId: "d1-db" }
                      }
                    ],
                    d1StorageAdaptiveGroups: [
                      {
                        max: { databaseSizeBytes: 4096 },
                        dimensions: { databaseId: "d1-db" }
                      }
                    ]
                  }
                ]
              }
            }
          });
        }
        if (body.query?.includes("r2OperationsAdaptiveGroups")) {
          return Response.json({
            data: {
              viewer: {
                accounts: [
                  {
                    r2OperationsAdaptiveGroups: [
                      {
                        sum: { requests: 3 },
                        dimensions: { actionType: "GetObject" }
                      },
                      {
                        sum: { requests: 2 },
                        dimensions: { actionType: "PutObject" }
                      }
                    ],
                    r2StorageAdaptiveGroups: [
                      {
                        max: { payloadSize: 1000, metadataSize: 24 },
                        dimensions: { bucketName: "w7s-production-acme-app-r2-files" }
                      }
                    ]
                  }
                ]
              }
            }
          });
        }
        return Response.json({ data: { viewer: { accounts: [{}] } } });
      })
    );

    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-123"
    });
    await storeDeploymentRecord(env, deployment());
    await env.DEPLOYMENTS_KV.put(
      usageLimitPolicyKey({
        scope: "repo",
        orgSlug: "acme",
        repoSlug: "app"
      }),
      JSON.stringify({
        version: 1,
        metrics: {
          "d1.rows_read": 4
        }
      })
    );

    const result = await collectHourlyCloudflareUsage(env, new Date("2026-05-26T12:15:00.000Z"));

    expect(result).toEqual(
      expect.objectContaining({
        collected: true,
        hour: "2026-05-26T11",
        deployments: 1,
        failures: 0
      })
    );
    const daily = await loadUsageDailyRollup(env, {
      date: "2026-05-26",
      environment: "production",
      orgSlug: "acme",
      repoSlug: "app"
    });
    expect(daily?.metrics).toEqual(
      expect.objectContaining({
        "worker.script": expect.objectContaining({ units: 1 }),
        "worker.request": expect.objectContaining({ units: 7 }),
        "runtime.cpu_ms": expect.objectContaining({ units: 14, source: "cloudflare_estimated" }),
        "kv.read": expect.objectContaining({ units: 8 }),
        "kv.write": expect.objectContaining({ units: 3 }),
        "kv.delete": expect.objectContaining({ units: 2 }),
        "kv.list": expect.objectContaining({ units: 1 }),
        "kv.storage_bytes": expect.objectContaining({ units: 2048 }),
        "d1.rows_read": expect.objectContaining({ units: 5 }),
        "d1.rows_written": expect.objectContaining({ units: 2 }),
        "d1.storage_bytes": expect.objectContaining({ units: 4096 }),
        "r2.class_a": expect.objectContaining({ units: 2 }),
        "r2.class_b": expect.objectContaining({ units: 3 }),
        "r2.storage_bytes": expect.objectContaining({ units: 1024 }),
        "durable_object.request": expect.objectContaining({ units: 6 }),
        "durable_object.duration_ms": expect.objectContaining({ units: 150 })
      })
    );
    expect(daily?.cloudflareHours).toEqual(["2026-05-26T11"]);
    await expect(
      listCloudflareUsageHourlyRecords(env, {
        date: "2026-05-26",
        environment: "production",
        orgSlug: "acme",
        repoSlug: "app"
      })
    ).resolves.toHaveLength(1);
    await expect(
      loadAppLimitState(env, {
        environment: "production",
        orgSlug: "acme",
        repoSlug: "app",
        at: new Date("2026-05-26T12:30:00.000Z")
      })
    ).resolves.toEqual(
      expect.objectContaining({
        status: "suspended",
        reason: "W7S free-tier limit exceeded for d1.rows_read."
      })
    );
  });
});
