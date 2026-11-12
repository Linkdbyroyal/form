import { describe, expect, it } from "vitest";
import { withNotice } from "../lib/format";
import {
  EVENT_FILTERS,
  buildRunList,
  buildSteps,
  eventKindTone,
  eventMatchesFilter,
  fmtClockSeconds,
  fmtRunDuration,
  isTerminalRunState,
  isUuid,
  liveReturnTo,
  parseLiveTab,
  parseRunDetail,
  sortRunRows,
  type LiveDoneRun,
  type LiveFailedRun,
  type LiveRun,
  type RunListRow
} from "../lib/live/helpers";

/** Live Mission Control slice 2 (ADR-024): pure helpers behind the Runs tab and the inspector drawer. The detail route needs Postgres and is checked manually. */

describe("steps", () => {
  it("marks traversed checkpoints done, the latest one now and a pending placeholder while the run is alive", () => {
    expect(buildSteps(["step persist", "step request_publication", "step publish"], "waiting_for_approval")).toEqual([
      { name: "persist", status: "done" },
      { name: "request_publication", status: "done" },
      { name: "publish", status: "now" },
      { name: "next", status: "pending" }
    ]);
  });

  it("de-duplicates a re-checkpointed step and ignores non-step summaries", () => {
    expect(buildSteps(["step persist", "checkpoint saved", "step persist", "step publish", null], "running")).toEqual([
      { name: "persist", status: "done" },
      { name: "publish", status: "now" },
      { name: "next", status: "pending" }
    ]);
  });

  it("has only done steps for a terminal run and no placeholder after the final 'done' step", () => {
    expect(buildSteps(["step persist", "step done"], "succeeded")).toEqual([{ name: "persist", status: "done" }, { name: "done", status: "done" }]);
    expect(buildSteps(["step persist", "step done"], "running")).toEqual([{ name: "persist", status: "done" }, { name: "done", status: "now" }]);
    expect(buildSteps([], "queued")).toEqual([{ name: "next", status: "pending" }]);
    expect(buildSteps([], "failed")).toEqual([]);
  });

  it("knows which states are terminal", () => {
    expect(isTerminalRunState("succeeded")).toBe(true);
    expect(isTerminalRunState("timed_out")).toBe(true);
    expect(isTerminalRunState("waiting_for_approval")).toBe(false);
    expect(isTerminalRunState("interrupted")).toBe(false);
  });
});

describe("event feed", () => {
  it("filters kinds into the inspector groups", () => {
    expect(EVENT_FILTERS).toEqual(["all", "tools", "model", "state", "approvals", "errors"]);
    expect(eventMatchesFilter("note", "all")).toBe(true);
    expect(eventMatchesFilter("tool_call", "tools")).toBe(true);
    expect(eventMatchesFilter("tool_denied", "tools")).toBe(true);
    expect(eventMatchesFilter("model_call", "tools")).toBe(false);
    expect(eventMatchesFilter("model_call", "model")).toBe(true);
    expect(eventMatchesFilter("state_change", "state")).toBe(true);
    expect(eventMatchesFilter("checkpoint", "state")).toBe(true);
    expect(eventMatchesFilter("approval_requested", "approvals")).toBe(true);
    expect(eventMatchesFilter("question_created", "approvals")).toBe(true);
    expect(eventMatchesFilter("help_request", "approvals")).toBe(true);
    expect(eventMatchesFilter("error", "errors")).toBe(true);
    expect(eventMatchesFilter("tool_denied", "errors")).toBe(true);
    expect(eventMatchesFilter("output_written", "errors")).toBe(false);
  });

  it("colours kinds as the composite does", () => {
    expect(eventKindTone("tool_call")).toBe("cyan");
    expect(eventKindTone("model_call")).toBe("indigo");
    expect(eventKindTone("approval_requested")).toBe("warning");
    expect(eventKindTone("question_created")).toBe("warning");
    expect(eventKindTone("error")).toBe("danger");
    expect(eventKindTone("tool_denied")).toBe("danger");
    expect(eventKindTone("state_change")).toBe("neutral");
    expect(eventKindTone("note")).toBe("neutral");
  });

  it("formats clock labels with seconds in UTC", () => {
    expect(fmtClockSeconds("2026-11-11T10:05:09.000Z")).toBe("10:05:09Z");
    expect(fmtClockSeconds("garbage")).toBe("");
  });
});

