import { describe, expect, it } from "vitest";
import { toBossSendOptions } from "@sbos/core";
import { RunFailure } from "@sbos/core";
import { classify } from "../src/executor";
import { nextRun } from "../src/schedules";

describe("schedule cron parsing", () => {
  it("computes the next run in the schedule's timezone", () => {
    const from = new Date("2026-11-09T06:30:00Z");
    const next = nextRun("0 7 * * 1-5", "UTC", from);
    expect(next?.toISOString()).toBe("2026-11-09T07:00:00.000Z");
    const nextCuracao = nextRun("0 7 * * 1-5", "America/Curacao", from);
    expect(nextCuracao?.toISOString()).toBe("2026-11-09T11:00:00.000Z");
  });

  it("returns null for an invalid cron expression", () => {
    expect(nextRun("not a cron", "UTC")).toBeNull();
  });
});

describe("pg-boss send options", () => {
  it("never passes undefined option values (pg-boss asserts on them)", () => {
    const opts = toBossSendOptions("agent.run", { singletonKey: "run:1" }) as Record<string, unknown>;
    expect(Object.values(opts).some((v) => v === undefined)).toBe(false);
    expect(opts.singletonKey).toBe("run:1");
    expect(opts.deadLetter).toBe("dead-letter");
    expect(opts.retryLimit).toBe(3);
  });
});

describe("failure classification", () => {
  it("maps provider and policy errors to the right class", () => {
    expect(classify(new Error("401 invalid x-api-key"))).toBe("credential");
    expect(classify(new Error("429 rate limited"))).toBe("model");
    expect(classify(new Error('tool "payments.write" is not allowed'))).toBe("policy");
    expect(classify(new Error("something unexpected"))).toBe("bug");
    expect(new RunFailure("model", "overloaded").retryable).toBe(true);
    expect(new RunFailure("budget", "cap").retryable).toBe(false);
  });
});
