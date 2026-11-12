/**
 * Live Mission Control (ADR-024, slice 1): shared snapshot types and pure helpers used by the server queries,
 * the client hook and the board. No I/O here; everything is unit-tested in test/live.test.ts.
 *
 * Dates travel as ISO strings so the snapshot is plain JSON for the server-sent event stream.
 */

import type { LiveCommunication } from "./graph";

export const RUN_STATES = ["queued", "running", "waiting_for_input", "waiting_for_approval", "paused", "succeeded", "failed", "cancelled", "timed_out", "interrupted"] as const;
export type LiveRunState = (typeof RUN_STATES)[number];

export const ACTIVE_RUN_STATES: readonly LiveRunState[] = ["queued", "running", "waiting_for_input", "waiting_for_approval", "paused", "interrupted"];
export const TERMINAL_RUN_STATES: readonly LiveRunState[] = ["succeeded", "failed", "cancelled", "timed_out"];

export interface LiveApproval {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  agentName: string | null;
  runId: string | null;
  risk: string;
  approverRole: string;
  summary: string;
  blocking: boolean;
  createdAt: string;
  operatorMayDecide: boolean;
  /** Agent instance behind the approval's run; null when the approval has no run. Lets the department filter apply (slice 4). */
  agentInstanceId: string | null;
}

export interface LiveIncident {
  id: string;
  kind: string;
  severity: string;
  title: string;
  state: string;
  tenantName: string | null;
  runId: string | null;
  createdAt: string;
}

export interface LiveFailedRun {
  id: string;
  tenantId: string;
  tenantName: string;
  agentName: string;
  definitionKey: string;
  trigger: string;
  state: LiveRunState;
  errorCode: string | null;
  summary: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  costUsd: number;
  toolCalls: number;
  modelCalls: number;
}

export interface LiveOpenQuestions {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  count: number;
  /** Department counts; the operator role is granted `department`, never the question text. */
  byDepartment: Array<{ department: string; count: number }>;
}

export interface LiveRun {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  agentInstanceId: string;
  agentName: string;
  definitionKey: string;
  trigger: string;
  state: LiveRunState;
  attempt: number;
  startedAt: string | null;
  createdAt: string;
  /** Step named by the latest checkpoint event ("step <name>"); null when the run has not checkpointed yet. */
  step: string | null;
  /** Steps traversed so far, in order, from checkpoint events. */
  steps: string[];
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  /** Counts of run_events by kind (slice 2); cheap subselects on the indexed (run_id, seq) pair. */
  toolCalls: number;
  modelCalls: number;
  simulated: boolean;
  lastEventAt: string | null;
  lastEventSummary: string | null;
  lastEventKind: string | null;
}

