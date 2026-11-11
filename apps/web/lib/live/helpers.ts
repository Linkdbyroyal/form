/**
 * Live Mission Control (ADR-024, slice 1): shared snapshot types and pure helpers used by the server queries,
 * the client hook and the board. No I/O here; everything is unit-tested in test/live.test.ts.
 *
 * Dates travel as ISO strings so the snapshot is plain JSON for the server-sent event stream.
 */

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
  state: LiveRunState;
  errorCode: string | null;
  summary: string | null;
  finishedAt: string | null;
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
  state: LiveRunState;
  summary: string | null;
  costUsd: number;
  simulated: boolean;
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
}

export const EMPTY_FILTERS: LaneFilters = { tenantId: null, definitionKey: null, state: null };

export function runMatches(run: { tenantId: string; definitionKey: string; state: LiveRunState }, f: LaneFilters): boolean {
  if (f.tenantId && run.tenantId !== f.tenantId) return false;
  if (f.definitionKey && run.definitionKey !== f.definitionKey) return false;
  if (f.state && run.state !== f.state) return false;
  return true;
}

/** Groups the snapshot's runs into the three lanes with the filters applied. Running first by start time (newest first). */
export function groupRuns(snapshot: Pick<LiveSnapshot, "running" | "done" | "needsYou">, f: LaneFilters): { running: LiveRun[]; done: LiveDoneRun[]; failed: LiveFailedRun[] } {
  const running = snapshot.running.filter((r) => laneForRunState(r.state) === "running" && runMatches(r, f)).sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt));
  const done = snapshot.done.filter((r) => laneForRunState(r.state) === "done" && runMatches(r, f)).sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
  const failed = snapshot.needsYou.failedRuns.filter((r) => laneForRunState(r.state) === "needs_you" && (!f.tenantId || r.tenantId === f.tenantId) && (!f.state || r.state === f.state));
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
export function filterOptions(snapshot: Pick<LiveSnapshot, "agents">): { tenants: Array<{ id: string; name: string }>; definitions: string[] } {
  const tenants = new Map<string, string>();
  const definitions = new Set<string>();
  for (const a of snapshot.agents) {
    tenants.set(a.tenantId, a.tenantName);
    definitions.add(a.definitionKey);
  }
  return { tenants: [...tenants].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)), definitions: [...definitions].sort() };
}
