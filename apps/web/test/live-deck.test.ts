import { describe, expect, it } from "vitest";
import {
  AGENT_STATE_ORDER,
  NOT_READABLE,
  approvalMatchesDepartment,
  buildWorkerRows,
  canRunNow,
  deckAgentRows,
  deckAgentState,
  filterEvents,
  filterSchedules,
  fmtWorkerCount,
  pauseOrResume,
  progressFor,
  scheduleOutcomeTone,
  sortDeckRows,
  type WorkerCounts
} from "../lib/live/deck";
import { EMPTY_FILTERS, buildRunList, departmentByDefinition, filterOptions, groupRuns, liveReturnTo, runMatches, type LiveAgent, type LiveEvent, type LiveRun, type LiveSchedule } from "../lib/live/helpers";

/** Live Mission Control slice 4 (ADR-024): pure helpers behind the Operations Deck and the department filter. */

function agent(partial: Partial<LiveAgent> & Pick<LiveAgent, "id" | "name">): LiveAgent {
  return {
    tenantId: "t1",
    tenantSlug: "acme",
    tenantName: "Acme",
    definitionKey: "discovery",
    definitionName: "Discovery",
    tier: "t1",
    department: "cross-functional",
    state: "idle",
    currentRunId: null,
    lastActivityAt: null,
    monthCostUsd: 0,
    runsToday: 0,
    ...partial
  };
}

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
    startedAt: "2026-11-12T10:00:00.000Z",
    createdAt: "2026-11-12T09:59:00.000Z",
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

function event(partial: Partial<LiveEvent> & Pick<LiveEvent, "id" | "seq">): LiveEvent {
  return { runId: "r1", agentInstanceId: "a1", agentName: "Discovery", tenantId: "t1", tenantName: "Acme", kind: "tool_call", summary: "tool vault.search", classification: "internal", costUsd: 0, tokens: 0, occurredAt: `2026-11-12T10:00:${String(partial.seq).padStart(2, "0")}.000Z`, ...partial };
}

const agents = [
  agent({ id: "a1", name: "Discovery", state: "running", currentRunId: "r1", lastActivityAt: "2026-11-12T09:00:00.000Z" }),
  agent({ id: "a2", name: "Finance", definitionKey: "finance-agent", definitionName: "Finance", department: "finance", state: "idle", lastActivityAt: "2026-11-12T09:30:00.000Z", monthCostUsd: 1.25, runsToday: 2 }),
  agent({ id: "a3", name: "Ops", definitionKey: "operations-agent", department: "operations", tenantId: "t2", tenantSlug: "zed", tenantName: "Zed", state: "paused", lastActivityAt: "2026-11-12T09:45:00.000Z" }),
  agent({ id: "a4", name: "Briefing", definitionKey: "executive-briefing", department: "management", state: "blocked", currentRunId: "r4", lastActivityAt: "2026-11-12T08:00:00.000Z" }),
  agent({ id: "a5", name: "Idle older", definitionKey: "finance-agent", department: "finance", state: "idle", lastActivityAt: "2026-11-12T07:00:00.000Z" })
];
const running = [
  run({ id: "r1", state: "running", agentInstanceId: "a1", steps: ["collect", "analyse"], step: "analyse", lastEventAt: "2026-11-12T10:05:00.000Z" }),
  run({ id: "r4", state: "waiting_for_approval", agentInstanceId: "a4", definitionKey: "executive-briefing", steps: ["draft", "request_publication"], step: "request_publication" })
];

