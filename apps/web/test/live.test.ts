import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  buildTimeline,
  connectionLabel,
  emptyRunCounts,
  filterOptions,
  fmtAgo,
  groupRuns,
  laneForRunState,
  parseNotification,
  parseSnapshotEvent,
  parseStateFromSummary,
  parseStepFromSummary,
  runMatches,
  type LiveDoneRun,
  type LiveFailedRun,
  type LiveRun,
  type LiveSnapshot,
  type LiveStateChange
} from "../lib/live/helpers";

/** Live Mission Control slice 1 (ADR-024): pure helpers behind the Command Queue. The stream itself needs Postgres and is checked manually. */

function run(partial: Partial<LiveRun> & Pick<LiveRun, "id" | "state">): LiveRun {
  return {
    tenantId: "t1",
    tenantSlug: "acme",
    tenantName: "Acme",
    agentInstanceId: "a1",
    agentName: "Discovery",
    definitionKey: "discovery",
    trigger: "schedule",
    attempt: 1,
    startedAt: "2026-11-11T10:00:00.000Z",
    createdAt: "2026-11-11T09:59:00.000Z",
    step: null,
    steps: [],
    tokensInput: 0,
    tokensOutput: 0,
    costUsd: 0,
    toolCalls: 0,
    modelCalls: 0,
    simulated: true,
    lastEventAt: null,
    lastEventSummary: null,
    lastEventKind: null,
    ...partial
  };
}

function done(partial: Partial<LiveDoneRun> & Pick<LiveDoneRun, "id" | "state">): LiveDoneRun {
  return { tenantId: "t1", tenantName: "Acme", agentName: "Discovery", definitionKey: "discovery", trigger: "schedule", summary: null, costUsd: 0, toolCalls: 0, modelCalls: 0, simulated: true, startedAt: "2026-11-11T10:20:00.000Z", finishedAt: "2026-11-11T10:30:00.000Z", ...partial };
}

function failed(partial: Partial<LiveFailedRun> & Pick<LiveFailedRun, "id">): LiveFailedRun {
  return { tenantId: "t1", tenantName: "Acme", agentName: "Discovery", definitionKey: "discovery", trigger: "command", state: "failed", errorCode: "model", summary: null, startedAt: "2026-11-11T10:19:00.000Z", finishedAt: "2026-11-11T10:20:00.000Z", costUsd: 0, toolCalls: 0, modelCalls: 0, ...partial };
}

const snapshotBase = (): Pick<LiveSnapshot, "running" | "done" | "needsYou"> => ({
  running: [
    run({ id: "r1", state: "running", startedAt: "2026-11-11T10:05:00.000Z" }),
    run({ id: "r2", state: "waiting_for_approval", tenantId: "t2", definitionKey: "kpi", startedAt: "2026-11-11T10:10:00.000Z" }),
    run({ id: "r3", state: "queued", startedAt: null, createdAt: "2026-11-11T10:01:00.000Z" })
  ],
  done: [done({ id: "d1", state: "succeeded" }), done({ id: "d2", state: "cancelled", tenantId: "t2", definitionKey: "kpi", finishedAt: "2026-11-11T10:40:00.000Z" })],
  needsYou: { approvals: [], incidents: [], failedRuns: [failed({ id: "f1" }), failed({ id: "f2", tenantId: "t2", state: "timed_out" })], questions: [] }
});