export interface LiveDoneRun {
  id: string;
  tenantId: string;
  tenantName: string;
  agentName: string;
  definitionKey: string;
  trigger: string;
  state: LiveRunState;
  summary: string | null;
  costUsd: number;
  toolCalls: number;
  modelCalls: number;
  simulated: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface LiveAgent {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  definitionKey: string;
  name: string;
  state: string;
  currentRunId: string | null;
  lastActivityAt: string | null;
  /** Operations Deck (slice 4): definition metadata and month cost. */
  definitionName: string;
  /** `agent_definitions.authority` (t1, t2, t3). */
  tier: string;
  department: string | null;
  /** Sum of cost_events this calendar month (UTC) for this instance; cost_events is granted to the operator role. */
  monthCostUsd: number;
  /** Runs created in the last 24 hours. */
  runsToday: number;
}

/** One row of the Deck's live event ticker: run_events metadata (summary, never the payload), classification public or internal only. */
export interface LiveEvent {
  id: string;
  seq: number;
  runId: string;
  agentInstanceId: string;
  agentName: string;
  tenantId: string;
  tenantName: string;
  kind: string;
  summary: string;
  classification: string;
  costUsd: number;
  tokens: number;
  occurredAt: string;
}

export const WORKER_QUEUES = ["agent.run", "agent.resume", "schedule.tick", "connector.sync", "notify.send", "tech.watch", "retention.sweep"] as const;
export type WorkerQueue = (typeof WORKER_QUEUES)[number];

/**
 * Background worker row (Deck). pg-boss keeps its own tables in a schema the operator role cannot read, so every count is
 * derived from domain tables the operator may read; `null` means the source does not track that number. `readable`
 * is false when the source table is not granted to the operator role, with the reason in `note`.
 */
export interface LiveWorker {
  queue: WorkerQueue;
  label: string;
  source: string;
  active: number | null;
  queued: number | null;
  done24h: number | null;
  failed24h: number | null;
  lastAt: string | null;
  readable: boolean;
  note: string | null;
}

export interface LiveStateChange {
  runId: string;
  agentInstanceId: string;
  agentName: string;
  tenantName: string;
  /** State after the change, parsed from the event summary or taken from the run's current state for its last event. */
  to: LiveRunState | null;
  at: string;
  seq: number;
}

export interface LiveSchedule {
  id: string;
  tenantId: string;
  tenantName: string;
  agentName: string;
  definitionKey: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastOutcome: string | null;
}

/** A client connection the Flight Map draws along the top (slice 3): read_only or sandbox phase; `live` when its latest sync run ran in live mode. */
export interface LiveConnector {
  tenantId: string;
  provider: string;
  live: boolean;
}

export interface LiveSnapshot {
  generatedAt: string;
  platform: { mode: "live" | "simulated" };
  summary: {
    runs: Record<LiveRunState, number>;
    pendingApprovals: number;
    openQuestions: number;
    openIncidents: number;
  };
  needsYou: {
    approvals: LiveApproval[];
    incidents: LiveIncident[];
    failedRuns: LiveFailedRun[];
    questions: LiveOpenQuestions[];
  };
  running: LiveRun[];
  done: LiveDoneRun[];
  agents: LiveAgent[];
  timeline: LiveStateChange[];
  schedules: LiveSchedule[];
  /** Flight Map (slice 3): run_events of the last 20 minutes mapped to communication targets, newest last, capped at 400. */
  communications: LiveCommunication[];
  connectors: LiveConnector[];
  /** Operations Deck (slice 4): newest 120 run_events across tenants (newest first) and the derived worker rows. */
  events: LiveEvent[];
  workers: LiveWorker[];
}

export function emptyRunCounts(): Record<LiveRunState, number> {
  const out = {} as Record<LiveRunState, number>;
  for (const s of RUN_STATES) out[s] = 0;
  return out;
}

export function isRunState(value: string): value is LiveRunState {
  return (RUN_STATES as readonly string[]).includes(value);
}

// Lanes ---------------------------------------------------------------------------------------

export type Lane = "needs_you" | "running" | "done" | "none";

/**
 * Which Queue lane a run belongs to by state. Waiting states are "running" (the agent is alive and blocked;
 * the matching approval or question card sits in "needs you"), failed and timed out runs are "needs you",
 * succeeded and cancelled runs are "done".
 */
export function laneForRunState(state: LiveRunState): Lane {
  switch (state) {
    case "failed":
    case "timed_out":
      return "needs_you";
    case "succeeded":
    case "cancelled":
      return "done";
    case "queued":
    case "running":
    case "waiting_for_input":
    case "waiting_for_approval":
    case "paused":
    case "interrupted":
      return "running";
    default:
      return "none";
  }
}

export interface LaneFilters {
  tenantId: string | null;
  definitionKey: string | null;
  state: LiveRunState | null;
  /** Department of the agent definition (slice 4); applies on every tab. */
  department: string | null;
}

export const EMPTY_FILTERS: LaneFilters = { tenantId: null, definitionKey: null, state: null, department: null };

/** Department per agent definition key, read from the agents in the snapshot (the operator role is granted agent_definitions). */
export type DepartmentMap = ReadonlyMap<string, string | null>;

export function departmentByDefinition(agents: ReadonlyArray<Pick<LiveAgent, "definitionKey" | "department">>): DepartmentMap {
  const out = new Map<string, string | null>();
  for (const a of agents) if (!out.has(a.definitionKey)) out.set(a.definitionKey, a.department);
  return out;
}

/**
 * Whether a run passes the filters. The department filter resolves through the run's definition key; without a
 * department map (or for an unknown definition) a department filter hides the run, so a filtered view never shows a
 * run whose department is unknown as if it matched.
 */
export function runMatches(run: { tenantId: string; definitionKey: string; state: LiveRunState }, f: LaneFilters, departments?: DepartmentMap): boolean {
  if (f.tenantId && run.tenantId !== f.tenantId) return false;
  if (f.definitionKey && run.definitionKey !== f.definitionKey) return false;
  if (f.state && run.state !== f.state) return false;
  if (f.department && (departments?.get(run.definitionKey) ?? null) !== f.department) return false;
  return true;
}

type RunsSnapshot = Pick<LiveSnapshot, "running" | "done" | "needsYou"> & Partial<Pick<LiveSnapshot, "agents">>;

/** Groups the snapshot's runs into the three lanes with the filters applied. Running first by start time (newest first). */
export function groupRuns(snapshot: RunsSnapshot, f: LaneFilters): { running: LiveRun[]; done: LiveDoneRun[]; failed: LiveFailedRun[] } {
  const departments = departmentByDefinition(snapshot.agents ?? []);
  const running = snapshot.running.filter((r) => laneForRunState(r.state) === "running" && runMatches(r, f, departments)).sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt));
  const done = snapshot.done.filter((r) => laneForRunState(r.state) === "done" && runMatches(r, f, departments)).sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
  const failed = snapshot.needsYou.failedRuns.filter((r) => laneForRunState(r.state) === "needs_you" && runMatches(r, { ...f, definitionKey: null }, departments));
  return { running, done, failed };
}