describe("agents table", () => {
  it("takes the alive run's state over the instance state", () => {
    expect(deckAgentState({ state: "idle" }, { state: "running" })).toBe("running");
    expect(deckAgentState({ state: "paused" }, null)).toBe("paused");
  });

  it("sorts by state order, then last activity (newest first), then name", () => {
    const rows = deckAgentRows({ agents, running }, EMPTY_FILTERS);
    expect(rows.map((r) => r.agent.id)).toEqual(["r1", "r4", "a3", "a2", "a5"].map((x) => (x === "r1" ? "a1" : x === "r4" ? "a4" : x)));
    expect(rows.map((r) => r.state)).toEqual(["running", "waiting_for_approval", "paused", "idle", "idle"]);
    // The alive run's newest event counts as activity.
    expect(rows[0]!.lastActivityAt).toBe("2026-11-12T10:05:00.000Z");
    expect(AGENT_STATE_ORDER.running).toBeLessThan(AGENT_STATE_ORDER.idle!);
    const tie = sortDeckRows([
      { agent: agent({ id: "b", name: "Beta" }), state: "idle", run: null, step: null, progress: null, lastActivityAt: null },
      { agent: agent({ id: "a", name: "Alpha" }), state: "idle", run: null, step: null, progress: null, lastActivityAt: null }
    ]);
    expect(tie.map((r) => r.agent.name)).toEqual(["Alpha", "Beta"]);
  });

  it("applies client, definition, department and effective state filters", () => {
    expect(deckAgentRows({ agents, running }, { ...EMPTY_FILTERS, tenantId: "t2" }).map((r) => r.agent.id)).toEqual(["a3"]);
    expect(deckAgentRows({ agents, running }, { ...EMPTY_FILTERS, definitionKey: "finance-agent" }).map((r) => r.agent.id)).toEqual(["a2", "a5"]);
    expect(deckAgentRows({ agents, running }, { ...EMPTY_FILTERS, department: "management" }).map((r) => r.agent.id)).toEqual(["a4"]);
    expect(deckAgentRows({ agents, running }, { ...EMPTY_FILTERS, state: "running" }).map((r) => r.agent.id)).toEqual(["a1"]);
    expect(deckAgentRows({ agents, running }, { ...EMPTY_FILTERS, state: "waiting_for_approval" }).map((r) => r.agent.id)).toEqual(["a4"]);
  });

  it("builds the progress label from the run steps", () => {
    expect(progressFor([], "running")).toEqual({ index: 0, total: 0, pct: 0, label: "no checkpoint yet" });
    // Two checkpoints seen, the run is alive: the current step is the second of three known (two plus the pending next).
    expect(progressFor(["collect", "analyse"], "running")).toEqual({ index: 2, total: 3, pct: 67, label: "step 2 of 3" });
    // A run that checkpointed "done" has no pending step.
    expect(progressFor(["collect", "done"], "running")).toEqual({ index: 2, total: 2, pct: 100, label: "step 2 of 2" });
    expect(progressFor(["collect", "analyse"], "succeeded")).toEqual({ index: 2, total: 2, pct: 100, label: "step 2 of 2" });
    const rows = deckAgentRows({ agents, running }, EMPTY_FILTERS);
    expect(rows[0]!.progress?.label).toBe("step 2 of 3");
    expect(rows[0]!.step).toBe("analyse");
    expect(rows[2]!.progress).toBeNull();
  });

  it("offers Run now only without an alive run and Pause or Resume by instance state", () => {
    expect(canRunNow({ state: "idle", currentRunId: null })).toBe(true);
    expect(canRunNow({ state: "idle", currentRunId: "r1" })).toBe(false);
    expect(canRunNow({ state: "paused", currentRunId: null })).toBe(false);
    expect(canRunNow({ state: "disabled", currentRunId: null })).toBe(false);
    expect(pauseOrResume({ state: "idle" })).toBe("pause");
    expect(pauseOrResume({ state: "running" })).toBe("pause");
    expect(pauseOrResume({ state: "paused" })).toBe("resume");
    expect(pauseOrResume({ state: "disabled" })).toBeNull();
  });
});