describe("lanes", () => {
  it("maps every run state to a lane", () => {
    expect(laneForRunState("running")).toBe("running");
    expect(laneForRunState("queued")).toBe("running");
    expect(laneForRunState("waiting_for_approval")).toBe("running");
    expect(laneForRunState("paused")).toBe("running");
    expect(laneForRunState("interrupted")).toBe("running");
    expect(laneForRunState("failed")).toBe("needs_you");
    expect(laneForRunState("timed_out")).toBe("needs_you");
    expect(laneForRunState("succeeded")).toBe("done");
    expect(laneForRunState("cancelled")).toBe("done");
  });

  it("groups runs into lanes, newest first, with no filters", () => {
    const lanes = groupRuns(snapshotBase(), { tenantId: null, definitionKey: null, state: null });
    expect(lanes.running.map((r) => r.id)).toEqual(["r2", "r1", "r3"]);
    expect(lanes.done.map((r) => r.id)).toEqual(["d2", "d1"]);
    expect(lanes.failed.map((r) => r.id)).toEqual(["f1", "f2"]);
  });

  it("applies client, definition and state filters", () => {
    const byTenant = groupRuns(snapshotBase(), { tenantId: "t2", definitionKey: null, state: null });
    expect(byTenant.running.map((r) => r.id)).toEqual(["r2"]);
    expect(byTenant.done.map((r) => r.id)).toEqual(["d2"]);
    expect(byTenant.failed.map((r) => r.id)).toEqual(["f2"]);
    const byDefinition = groupRuns(snapshotBase(), { tenantId: null, definitionKey: "discovery", state: null });
    expect(byDefinition.running.map((r) => r.id)).toEqual(["r1", "r3"]);
    const byState = groupRuns(snapshotBase(), { tenantId: null, definitionKey: null, state: "queued" });
    expect(byState.running.map((r) => r.id)).toEqual(["r3"]);
    expect(byState.done).toEqual([]);
    expect(byState.failed).toEqual([]);
    expect(runMatches({ tenantId: "t1", definitionKey: "x", state: "running" }, { tenantId: null, definitionKey: "y", state: null })).toBe(false);
  });

  it("derives filter options from the agents list", () => {
    const options = filterOptions({
      agents: [
        { id: "a", tenantId: "t2", tenantSlug: "zed", tenantName: "Zed", definitionKey: "kpi", name: "K", state: "idle", currentRunId: null, lastActivityAt: null },
        { id: "b", tenantId: "t1", tenantSlug: "acme", tenantName: "Acme", definitionKey: "discovery", name: "D", state: "idle", currentRunId: null, lastActivityAt: null },
        { id: "c", tenantId: "t1", tenantSlug: "acme", tenantName: "Acme", definitionKey: "kpi", name: "K2", state: "idle", currentRunId: null, lastActivityAt: null }
      ]
    });
    expect(options.tenants).toEqual([{ id: "t1", name: "Acme" }, { id: "t2", name: "Zed" }]);
    expect(options.definitions).toEqual(["discovery", "kpi"]);
  });
});

describe("summaries", () => {
  it("parses the state out of the summaries core and the worker write", () => {
    expect(parseStateFromSummary("queued (trigger: schedule)")).toBe("queued");
    expect(parseStateFromSummary("started")).toBe("running");
    expect(parseStateFromSummary("resumed")).toBe("running");
    expect(parseStateFromSummary("waiting for approval")).toBe("waiting_for_approval");
    expect(parseStateFromSummary("re-queued after approval")).toBe("queued");
    expect(parseStateFromSummary("cancelled: approval rejected")).toBe("cancelled");
    expect(parseStateFromSummary("cancelled by operator")).toBe("cancelled");
    expect(parseStateFromSummary("failed: model")).toBe("failed");
    expect(parseStateFromSummary("budget hard stop")).toBe("failed");
    expect(parseStateFromSummary("dead-letter: retries exhausted")).toBe("failed");
    expect(parseStateFromSummary("interrupted, will retry")).toBe("interrupted");
    expect(parseStateFromSummary("lease expired")).toBe("interrupted");
    expect(parseStateFromSummary("Discovery round published with 7 questions")).toBeNull();
    expect(parseStateFromSummary("")).toBeNull();
  });

  it("reads the checkpoint step from 'step <name>' only", () => {
    expect(parseStepFromSummary("step draft_questions")).toBe("draft_questions");
    expect(parseStepFromSummary("  step done")).toBe("done");
    expect(parseStepFromSummary("checkpoint saved")).toBeNull();
    expect(parseStepFromSummary(null)).toBeNull();
  });
});