// State parsing -------------------------------------------------------------------------------

/**
 * Derives the target state of a `state_change` event from its summary. The operator role cannot read
 * `run_events.payload` (where `to` lives), so this uses the summaries `@sbos/core` and the worker write:
 * "queued (trigger: x)", "started", "resumed", "waiting for approval", "re-queued after approval",
 * "cancelled: ...", "failed: ...", "budget hard stop", "dead-letter: ...", "lease expired", ... Returns null when unknown.
 */
export function parseStateFromSummary(summary: string): LiveRunState | null {
  const s = summary.trim().toLowerCase();
  if (s.length === 0) return null;
  const head = s.split(/[\s:(,]/)[0] ?? "";
  if (head === "re-queued" || head === "requeued") return "queued";
  if (isRunState(head)) return head;
  if (head === "started" || head === "resumed" || head === "running") return "running";
  if (s.startsWith("waiting for approval")) return "waiting_for_approval";
  if (s.startsWith("waiting for input")) return "waiting_for_input";
  if (s.startsWith("timed out")) return "timed_out";
  if (s.startsWith("budget hard stop") || s.startsWith("dead-letter") || s.startsWith("no flow")) return "failed";
  if (s.startsWith("lease expired")) return "interrupted";
  if (s.startsWith("paused")) return "paused";
  return null;
}

/** "step <name>" (what the worker writes at every checkpoint) -> "<name>"; anything else -> null. */
export function parseStepFromSummary(summary: string | null | undefined): string | null {
  if (!summary) return null;
  const m = /^step\s+(\S+)/i.exec(summary.trim());
  return m ? m[1]! : null;
}

// Timeline ------------------------------------------------------------------------------------

export interface TimelineSegment {
  runId: string;
  state: LiveRunState;
  leftPct: number;
  widthPct: number;
  from: string;
  to: string;
}

export interface TimelineTrack {
  agentInstanceId: string;
  label: string;
  segments: TimelineSegment[];
}

export interface TimelineWindow {
  start: string;
  end: string;
  tracks: TimelineTrack[];
}

/**
 * Turns state_change events into per-agent CSS bar segments for the window [now - windowMs, now].
 * Each event starts a segment that ends at the next event of the same run, or at `now` when the run is still open.
 * Events whose `to` is unknown are skipped. Segments are clipped to the window; the minimum width keeps a
 * sub-second state visible.
 */
export function buildTimeline(events: LiveStateChange[], now: Date, windowMs = 45 * 60_000): TimelineWindow {
  const end = now.getTime();
  const start = end - windowMs;
  const byRun = new Map<string, LiveStateChange[]>();
  for (const e of events) {
    const list = byRun.get(e.runId) ?? [];
    list.push(e);
    byRun.set(e.runId, list);
  }
  const tracks = new Map<string, TimelineTrack>();
  for (const list of byRun.values()) {
    list.sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (!e.to) continue;
      const s0 = Date.parse(e.at);
      const next = list[i + 1];
      const isTerminal = (TERMINAL_RUN_STATES as readonly string[]).includes(e.to);
      const e0 = next ? Date.parse(next.at) : isTerminal ? s0 : end;
      const clippedStart = Math.max(s0, start);
      const clippedEnd = Math.min(e0, end);
      if (clippedEnd < start || clippedStart > end) continue;
      const widthPct = Math.min(100, Math.max(0.6, ((clippedEnd - clippedStart) / windowMs) * 100));
      // A segment at the right edge ("now") keeps its minimum width by shifting left instead of collapsing to zero.
      const leftPct = Math.min(((clippedStart - start) / windowMs) * 100, 100 - widthPct);
      const track = tracks.get(e.agentInstanceId) ?? { agentInstanceId: e.agentInstanceId, label: `${e.agentName} · ${e.tenantName}`, segments: [] };
      track.segments.push({ runId: e.runId, state: e.to, leftPct: round2(leftPct), widthPct: round2(widthPct), from: new Date(clippedStart).toISOString(), to: new Date(clippedEnd).toISOString() });
      tracks.set(e.agentInstanceId, track);
    }
  }
  const sorted = [...tracks.values()].sort((a, b) => a.label.localeCompare(b.label));
  for (const t of sorted) t.segments.sort((a, b) => a.leftPct - b.leftPct);
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), tracks: sorted };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Stream client helpers -----------------------------------------------------------------------

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