describe("durations", () => {
  const now = new Date("2026-11-11T12:00:00.000Z");
  it("formats the run duration to the finish time or to now", () => {
    expect(fmtRunDuration("2026-11-11T11:59:59.150Z", "2026-11-11T11:59:59.999Z", now)).toBe("849 ms");
    expect(fmtRunDuration("2026-11-11T11:59:48.000Z", null, now)).toBe("12 s");
    expect(fmtRunDuration("2026-11-11T11:56:55.000Z", null, now)).toBe("3 min 05 s");
    expect(fmtRunDuration("2026-11-11T09:53:00.000Z", "2026-11-11T12:00:00.000Z", now)).toBe("2 h 07 min");
    expect(fmtRunDuration(null, null, now)).toBe("n/a");
    expect(fmtRunDuration("nope", null, now)).toBe("n/a");
    // a clock skew never yields a negative duration
    expect(fmtRunDuration("2026-11-11T12:00:05.000Z", null, now)).toBe("0 ms");
  });
});

describe("run list", () => {
  function alive(partial: Partial<LiveRun> & Pick<LiveRun, "id" | "state">): LiveRun {
    return { tenantId: "t1", tenantSlug: "acme", tenantName: "Acme", agentInstanceId: "a1", agentName: "Discovery", definitionKey: "discovery", trigger: "schedule", attempt: 1, startedAt: "2026-11-11T10:00:00.000Z", createdAt: "2026-11-11T09:59:00.000Z", step: null, steps: [], tokensInput: 0, tokensOutput: 0, costUsd: 0.5, toolCalls: 3, modelCalls: 2, simulated: true, lastEventAt: null, lastEventSummary: null, lastEventKind: null, ...partial };
  }
  function done(partial: Partial<LiveDoneRun> & Pick<LiveDoneRun, "id" | "state">): LiveDoneRun {
    return { tenantId: "t1", tenantName: "Acme", agentName: "Discovery", definitionKey: "discovery", trigger: "command", summary: null, costUsd: 0.1, toolCalls: 1, modelCalls: 1, simulated: true, startedAt: "2026-11-11T10:20:00.000Z", finishedAt: "2026-11-11T10:30:00.000Z", ...partial };
  }
  function failed(partial: Partial<LiveFailedRun> & Pick<LiveFailedRun, "id">): LiveFailedRun {
    return { tenantId: "t1", tenantName: "Acme", agentName: "Discovery", definitionKey: "discovery", trigger: "command", state: "failed", errorCode: "budget_exceeded", summary: null, startedAt: null, finishedAt: "2026-11-11T10:20:00.000Z", costUsd: 0, toolCalls: 0, modelCalls: 0, ...partial };
  }
  const snapshot = {
    running: [alive({ id: "r1", state: "running", startedAt: "2026-11-11T10:05:00.000Z" }), alive({ id: "r2", state: "queued", startedAt: null, createdAt: "2026-11-11T10:50:00.000Z", tenantId: "t2" })],
    done: [done({ id: "d1", state: "succeeded" }), done({ id: "d2", state: "cancelled", finishedAt: "2026-11-11T10:40:00.000Z", definitionKey: "kpi" })],
    needsYou: { approvals: [], incidents: [], failedRuns: [failed({ id: "f1" }), failed({ id: "f2", state: "timed_out", tenantId: "t2" })], questions: [] }
  };

  it("lists alive runs first (newest start first), then finished runs (newest finish first), without failures by default", () => {
    const rows = buildRunList(snapshot, { tenantId: null, definitionKey: null, state: null });
    expect(rows.map((r) => r.id)).toEqual(["r2", "r1", "d2", "d1"]);
    expect(rows[0]).toMatchObject({ sortAt: "2026-11-11T10:50:00.000Z", finishedAt: null, errorCode: null, toolCalls: 3, modelCalls: 2, costUsd: 0.5 });
    expect(rows[2]).toMatchObject({ trigger: "command", startedAt: "2026-11-11T10:20:00.000Z", finishedAt: "2026-11-11T10:40:00.000Z" });
  });

  it("adds the failed lane when the state filter asks for failures, and applies the shared filters", () => {
    expect(buildRunList(snapshot, { tenantId: null, definitionKey: null, state: "failed" }).map((r) => r.id)).toEqual(["f1"]);
    expect(buildRunList(snapshot, { tenantId: null, definitionKey: null, state: "timed_out" })).toMatchObject([{ id: "f2", errorCode: "budget_exceeded", simulated: true }]);
    expect(buildRunList(snapshot, { tenantId: "t2", definitionKey: null, state: null }).map((r) => r.id)).toEqual(["r2"]);
    expect(buildRunList(snapshot, { tenantId: null, definitionKey: "kpi", state: null }).map((r) => r.id)).toEqual(["d2"]);
    expect(buildRunList(snapshot, { tenantId: null, definitionKey: null, state: "succeeded" }).map((r) => r.id)).toEqual(["d1"]);
  });

  it("sorts without mutating the input", () => {
    const row = (id: string, state: RunListRow["state"], sortAt: string): RunListRow => ({ id, tenantId: "t", tenantName: "T", agentName: "A", definitionKey: "d", trigger: "command", state, startedAt: null, finishedAt: null, sortAt, costUsd: 0, toolCalls: 0, modelCalls: 0, simulated: true, errorCode: null });
    const rows = [row("a", "succeeded", "2026-11-11T10:00:00.000Z"), row("b", "running", "2026-11-11T09:00:00.000Z"), row("c", "succeeded", "2026-11-11T11:00:00.000Z")];
    expect(sortRunRows(rows).map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("tabs and return paths", () => {
  it("parses the tab from a query value or a hash", () => {
    expect(parseLiveTab("runs")).toBe("runs");
    expect(parseLiveTab("#runs")).toBe("runs");
    expect(parseLiveTab("MAP")).toBe("map");
    expect(parseLiveTab("nope")).toBe("queue");
    expect(parseLiveTab(null)).toBe("queue");
  });

  it("builds the board path that server actions return to", () => {
    expect(liveReturnTo("queue", null)).toBe("/mission-control/live");
    expect(liveReturnTo("runs", null)).toBe("/mission-control/live?tab=runs");
    expect(liveReturnTo("queue", "11111111-1111-1111-1111-111111111111")).toBe("/mission-control/live?run=11111111-1111-1111-1111-111111111111");
    expect(liveReturnTo("runs", "11111111-1111-1111-1111-111111111111")).toBe("/mission-control/live?tab=runs&run=11111111-1111-1111-1111-111111111111");
  });

  it("keeps the existing query when a notice is appended, replacing an older notice", () => {
    expect(withNotice("/mission-control/live?tab=runs&run=abc", { ok: "done" })).toBe("/mission-control/live?tab=runs&run=abc&ok=done");
    expect(withNotice("/mission-control/live?tab=runs&ok=old", { error: "refused" })).toBe("/mission-control/live?tab=runs&error=refused");
    expect(withNotice("/mission-control/live#runs", { ok: "x" })).toBe("/mission-control/live?ok=x");
    expect(withNotice("/mission-control/runs", { ok: "x" })).toBe("/mission-control/runs?ok=x");
    expect(withNotice("//evil.example", { ok: "x" })).toBe("/mission-control?ok=x");
    expect(withNotice("/mission-control/runs", {})).toBe("/mission-control/runs");
  });

  it("validates UUIDs for the detail route", () => {
    expect(isUuid("f5ee3453-3a85-4d8b-a423-c2cdaef44a10")).toBe(true);
    expect(isUuid("f5ee3453")).toBe(false);
    expect(isUuid(null)).toBe(false);
  });

  it("accepts only detail-shaped responses", () => {
    expect(parseRunDetail({ run: { id: "x" }, steps: [], events: [], instructions: [] })).not.toBeNull();
    expect(parseRunDetail({ error: "run not found" })).toBeNull();
    expect(parseRunDetail(null)).toBeNull();
    expect(parseRunDetail("string")).toBeNull();
  });
});