describe("timeline", () => {
  const now = new Date("2026-11-11T10:45:00.000Z");
  const ev = (partial: Partial<LiveStateChange> & Pick<LiveStateChange, "runId" | "to" | "at" | "seq">): LiveStateChange => ({ agentInstanceId: "a1", agentName: "Discovery", tenantName: "Acme", ...partial });

  it("builds clipped segments per agent from state_change events", () => {
    const events = [
      ev({ runId: "r1", to: "queued", at: "2026-11-11T09:50:00.000Z", seq: 1 }), // starts before the window
      ev({ runId: "r1", to: "running", at: "2026-11-11T10:00:00.000Z", seq: 2 }),
      ev({ runId: "r1", to: "waiting_for_approval", at: "2026-11-11T10:22:30.000Z", seq: 4 }),
      ev({ runId: "r2", to: "running", at: "2026-11-11T10:30:00.000Z", seq: 1, agentInstanceId: "a2", agentName: "KPI" }),
      ev({ runId: "r2", to: "succeeded", at: "2026-11-11T10:40:00.000Z", seq: 2, agentInstanceId: "a2", agentName: "KPI" })
    ];
    const tl = buildTimeline(events, now);
    expect(tl.start).toBe("2026-11-11T10:00:00.000Z");
    expect(tl.end).toBe(now.toISOString());
    expect(tl.tracks.map((t) => t.label)).toEqual(["Discovery · Acme", "KPI · Acme"]);
    const [discovery, kpi] = tl.tracks;
    // queued segment clipped to the window start: zero width, rendered at the minimum width.
    expect(discovery!.segments.map((s) => s.state)).toEqual(["queued", "running", "waiting_for_approval"]);
    expect(discovery!.segments[0]).toMatchObject({ leftPct: 0, widthPct: 0.6 });
    expect(discovery!.segments[1]).toMatchObject({ leftPct: 0, widthPct: 50 });
    expect(discovery!.segments[2]).toMatchObject({ leftPct: 50, widthPct: 50 });
    expect(kpi!.segments[0]).toMatchObject({ state: "running", leftPct: 66.67, widthPct: 22.22 });
    // a terminal state is a marker, not a bar to "now"
    expect(kpi!.segments[1]).toMatchObject({ state: "succeeded", leftPct: 88.89, widthPct: 0.6 });
  });

  it("keeps a segment that starts at 'now' visible at the right edge", () => {
    const tl = buildTimeline([ev({ runId: "r5", to: "queued", at: now.toISOString(), seq: 1 })], now);
    expect(tl.tracks[0]!.segments[0]).toMatchObject({ state: "queued", leftPct: 99.4, widthPct: 0.6 });
  });

  it("skips events whose state is unknown and events outside the window", () => {
    const tl = buildTimeline([ev({ runId: "r9", to: null, at: "2026-11-11T10:30:00.000Z", seq: 1 }), ev({ runId: "r8", to: "succeeded", at: "2026-11-11T09:00:00.000Z", seq: 1 })], now);
    expect(tl.tracks).toEqual([]);
  });
});

describe("stream client", () => {
  it("backs off exponentially with jitter between 1 s and 30 s", () => {
    expect(backoffDelay(0, () => 0)).toBe(1_000);
    expect(backoffDelay(1, () => 0)).toBe(2_000);
    expect(backoffDelay(3, () => 0)).toBe(8_000);
    expect(backoffDelay(0, () => 1)).toBe(1_250);
    expect(backoffDelay(10, () => 1)).toBe(30_000);
    expect(backoffDelay(99, () => 0.5)).toBe(30_000);
    for (let i = 0; i < 12; i++) {
      const d = backoffDelay(i);
      expect(d).toBeGreaterThanOrEqual(1_000);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });

  it("parses snapshot events and rejects anything else", () => {
    const snapshot: LiveSnapshot = {
      generatedAt: "2026-11-11T10:45:00.000Z",
      platform: { mode: "simulated" },
      summary: { runs: emptyRunCounts(), pendingApprovals: 0, openQuestions: 0, openIncidents: 0 },
      needsYou: { approvals: [], incidents: [], failedRuns: [], questions: [] },
      running: [],
      done: [],
      agents: [],
      timeline: [],
      schedules: [],
      communications: [],
      connectors: []
    };
    expect(parseSnapshotEvent(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(parseSnapshotEvent("not json")).toBeNull();
    expect(parseSnapshotEvent("null")).toBeNull();
    expect(parseSnapshotEvent(JSON.stringify({ generatedAt: "x" }))).toBeNull();
  });

  it("decodes the identifier-only LISTEN payload", () => {
    expect(parseNotification('{"table":"agent_runs","op":"UPDATE","id":"11111111-1111-1111-1111-111111111111","tenantId":"t","at":"2026-11-11T10:00:00Z"}')).toEqual({
      table: "agent_runs",
      op: "UPDATE",
      id: "11111111-1111-1111-1111-111111111111",
      tenantId: "t",
      at: "2026-11-11T10:00:00Z"
    });
    expect(parseNotification("{}")).toBeNull();
    expect(parseNotification("garbage")).toBeNull();
  });

  it("labels the connection state for the status strip", () => {
    expect(connectionLabel("connected")).toBe("stream connected");
    expect(connectionLabel("reconnecting")).toBe("reconnecting");
    expect(connectionLabel("polling")).toBe("polling every 5 s");
    expect(connectionLabel("connecting")).toBe("connecting");
  });

  it("formats relative times", () => {
    const now = new Date("2026-11-11T10:45:00.000Z");
    expect(fmtAgo("2026-11-11T10:44:50.000Z", now)).toBe("10 s ago");
    expect(fmtAgo("2026-11-11T10:30:00.000Z", now)).toBe("15 min ago");
    expect(fmtAgo("2026-11-11T07:45:00.000Z", now)).toBe("3 h ago");
    expect(fmtAgo(null, now)).toBe("n/a");
  });
});