/**
 * Exponential backoff with jitter for EventSource reconnects: 1 s, 2 s, 4 s ... capped at 30 s, plus up to 25 %
 * jitter from `random` (0..1). `attempt` starts at 0.
 */
export function backoffDelay(attempt: number, random = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, Math.min(attempt, 10)));
  const jitter = Math.floor(base * 0.25 * Math.max(0, Math.min(1, random())));
  return Math.min(BACKOFF_MAX_MS, base + jitter);
}

/** Parses the JSON body of a `snapshot` event. Returns null for anything that is not a snapshot object. */
export function parseSnapshotEvent(data: string): LiveSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.generatedAt !== "string" || !Array.isArray(o.running) || !Array.isArray(o.done) || !Array.isArray(o.agents) || !o.summary || !o.needsYou) return null;
  return parsed as LiveSnapshot;
}

/** Decodes the LISTEN payload written by `notify_live_change()`; identifiers only. */
export interface LiveNotification {
  table: string;
  op: string;
  id: string;
  tenantId: string | null;
  at: string;
}

export function parseNotification(payload: string): LiveNotification | null {
  try {
    const o = JSON.parse(payload) as Record<string, unknown>;
    if (typeof o.table !== "string" || typeof o.id !== "string") return null;
    return { table: o.table, op: typeof o.op === "string" ? o.op : "UPDATE", id: o.id, tenantId: typeof o.tenantId === "string" ? o.tenantId : null, at: typeof o.at === "string" ? o.at : new Date().toISOString() };
  } catch {
    return null;
  }
}

