/**
 * Operations Deck (ADR-024, slice 4): pure helpers behind the agents table, the event ticker, the background worker
 * rows and the department filter. No I/O; unit-tested in test/live-deck.test.ts. The server query module calls
 * `buildWorkerRows` with the raw counts it read, so the shaping is testable without a database.
 */

import {
  buildSteps,
  departmentByDefinition,
  isRunState,
  type LaneFilters,
  type LiveAgent,
  type LiveApproval,
  type LiveEvent,
  type LiveRun,
  type LiveRunState,
  type LiveSnapshot,
  type LiveWorker,
  type WorkerQueue
} from "./helpers";

// Agents table ----------------------------------------------------------------------------------

/** Composite D order: alive and blocked first, then paused and error states, idle last. Unknown states sort last. */
export const AGENT_STATE_ORDER: Record<string, number> = {
  running: 0,
  queued: 1,
  waiting_for_approval: 2,
  waiting_for_input: 2,
  interrupted: 2,
  blocked: 2,
  paused: 3,
  error: 4,
  failed: 4,
  timed_out: 4,
  active: 5,
  idle: 6,
  disabled: 7
};

export interface DeckProgress {
  /** 1-based index of the current step; 0 before the first checkpoint. */
  index: number;
  /** Known steps: the checkpoints so far plus the pending "next" placeholder while the run is alive. */
  total: number;
  pct: number;
  label: string;
}

/**
 * "step i of n" from a run's checkpoint steps. The worker checkpoints the step it will resume at, and the names of
 * later steps are not knowable from summaries, so `n` counts the steps seen so far plus one pending step while the
 * run is alive (`buildSteps` adds it). A terminal run reads "step n of n". No checkpoint yet reads "no checkpoint yet".
 */
export function progressFor(steps: ReadonlyArray<string>, state: LiveRunState): DeckProgress {
  if (steps.length === 0) return { index: 0, total: 0, pct: 0, label: "no checkpoint yet" };
  const pills = buildSteps(steps.map((s) => `step ${s}`), state);
  const total = pills.length;
  const now = pills.findIndex((p) => p.status === "now");
  const index = now >= 0 ? now + 1 : pills.filter((p) => p.status === "done").length;
  const pct = Math.round((index / total) * 100);
  return { index, total, pct, label: `step ${index} of ${total}` };
}

export interface DeckAgentRow {
  agent: LiveAgent;
  /** The current run's state while one is alive, else the instance state. */
  state: string;
  run: LiveRun | null;
  step: string | null;
  progress: DeckProgress | null;
  lastActivityAt: string | null;
}

/** Effective state shown in the Deck: the alive run's state wins over the instance state. */
export function deckAgentState(agent: Pick<LiveAgent, "state">, run: Pick<LiveRun, "state"> | null): string {
  return run ? run.state : agent.state;
}

/**
 * Agents table rows with the filters applied (client, definition, department; the run state filter matches the
 * effective state), sorted by state order then last activity (newest first), then by name for a stable order.
 */
export function deckAgentRows(snapshot: Pick<LiveSnapshot, "agents" | "running">, f: LaneFilters): DeckAgentRow[] {
  const runsById = new Map(snapshot.running.map((r) => [r.id, r] as const));
  const rows: DeckAgentRow[] = [];
  for (const agent of snapshot.agents) {
    if (f.tenantId && agent.tenantId !== f.tenantId) continue;
    if (f.definitionKey && agent.definitionKey !== f.definitionKey) continue;
    if (f.department && agent.department !== f.department) continue;
    const run = agent.currentRunId ? (runsById.get(agent.currentRunId) ?? null) : null;
    const state = deckAgentState(agent, run);
    if (f.state && state !== f.state) continue;
    rows.push({
      agent,
      state,
      run,
      step: run?.step ?? null,
      progress: run ? progressFor(run.steps, run.state) : null,
      lastActivityAt: run?.lastEventAt && (!agent.lastActivityAt || run.lastEventAt > agent.lastActivityAt) ? run.lastEventAt : agent.lastActivityAt
    });
  }
  return sortDeckRows(rows);
}

export function sortDeckRows(rows: DeckAgentRow[]): DeckAgentRow[] {
  return [...rows].sort((a, b) => {
    const oa = AGENT_STATE_ORDER[a.state] ?? 9;
    const ob = AGENT_STATE_ORDER[b.state] ?? 9;
    if (oa !== ob) return oa - ob;
    const la = a.lastActivityAt ?? "";
    const lb = b.lastActivityAt ?? "";
    if (la !== lb) return lb.localeCompare(la);
    return a.agent.name.localeCompare(b.agent.name) || a.agent.tenantName.localeCompare(b.agent.tenantName);
  });
}

