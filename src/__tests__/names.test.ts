import { describe, expect, it } from "vitest";
import { branchToEnvironment, resolveEnvironment } from "../names";

describe("environment names", () => {
  it("maps production branches to production", () => {
    expect(branchToEnvironment("main")).toBe("production");
    expect(branchToEnvironment("master")).toBe("production");
    expect(branchToEnvironment("MAIN")).toBe("production");
  });

  it("normalizes branch names to DNS-safe environments", () => {
    expect(branchToEnvironment("Feature/API.v2_test")).toBe("feature-api-v2-test");
  });

  it("normalizes explicit environment overrides", () => {
    expect(
      resolveEnvironment({
        branch: "main",
        queryValue: "Review/API.v2_test"
      })
    ).toBe("review-api-v2-test");
  });
});