/** Human-readable connection label for the status strip. */
export type ConnectionState = "connecting" | "connected" | "reconnecting" | "polling";

export function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case "connected":
      return "stream connected";
    case "reconnecting":
      return "reconnecting";
    case "polling":
      return "polling every 5 s";
    default:
      return "connecting";
  }
}

/** Relative time for cards ("12 s ago", "3 min ago", "2 h ago"). */
export function fmtAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "n/a";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "n/a";
  const diff = Math.max(0, now.getTime() - t);
  if (diff < 60_000) return `${Math.floor(diff / 1000)} s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return `${Math.floor(diff / 86_400_000)} d ago`;
}

/** Clock label "HH:MM" in UTC for the timeline axis. */
export function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
}

/** Options for the filter selects, derived from the snapshot (no extra query). */
export function filterOptions(snapshot: Pick<LiveSnapshot, "agents">): { tenants: Array<{ id: string; name: string }>; definitions: string[]; departments: string[] } {
  const tenants = new Map<string, string>();
  const definitions = new Set<string>();
  const departments = new Set<string>();
  for (const a of snapshot.agents) {
    tenants.set(a.tenantId, a.tenantName);
    definitions.add(a.definitionKey);
    if (a.department) departments.add(a.department);
  }
  return { tenants: [...tenants].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)), definitions: [...definitions].sort(), departments: [...departments].sort() };
}

// Run Inspector (slice 2) --------------------------------------------------------------------

export function isTerminalRunState(state: string): boolean {
  return (TERMINAL_RUN_STATES as readonly string[]).includes(state);
}

export interface LiveRunHeader {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  agentInstanceId: string;
  agentName: string;
  definitionKey: string;
  trigger: string;
  triggerRef: string | null;
  state: LiveRunState;
  attempt: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  toolCalls: number;
  modelCalls: number;
  simulated: boolean;
  summary: string | null;
  /** `agent_runs.error ->> 'code'` (metadata column, granted); null when the run did not fail. */
  errorCode: string | null;
  parentRunId: string | null;
}

export type StepStatus = "done" | "now" | "pending";

export interface LiveRunStep {
  name: string;
  status: StepStatus;
}

export interface LiveRunEvent {
  id: string;
  seq: number;
  kind: string;
  classification: string;
  summary: string;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  durationMs: number | null;
  occurredAt: string;
}

export interface LiveRunInstruction {
  id: string;
  text: string;
  createdByActorId: string;
  createdAt: string;
  consumedAt: string | null;
  consumedAtStep: string | null;
}

export interface LiveRunDetail {
  run: LiveRunHeader;
  steps: LiveRunStep[];
  /** Newest first, capped at EVENTS_CAP. */
  events: LiveRunEvent[];
  eventsTotal: number;
  instructions: LiveRunInstruction[];
  approvals: Array<{ id: string; state: string; risk: string; approverRole: string; summary: string; createdAt: string; operatorMayDecide: boolean }>;
  incidents: Array<{ id: string; kind: string; severity: string; title: string; state: string; createdAt: string }>;
  task: { id: string; title: string; priority: string; state: string } | null;
  childRuns: Array<{ id: string; agentName: string; state: LiveRunState }>;
}

export const EVENTS_CAP = 300;

/**
 * Step pills from checkpoint event summaries ("step <name>", in seq order). Names are de-duplicated keeping the first
 * occurrence (a run that resumes re-checkpoints the same step). While the run is alive the latest checkpoint is "now"
 * and a trailing "next" placeholder is "pending": the worker checkpoints the step it will resume at, and the names of
 * later steps are not knowable from summaries. A terminal run has only "done" steps.
 */
export function buildSteps(checkpointSummaries: ReadonlyArray<string | null | undefined>, state: LiveRunState): LiveRunStep[] {
  const names: string[] = [];
  for (const s of checkpointSummaries) {
    const name = parseStepFromSummary(s);
    if (name && !names.includes(name)) names.push(name);
  }
  if (isTerminalRunState(state)) return names.map((name) => ({ name, status: "done" as const }));
  const steps: LiveRunStep[] = names.map((name, i) => ({ name, status: i === names.length - 1 ? "now" : "done" }));
  if (names[names.length - 1] !== "done") steps.push({ name: "next", status: "pending" });
  return steps;
}

export const EVENT_FILTERS = ["all", "tools", "model", "state", "approvals", "errors"] as const;
export type EventFilter = (typeof EVENT_FILTERS)[number];

export function isEventFilter(value: string): value is EventFilter {
  return (EVENT_FILTERS as readonly string[]).includes(value);
}

/** Kind groups behind the inspector's event filter. "errors" includes tool_denied, which also shows under "tools". */
export function eventMatchesFilter(kind: string, filter: EventFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "tools":
      return kind === "tool_call" || kind === "tool_denied";
    case "model":
      return kind === "model_call";
    case "state":
      return kind === "state_change" || kind === "checkpoint" || kind === "step_started" || kind === "step_finished";
    case "approvals":
      return kind === "approval_requested" || kind === "approval_decided" || kind === "question_created" || kind === "help_request";
    case "errors":
      return kind === "error" || kind === "tool_denied";
    default:
      return false;
  }
}

export type EventTone = "cyan" | "indigo" | "warning" | "danger" | "neutral";

/** Composite D colours: cyan tool_call, indigo model_call, amber approval_requested and question_created, red error and tool_denied. */
export function eventKindTone(kind: string): EventTone {
  switch (kind) {
    case "tool_call":
      return "cyan";
    case "model_call":
      return "indigo";
    case "approval_requested":
    case "question_created":
      return "warning";
    case "error":
    case "tool_denied":
      return "danger";
    default:
      return "neutral";
  }
}

/**
 * Duration of a run: from startedAt to finishedAt, or to `now` while it is alive. "n/a" before the run started.
 * "850 ms", "12 s", "3 min 05 s", "2 h 07 min".
 */
export function fmtRunDuration(startedAt: string | null | undefined, finishedAt: string | null | undefined, now: Date): string {
  if (!startedAt) return "n/a";
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "n/a";
  const end = finishedAt ? Date.parse(finishedAt) : now.getTime();
  if (Number.isNaN(end)) return "n/a";
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms} ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min ${String(totalSeconds % 60).padStart(2, "0")} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** Clock label "HH:MM:SS" in UTC for the event feed. */
export function fmtClockSeconds(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}Z`;
}