/** Whether an agent may be started from the Deck: no alive run and not paused or disabled (the action refuses those too). */
export function canRunNow(agent: Pick<LiveAgent, "state" | "currentRunId">): boolean {
  return agent.currentRunId === null && agent.state !== "paused" && agent.state !== "disabled";
}

/** Whether the row offers Pause (true) or Resume (false); null for a disabled agent, which the operator cannot toggle. */
export function pauseOrResume(agent: Pick<LiveAgent, "state">): "pause" | "resume" | null {
  if (agent.state === "disabled") return null;
  return agent.state === "paused" ? "resume" : "pause";
}

// Event ticker ----------------------------------------------------------------------------------

/**
 * Ticker rows with the filters applied: client by tenant, definition and department through the agent instance, run
 * state through the alive run (events of finished runs are hidden while a state filter is set, because their state is
 * not in the snapshot). Newest first; `limit` caps the list.
 */
export function filterEvents(snapshot: Pick<LiveSnapshot, "events" | "agents" | "running">, f: LaneFilters, limit = 120): LiveEvent[] {
  const agents = new Map(snapshot.agents.map((a) => [a.id, a] as const));
  const runState = new Map(snapshot.running.map((r) => [r.id, r.state] as const));
  const out = snapshot.events.filter((e) => {
    if (f.tenantId && e.tenantId !== f.tenantId) return false;
    const agent = agents.get(e.agentInstanceId);
    if (f.definitionKey && agent?.definitionKey !== f.definitionKey) return false;
    if (f.department && (agent?.department ?? null) !== f.department) return false;
    if (f.state && runState.get(e.runId) !== f.state) return false;
    return true;
  });
  return out.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.seq - a.seq).slice(0, limit);
}

/** Schedules with the client, definition and department filters applied (the run state filter does not apply). */
export function filterSchedules(snapshot: Pick<LiveSnapshot, "schedules" | "agents">, f: LaneFilters): LiveSnapshot["schedules"] {
  const departments = departmentByDefinition(snapshot.agents);
  return snapshot.schedules.filter((s) => {
    if (f.tenantId && s.tenantId !== f.tenantId) return false;
    if (f.definitionKey && s.definitionKey !== f.definitionKey) return false;
    if (f.department && (departments.get(s.definitionKey) ?? null) !== f.department) return false;
    return true;
  });
}

/** Approvals pass the department filter through their run's agent; an approval without a known agent stays visible. */
export function approvalMatchesDepartment(approval: Pick<LiveApproval, "agentInstanceId">, department: string | null, agents: ReadonlyArray<Pick<LiveAgent, "id" | "department">>): boolean {
  if (!department || !approval.agentInstanceId) return true;
  const agent = agents.find((a) => a.id === approval.agentInstanceId);
  if (!agent) return true;
  return agent.department === department;
}

/** Agents that pass the department filter (used by the Map and the Deck). */
export function agentsForDepartment<T extends Pick<LiveAgent, "department">>(agents: ReadonlyArray<T>, department: string | null): T[] {
  return department ? agents.filter((a) => a.department === department) : [...agents];
}

/** Department of a definition key through the snapshot's agents; null when unknown. */
export function departmentOfDefinition(agents: ReadonlyArray<Pick<LiveAgent, "definitionKey" | "department">>, definitionKey: string): string | null {
  return departmentByDefinition(agents).get(definitionKey) ?? null;
}

// Background workers ----------------------------------------------------------------------------

export const WORKER_LABELS: Record<WorkerQueue, { label: string; source: string }> = {
  "agent.run": { label: "Agent runs (new runs)", source: "agent_runs, trigger other than resume" },
  "agent.resume": { label: "Agent resumes (after approval, recovery)", source: "agent_runs, trigger resume" },
  "schedule.tick": { label: "Schedule ticks", source: "schedules and agent_runs with trigger schedule" },
  "connector.sync": { label: "Connector syncs", source: "sync_runs" },
  "notify.send": { label: "Notifications", source: "notifications" },
  "tech.watch": { label: "Tech watch (daily 06:00 UTC)", source: "tech_watch_runs" },
  "retention.sweep": { label: "Retention sweep (weekly, Sunday 03:00 UTC)", source: "retention_sweeps" }
};

