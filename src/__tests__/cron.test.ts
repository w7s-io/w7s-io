import { describe, expect, it } from "vitest";
import {
  isCronExpressionDue,
  normalizeCronExpression,
  scheduledMinuteIso
} from "../cron";

describe("cron helpers", () => {
  it("normalizes and validates five-field cron expressions", () => {
    expect(normalizeCronExpression("  */5   1-3  *  *  1,3,5 ")).toBe("*/5 1-3 * * 1,3,5");
    expect(() => normalizeCronExpression("* * * *")).toThrow("five fields");
    expect(() => normalizeCronExpression("*/0 * * * *")).toThrow("invalid step");
    expect(() => normalizeCronExpression("60 * * * *")).toThrow("between 0 and 59");
  });

  it("matches wildcards, steps, lists, ranges, and numeric values in UTC", () => {
    const due = new Date("2026-05-25T12:10:00.000Z");
    expect(isCronExpressionDue("*/5 * * * *", due)).toBe(true);
    expect(isCronExpressionDue("11 * * * *", due)).toBe(false);
    expect(isCronExpressionDue("10 12 25 5 1", due)).toBe(true);
    expect(isCronExpressionDue("10 9-13 25 5 1,3", due)).toBe(true);
    expect(isCronExpressionDue("10 9-13/2 25 5 1", due)).toBe(false);
  });

  it("treats 7 as Sunday in the day-of-week field", () => {
    const sunday = new Date("2026-05-24T12:00:00.000Z");
    expect(isCronExpressionDue("0 12 * * 0", sunday)).toBe(true);
    expect(isCronExpressionDue("0 12 * * 7", sunday)).toBe(true);
  });

  it("floors scheduled times to the minute", () => {
    expect(scheduledMinuteIso(new Date("2026-05-25T12:10:42.123Z"))).toBe("2026-05-25T12:10:00.000Z");
  });
});