describe("event ticker", () => {
  const events = [event({ id: "e3", seq: 3, runId: "r4", agentInstanceId: "a4", kind: "approval_requested" }), event({ id: "e2", seq: 2, kind: "model_call", tokens: 120, costUsd: 0.001 }), event({ id: "e1", seq: 1, tenantId: "t2", agentInstanceId: "a3", runId: "r9" })];

  it("keeps newest first and applies client, definition, department and state filters", () => {
    expect(filterEvents({ events: [...events].reverse(), agents, running }, EMPTY_FILTERS).map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
    expect(filterEvents({ events, agents, running }, { ...EMPTY_FILTERS, tenantId: "t2" }).map((e) => e.id)).toEqual(["e1"]);
    expect(filterEvents({ events, agents, running }, { ...EMPTY_FILTERS, definitionKey: "executive-briefing" }).map((e) => e.id)).toEqual(["e3"]);
    expect(filterEvents({ events, agents, running }, { ...EMPTY_FILTERS, department: "cross-functional" }).map((e) => e.id)).toEqual(["e2"]);
    expect(filterEvents({ events, agents, running }, { ...EMPTY_FILTERS, state: "waiting_for_approval" }).map((e) => e.id)).toEqual(["e3"]);
    // Events of a run that is no longer in the snapshot are hidden while a state filter is set.
    expect(filterEvents({ events, agents, running }, { ...EMPTY_FILTERS, state: "running" }).map((e) => e.id)).toEqual(["e2"]);
    expect(filterEvents({ events, agents, running }, EMPTY_FILTERS, 2).map((e) => e.id)).toEqual(["e3", "e2"]);
  });
});

describe("background workers", () => {
  const counts: WorkerCounts = {
    runs: { queued: 2, running: 1, interrupted: 1, succeeded24h: 9, failed24h: 1, lastAt: "2026-11-12T10:00:00.000Z" },
    resumes: { queued: 0, running: 0, interrupted: 0, succeeded24h: 3, failed24h: 0, lastAt: null },
    schedules: { enabled: 2, dueWithinHour: 1, runs24h: 4, failed24h: 0, lastAt: "2026-11-12T06:00:00.000Z" },
    syncs: { running: 0, succeeded24h: 4, failed24h: 0, lastAt: "2026-11-12T05:00:00.000Z" },
    notifications: { queued: 0, sent24h: 19, failed24h: 0, lastAt: "2026-11-12T04:00:00.000Z" },
    techWatch: null,
    retention: { sweeps24h: 0, lastAt: null }
  };

  it("shapes one row per pg-boss queue with queued = queued plus interrupted and marks unreadable sources", () => {
    const rows = buildWorkerRows(counts);
    expect(rows.map((r) => r.queue)).toEqual(["agent.run", "agent.resume", "schedule.tick", "connector.sync", "notify.send", "tech.watch", "retention.sweep"]);
    expect(rows[0]).toMatchObject({ active: 1, queued: 3, done24h: 9, failed24h: 1, lastAt: "2026-11-12T10:00:00.000Z", readable: true });
    expect(rows[0]!.note).toContain("1 interrupted");
    expect(rows[1]).toMatchObject({ active: 0, queued: 0, done24h: 3, failed24h: 0, lastAt: null, readable: true, note: null });
    expect(rows[2]).toMatchObject({ active: 2, queued: 1, done24h: 4, failed24h: 0 });
    expect(rows[3]).toMatchObject({ active: 0, queued: null, done24h: 4, failed24h: 0 });
    expect(rows[4]).toMatchObject({ active: null, queued: 0, done24h: 19, failed24h: 0 });
    expect(rows[5]).toMatchObject({ readable: false, active: null, queued: null, done24h: null, failed24h: null, lastAt: null, note: NOT_READABLE });
    expect(rows[6]).toMatchObject({ readable: true, done24h: 0, failed24h: null, lastAt: null });
    expect(rows.every((r) => r.label.length > 0 && r.source.length > 0)).toBe(true);
  });

  it("formats untracked counts as n/a", () => {
    expect(fmtWorkerCount(null)).toBe("n/a");
    expect(fmtWorkerCount(0)).toBe("0");
    expect(fmtWorkerCount(12)).toBe("12");
  });
});

describe("schedules", () => {
  const schedules: LiveSchedule[] = [
    { id: "s1", tenantId: "t1", tenantName: "Acme", agentName: "Finance", definitionKey: "finance-agent", cron: "0 6 * * *", timezone: "UTC", enabled: true, nextRunAt: null, lastRunAt: null, lastOutcome: "succeeded" },
    { id: "s2", tenantId: "t2", tenantName: "Zed", agentName: "Ops", definitionKey: "operations-agent", cron: "0 7 * * *", timezone: "UTC", enabled: false, nextRunAt: null, lastRunAt: null, lastOutcome: null }
  ];

  it("filters schedules by client, definition and department through the agents", () => {
    expect(filterSchedules({ schedules, agents }, EMPTY_FILTERS).map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(filterSchedules({ schedules, agents }, { ...EMPTY_FILTERS, tenantId: "t2" }).map((s) => s.id)).toEqual(["s2"]);
    expect(filterSchedules({ schedules, agents }, { ...EMPTY_FILTERS, definitionKey: "finance-agent" }).map((s) => s.id)).toEqual(["s1"]);
    expect(filterSchedules({ schedules, agents }, { ...EMPTY_FILTERS, department: "operations" }).map((s) => s.id)).toEqual(["s2"]);
    expect(filterSchedules({ schedules, agents }, { ...EMPTY_FILTERS, state: "running" }).map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("tones the last outcome", () => {
    expect(scheduleOutcomeTone("succeeded")).toBe("success");
    expect(scheduleOutcomeTone("failed")).toBe("danger");
    expect(scheduleOutcomeTone("timed_out")).toBe("danger");
    expect(scheduleOutcomeTone("running")).toBe("warning");
    expect(scheduleOutcomeTone("cancelled")).toBe("neutral");
    expect(scheduleOutcomeTone(null)).toBe("neutral");
    expect(scheduleOutcomeTone("something")).toBe("neutral");
  });
});

describe("department filter", () => {
  it("derives departments per definition and the select options from the agents", () => {
    const map = departmentByDefinition(agents);
    expect(map.get("discovery")).toBe("cross-functional");
    expect(map.get("finance-agent")).toBe("finance");
    expect(map.get("unknown")).toBeUndefined();
    expect(filterOptions({ agents }).departments).toEqual(["cross-functional", "finance", "management", "operations"]);
    expect(filterOptions({ agents: [agent({ id: "x", name: "X", department: null })] }).departments).toEqual([]);
  });

  it("matches runs through their definition's department and hides runs of unknown departments", () => {
    const map = departmentByDefinition(agents);
    const r = { tenantId: "t1", definitionKey: "finance-agent", state: "running" as const };
    expect(runMatches(r, { ...EMPTY_FILTERS, department: "finance" }, map)).toBe(true);
    expect(runMatches(r, { ...EMPTY_FILTERS, department: "operations" }, map)).toBe(false);
    expect(runMatches({ ...r, definitionKey: "unknown" }, { ...EMPTY_FILTERS, department: "finance" }, map)).toBe(false);
    expect(runMatches(r, { ...EMPTY_FILTERS, department: "finance" })).toBe(false);
    expect(runMatches(r, EMPTY_FILTERS)).toBe(true);
  });

  it("applies the department on the lanes and the run list", () => {
    const snapshot = {
      agents,
      running,
      done: [{ id: "d1", tenantId: "t1", tenantName: "Acme", agentName: "Finance", definitionKey: "finance-agent", trigger: "schedule", state: "succeeded" as const, summary: null, costUsd: 0, toolCalls: 0, modelCalls: 0, simulated: true, startedAt: "2026-11-12T08:00:00.000Z", finishedAt: "2026-11-12T08:10:00.000Z" }],
      needsYou: {
        approvals: [],
        incidents: [],
        questions: [],
        failedRuns: [{ id: "f1", tenantId: "t2", tenantName: "Zed", agentName: "Ops", definitionKey: "operations-agent", trigger: "command", state: "failed" as const, errorCode: "model", summary: null, startedAt: null, finishedAt: "2026-11-12T08:20:00.000Z", costUsd: 0, toolCalls: 0, modelCalls: 0 }]
      }
    };
    const finance = groupRuns(snapshot, { ...EMPTY_FILTERS, department: "finance" });
    expect(finance.running).toEqual([]);
    expect(finance.done.map((r) => r.id)).toEqual(["d1"]);
    expect(finance.failed).toEqual([]);
    const ops = groupRuns(snapshot, { ...EMPTY_FILTERS, department: "operations" });
    expect(ops.failed.map((r) => r.id)).toEqual(["f1"]);
    expect(groupRuns(snapshot, { ...EMPTY_FILTERS, department: "management" }).running.map((r) => r.id)).toEqual(["r4"]);
    expect(buildRunList(snapshot, { ...EMPTY_FILTERS, department: "cross-functional" }).map((r) => r.id)).toEqual(["r1"]);
    expect(buildRunList(snapshot, { ...EMPTY_FILTERS, department: "operations", state: "failed" }).map((r) => r.id)).toEqual(["f1"]);
    // Without agents in the snapshot a department filter matches nothing.
    expect(buildRunList({ ...snapshot, agents: undefined }, { ...EMPTY_FILTERS, department: "finance" })).toEqual([]);
  });

  it("applies the department on approvals through the run's agent and keeps unknown agents visible", () => {
    expect(approvalMatchesDepartment({ agentInstanceId: "a2" }, "finance", agents)).toBe(true);
    expect(approvalMatchesDepartment({ agentInstanceId: "a2" }, "operations", agents)).toBe(false);
    expect(approvalMatchesDepartment({ agentInstanceId: null }, "operations", agents)).toBe(true);
    expect(approvalMatchesDepartment({ agentInstanceId: "missing" }, "operations", agents)).toBe(true);
    expect(approvalMatchesDepartment({ agentInstanceId: "a2" }, null, agents)).toBe(true);
  });

  it("keeps the department in the return path next to the tab and the run", () => {
    expect(liveReturnTo("deck", null, "finance")).toBe("/mission-control/live?tab=deck&department=finance");
    expect(liveReturnTo("queue", null, null)).toBe("/mission-control/live");
    expect(liveReturnTo("queue", "11111111-1111-1111-1111-111111111111", "cross-functional")).toBe("/mission-control/live?run=11111111-1111-1111-1111-111111111111&department=cross-functional");
  });
});