// Run list (Runs tab) ---------------------------------------------------------------------------

export interface RunListRow {
  id: string;
  tenantId: string;
  tenantName: string;
  agentName: string;
  definitionKey: string;
  trigger: string;
  state: LiveRunState;
  startedAt: string | null;
  finishedAt: string | null;
  /** Sort key: start time for alive runs, finish time for terminal ones (falls back to creation time). */
  sortAt: string;
  costUsd: number;
  toolCalls: number;
  modelCalls: number;
  simulated: boolean;
  errorCode: string | null;
}

/**
 * Rows for the Runs tab: the snapshot's alive runs and the runs finished in the last 24 hours, with the shared
 * filters applied. Failed and timed out runs live in the "needs you" lane; they join the list when the state filter
 * asks for them. Alive runs first (newest start first), then terminal runs (newest finish first).
 */
export function buildRunList(snapshot: RunsSnapshot, f: LaneFilters): RunListRow[] {
  const departments = departmentByDefinition(snapshot.agents ?? []);
  const rows: RunListRow[] = [];
  for (const r of snapshot.running) {
    if (!runMatches(r, f, departments)) continue;
    rows.push({ id: r.id, tenantId: r.tenantId, tenantName: r.tenantName, agentName: r.agentName, definitionKey: r.definitionKey, trigger: r.trigger, state: r.state, startedAt: r.startedAt, finishedAt: null, sortAt: r.startedAt ?? r.createdAt, costUsd: r.costUsd, toolCalls: r.toolCalls, modelCalls: r.modelCalls, simulated: r.simulated, errorCode: null });
  }
  for (const r of snapshot.done) {
    if (!runMatches(r, f, departments)) continue;
    rows.push({ id: r.id, tenantId: r.tenantId, tenantName: r.tenantName, agentName: r.agentName, definitionKey: r.definitionKey, trigger: r.trigger, state: r.state, startedAt: r.startedAt, finishedAt: r.finishedAt, sortAt: r.finishedAt ?? r.startedAt ?? "", costUsd: r.costUsd, toolCalls: r.toolCalls, modelCalls: r.modelCalls, simulated: r.simulated, errorCode: null });
  }
  if (f.state === "failed" || f.state === "timed_out") {
    for (const r of snapshot.needsYou.failedRuns) {
      if (!runMatches(r, f, departments)) continue;
      rows.push({ id: r.id, tenantId: r.tenantId, tenantName: r.tenantName, agentName: r.agentName, definitionKey: r.definitionKey, trigger: r.trigger, state: r.state, startedAt: r.startedAt, finishedAt: r.finishedAt, sortAt: r.finishedAt ?? r.startedAt ?? "", costUsd: r.costUsd, toolCalls: r.toolCalls, modelCalls: r.modelCalls, simulated: true, errorCode: r.errorCode });
    }
  }
  return sortRunRows(rows);
}