/** Raw counts per source table as the query module reads them; `null` for a table the operator role cannot read. */
export interface WorkerCounts {
  runs: { queued: number; running: number; interrupted: number; succeeded24h: number; failed24h: number; lastAt: string | null } | null;
  resumes: { queued: number; running: number; interrupted: number; succeeded24h: number; failed24h: number; lastAt: string | null } | null;
  schedules: { enabled: number; dueWithinHour: number; runs24h: number; failed24h: number; lastAt: string | null } | null;
  syncs: { running: number; succeeded24h: number; failed24h: number; lastAt: string | null } | null;
  notifications: { queued: number; sent24h: number; failed24h: number; lastAt: string | null } | null;
  techWatch: { succeeded24h: number; failed24h: number; lastAt: string | null } | null;
  retention: { sweeps24h: number; lastAt: string | null } | null;
}

export const NOT_READABLE = "not readable by the operator role";

/**
 * Shapes the raw counts into one row per pg-boss queue. "Active" is what is executing now (running runs, running
 * syncs, enabled schedules), "queued" what waits for a worker (queued and interrupted runs, queued notifications,
 * schedules due within the hour), done and failed cover the last 24 hours. Sources without a number give null.
 */
export function buildWorkerRows(c: WorkerCounts): LiveWorker[] {
  const row = (queue: WorkerQueue, data: Omit<LiveWorker, "queue" | "label" | "source" | "readable" | "note"> | null, note: string | null = null): LiveWorker => ({
    queue,
    ...WORKER_LABELS[queue],
    active: data?.active ?? null,
    queued: data?.queued ?? null,
    done24h: data?.done24h ?? null,
    failed24h: data?.failed24h ?? null,
    lastAt: data?.lastAt ?? null,
    readable: data !== null,
    note: data === null ? NOT_READABLE : note
  });
  return [
    row("agent.run", c.runs ? { active: c.runs.running, queued: c.runs.queued + c.runs.interrupted, done24h: c.runs.succeeded24h, failed24h: c.runs.failed24h, lastAt: c.runs.lastAt } : null, c.runs && c.runs.interrupted > 0 ? `${c.runs.interrupted} interrupted run(s) wait for the recovery scan` : null),
    row("agent.resume", c.resumes ? { active: c.resumes.running, queued: c.resumes.queued + c.resumes.interrupted, done24h: c.resumes.succeeded24h, failed24h: c.resumes.failed24h, lastAt: c.resumes.lastAt } : null),
    row("schedule.tick", c.schedules ? { active: c.schedules.enabled, queued: c.schedules.dueWithinHour, done24h: c.schedules.runs24h, failed24h: c.schedules.failed24h, lastAt: c.schedules.lastAt } : null, c.schedules ? "active counts enabled schedules; queued counts schedules due within the hour" : null),
    row("connector.sync", c.syncs ? { active: c.syncs.running, queued: null, done24h: c.syncs.succeeded24h, failed24h: c.syncs.failed24h, lastAt: c.syncs.lastAt } : null),
    row("notify.send", c.notifications ? { active: null, queued: c.notifications.queued, done24h: c.notifications.sent24h, failed24h: c.notifications.failed24h, lastAt: c.notifications.lastAt } : null),
    row("tech.watch", c.techWatch ? { active: null, queued: null, done24h: c.techWatch.succeeded24h, failed24h: c.techWatch.failed24h, lastAt: c.techWatch.lastAt } : null),
    row("retention.sweep", c.retention ? { active: null, queued: null, done24h: c.retention.sweeps24h, failed24h: null, lastAt: c.retention.lastAt } : null, c.retention ? "failures are not recorded as sweeps; a failed sweep shows as a worker_error incident" : null)
  ];
}

/** Formats a worker count: "n/a" when the source does not track it. */
export function fmtWorkerCount(n: number | null): string {
  return n === null ? "n/a" : String(n);
}

// Schedules -------------------------------------------------------------------------------------

/** Tone for a schedule's last outcome (a run state) in the Deck. */
export function scheduleOutcomeTone(outcome: string | null): "success" | "danger" | "warning" | "neutral" {
  if (!outcome) return "neutral";
  if (!isRunState(outcome)) return "neutral";
  if (outcome === "succeeded") return "success";
  if (outcome === "failed" || outcome === "timed_out") return "danger";
  if (outcome === "cancelled") return "neutral";
  return "warning";
}
