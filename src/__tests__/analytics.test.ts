import { describe, expect, it } from "vitest";
import { responseOutcome, writeAnalyticsEvent } from "../analytics";
import { createTestEnv, MemoryAnalyticsEngine } from "./mocks";

describe("analytics helper", () => {
  it("writes stable Analytics Engine datapoints", () => {
    const analytics = new MemoryAnalyticsEngine();
    const env = createTestEnv({
      W7S_ANALYTICS: analytics as unknown as AnalyticsEngineDataset
    });

    writeAnalyticsEvent(env, {
      event: "runtime_request",
      repository: "w7s-io/example",
      environment: "production",
      orgSlug: "w7s-io",
      repoSlug: "example",
      outcome: "success",
      source: "static_exact",
      target: "w7s-io/example",
      method: "GET",
      status: 200,
      durationMs: 12,
      count: 3
    });

    expect(analytics.points).toEqual([
      {
        indexes: ["w7s-io/example"],
        blobs: [
          "runtime_request",
          "w7s-io/example",
          "production",
          "w7s-io",
          "example",
          "success",
          "static_exact",
          "w7s-io/example",
          "GET"
        ],
        doubles: [3, 200, 12]
      }
    ]);
  });

  it("does nothing when no Analytics Engine binding is configured", () => {
    const env = createTestEnv();

    expect(() =>
      writeAnalyticsEvent(env, {
        event: "deploy",
        repository: "w7s-io/example"
      })
    ).not.toThrow();
  });

  it("classifies non-2xx and non-3xx responses as errors", () => {
    expect(responseOutcome(200)).toBe("success");
    expect(responseOutcome(308)).toBe("success");
    expect(responseOutcome(404)).toBe("error");
  });
});