export function sortRunRows(rows: RunListRow[]): RunListRow[] {
  return [...rows].sort((a, b) => {
    const aAlive = isTerminalRunState(a.state) ? 1 : 0;
    const bAlive = isTerminalRunState(b.state) ? 1 : 0;
    if (aAlive !== bAlive) return aAlive - bAlive;
    return b.sortAt.localeCompare(a.sortAt);
  });
}

// Tabs and return paths -------------------------------------------------------------------------

export const LIVE_TABS = ["queue", "map", "deck", "runs"] as const;
export type LiveTab = (typeof LIVE_TABS)[number];

/** Accepts "runs", "#runs" or null; anything unknown is the Queue. */
export function parseLiveTab(value: string | null | undefined): LiveTab {
  const v = (value ?? "").replace(/^#/, "").toLowerCase();
  return (LIVE_TABS as readonly string[]).includes(v) ? (v as LiveTab) : "queue";
}

/**
 * Path the board lives at for a tab, selection and department filter. Server actions redirect back here with `?ok=` or
 * `?error=` appended by `withNotice`, which keeps these parameters, so the drawer and the filter survive Stop, Instruct,
 * Approve or a schedule toggle.
 */
export function liveReturnTo(tab: LiveTab, runId: string | null, department: string | null = null): string {
  const params = new URLSearchParams();
  if (tab !== "queue") params.set("tab", tab);
  if (runId) params.set("run", runId);
  if (department) params.set("department", department);
  const qs = params.toString();
  return qs ? `/mission-control/live?${qs}` : "/mission-control/live";
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Parses the JSON body of the run detail endpoint. Null for anything that is not a detail object. */
export function parseRunDetail(data: unknown): LiveRunDetail | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const run = o.run as Record<string, unknown> | undefined;
  if (!run || typeof run.id !== "string" || !Array.isArray(o.events) || !Array.isArray(o.steps) || !Array.isArray(o.instructions)) return null;
  return data as LiveRunDetail;
}
