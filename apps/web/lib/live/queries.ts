import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type OperatorContext, type Tx } from "@sbos/db";
import { getDb } from "../db";
import { operatorMayDecide } from "../mission-control/queries";
import { targetFromSummary, type LiveCommunication } from "./graph";
import { buildWorkerRows, type WorkerCounts } from "./deck";
import {
  ACTIVE_RUN_STATES,
  emptyRunCounts,
  isRunState,
  parseStateFromSummary,
  parseStepFromSummary,
  type LiveAgent,
  type LiveApproval,
  type LiveConnector,
  type LiveDoneRun,
  type LiveEvent,
  type LiveFailedRun,
  type LiveIncident,
  type LiveOpenQuestions,
  type LiveRun,
  type LiveRunState,
  type LiveSchedule,
  type LiveSnapshot,
  type LiveStateChange,
  type LiveWorker
} from "./helpers";

/**
 * Live snapshot for the Command Queue (ADR-024, slice 1). Runs in OPERATOR context (`sbos_operator` role): only
 * the columns granted in migrations 0002, 0005, 0008 and 0011 are selected. Content columns are never read:
 * `agent_runs.checkpoint` and `result`, `run_events.payload`, `questions.question_text`, vault bodies, prompts.
 * The checkpoint step therefore comes from the checkpoint event summaries ("step <name>"), the state of a
 * state_change event from its summary, and questions are counted per tenant and department only.
 *
 * The snapshot is plain JSON (dates as ISO strings) so the SSE route can send it as is.
 */
const { tenants, agentInstances, agentDefinitions, agentRuns, runEvents, approvals, incidents, questions, schedules, connections, syncRuns, notifications, techWatchRuns, retentionSweeps } = schema;

const num = (expr: ReturnType<typeof sql>) => sql<number>`${expr}`.mapWith(Number);
const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

const ACTIVE = [...ACTIVE_RUN_STATES] as LiveRunState[];

export async function operatorRead<T>(ctx: OperatorContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().withContext(ctx, fn);
}

export async function getLiveSnapshot(ctx: OperatorContext): Promise<LiveSnapshot> {
  return operatorRead(ctx, async (tx) => {
    const [summary, approvalRows, incidentRows, failedRows, questionRows, runningRows, doneRows, agentRows, timelineRows, scheduleRows, communicationRows, connectorRows, eventRows, workerRows, latest] = await Promise.all([
      readSummary(tx),
      readApprovals(tx),
      readIncidents(tx),
      readFailedRuns(tx),
      readOpenQuestions(tx),
      readRunning(tx),
      readDone(tx),
      readAgents(tx),
      readTimeline(tx),
      readSchedules(tx),
      readCommunications(tx),
      readConnectors(tx),
      readEvents(tx),
      readWorkers(tx),
      tx.select({ simulated: agentRuns.simulated }).from(agentRuns).orderBy(desc(agentRuns.createdAt)).limit(1)
    ]);
    const mode: "live" | "simulated" = latest[0] && latest[0].simulated === false ? "live" : "simulated";
    return {
      generatedAt: new Date().toISOString(),
      platform: { mode },
      summary,
      needsYou: { approvals: approvalRows, incidents: incidentRows, failedRuns: failedRows, questions: questionRows },
      running: runningRows,
      done: doneRows,
      agents: agentRows,
      timeline: timelineRows,
      schedules: scheduleRows,
      communications: communicationRows,
      connectors: connectorRows,
      events: eventRows,
      workers: workerRows
    };
  });
}

async function readSummary(tx: Tx): Promise<LiveSnapshot["summary"]> {
  const runs = emptyRunCounts();
  // Open states: every row. Terminal states: the last 24 hours only.
  const rows = await tx
    .select({ state: agentRuns.state, n: num(sql`count(*)`) })
    .from(agentRuns)
    .where(sql`${agentRuns.state} in ('queued','running','waiting_for_input','waiting_for_approval','paused','interrupted') or coalesce(${agentRuns.finishedAt}, ${agentRuns.createdAt}) > now() - interval '24 hours'`)
    .groupBy(agentRuns.state);
  for (const r of rows) if (isRunState(r.state)) runs[r.state] = r.n;
  const [pending] = await tx.select({ n: num(sql`count(*)`) }).from(approvals).where(eq(approvals.state, "pending"));
  const [openQ] = await tx.select({ n: num(sql`count(*)`) }).from(questions).where(eq(questions.state, "open"));
  const [openI] = await tx.select({ n: num(sql`count(*)`) }).from(incidents).where(sql`${incidents.state} <> 'resolved'`);
  return { runs, pendingApprovals: pending?.n ?? 0, openQuestions: openQ?.n ?? 0, openIncidents: openI?.n ?? 0 };
}

async function readApprovals(tx: Tx): Promise<LiveApproval[]> {
  const rows = await tx
    .select({
      id: approvals.id,
      tenantId: approvals.tenantId,
      tenantSlug: tenants.slug,
      tenantName: tenants.name,
      agentName: agentInstances.name,
      runId: approvals.runId,
      risk: approvals.risk,
      approverRole: approvals.approverRole,
      summary: approvals.summary,
      blocking: approvals.blocking,
      createdAt: approvals.createdAt,
      agentInstanceId: agentRuns.agentInstanceId
    })
    .from(approvals)
    .innerJoin(tenants, eq(tenants.id, approvals.tenantId))
    .leftJoin(agentRuns, eq(agentRuns.id, approvals.runId))
    .leftJoin(agentInstances, eq(agentInstances.id, agentRuns.agentInstanceId))
    .where(eq(approvals.state, "pending"))
    .orderBy(approvals.createdAt)
    .limit(100);
  return rows.map((r) => ({ ...r, agentName: r.agentName ?? null, agentInstanceId: r.agentInstanceId ?? null, createdAt: iso(r.createdAt)!, operatorMayDecide: operatorMayDecide(r.approverRole) }));
}

async function readIncidents(tx: Tx): Promise<LiveIncident[]> {
  const rows = await tx
    .select({ id: incidents.id, kind: incidents.kind, severity: incidents.severity, title: incidents.title, state: incidents.state, tenantName: tenants.name, runId: incidents.runId, createdAt: incidents.createdAt })
    .from(incidents)
    .leftJoin(tenants, eq(tenants.id, incidents.tenantId))
    .where(sql`${incidents.state} <> 'resolved'`)
    .orderBy(desc(incidents.createdAt))
    .limit(100);
  return rows.map((r) => ({ ...r, tenantName: r.tenantName ?? null, createdAt: iso(r.createdAt)! }));
}

async function readFailedRuns(tx: Tx): Promise<LiveFailedRun[]> {
  const rows = await tx
    .select({
      id: agentRuns.id,
      tenantId: agentRuns.tenantId,
      tenantName: tenants.name,
      agentName: agentInstances.name,
      definitionKey: agentDefinitions.key,
      trigger: agentRuns.trigger,
      state: agentRuns.state,
      errorCode: sql<string | null>`coalesce(${agentRuns.error}->>'code', ${agentRuns.error}->>'class')`,
      summary: agentRuns.summary,
      startedAt: agentRuns.startedAt,
      finishedAt: agentRuns.finishedAt,
      costUsd: num(sql`${agentRuns.costUsd}`),
      toolCalls: eventCounts.toolCalls,
      modelCalls: eventCounts.modelCalls
    })
    .from(agentRuns)
    .innerJoin(tenants, eq(tenants.id, agentRuns.tenantId))
    .innerJoin(agentInstances, eq(agentInstances.id, agentRuns.agentInstanceId))
    .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentInstances.definitionId))
    .where(and(inArray(agentRuns.state, ["failed", "timed_out"]), sql`coalesce(${agentRuns.finishedAt}, ${agentRuns.updatedAt}) > now() - interval '24 hours'`))
    .orderBy(desc(agentRuns.finishedAt))
    .limit(50);
  return rows.map((r) => ({ ...r, state: r.state as LiveRunState, errorCode: r.errorCode ?? null, startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt) }));
}

async function readOpenQuestions(tx: Tx): Promise<LiveOpenQuestions[]> {
  // Granted on questions: id, tenant_id, round_id, run_id, department, recipient_role, priority, answer_type, state, confidence, created_at.
  const rows = await tx
    .select({ tenantId: questions.tenantId, tenantName: tenants.name, tenantSlug: tenants.slug, department: questions.department, n: num(sql`count(*)`) })
    .from(questions)
    .innerJoin(tenants, eq(tenants.id, questions.tenantId))
    .where(eq(questions.state, "open"))
    .groupBy(questions.tenantId, tenants.name, tenants.slug, questions.department)
    .orderBy(tenants.name, questions.department);
  const byTenant = new Map<string, LiveOpenQuestions>();
  for (const r of rows) {
    const t = byTenant.get(r.tenantId) ?? { tenantId: r.tenantId, tenantName: r.tenantName, tenantSlug: r.tenantSlug, count: 0, byDepartment: [] };
    t.count += r.n;
    t.byDepartment.push({ department: r.department, count: r.n });
    byTenant.set(r.tenantId, t);
  }
  return [...byTenant.values()];
}

/** Latest run event with classification public or internal (operator may see confidential summaries exist, not read them). */
const lastEvent = {
  summary: sql<string | null>`(select e.summary from run_events e where e.run_id = ${agentRuns.id} and e.classification in ('public','internal') order by e.seq desc limit 1)`,
  kind: sql<string | null>`(select e.kind::text from run_events e where e.run_id = ${agentRuns.id} and e.classification in ('public','internal') order by e.seq desc limit 1)`,
  at: sql<string | null>`(select e.occurred_at from run_events e where e.run_id = ${agentRuns.id} and e.classification in ('public','internal') order by e.seq desc limit 1)`,
  checkpoints: sql<string[]>`(select coalesce(array_agg(e.summary order by e.seq), '{}'::text[]) from run_events e where e.run_id = ${agentRuns.id} and e.kind = 'checkpoint')`
};

/** Event counts per run for the Runs tab (slice 2): the (run_id, seq) index makes these cheap. */
const eventCounts = {
  toolCalls: num(sql`(select count(*) from run_events e where e.run_id = ${agentRuns.id} and e.kind = 'tool_call')`),
  modelCalls: num(sql`(select count(*) from run_events e where e.run_id = ${agentRuns.id} and e.kind = 'model_call')`)
};

async function readRunning(tx: Tx): Promise<LiveRun[]> {
  const rows = await tx
    .select({
      id: agentRuns.id,
      tenantId: agentRuns.tenantId,
      tenantSlug: tenants.slug,
      tenantName: tenants.name,
      agentInstanceId: agentRuns.agentInstanceId,
      agentName: agentInstances.name,
      definitionKey: agentDefinitions.key,
      trigger: agentRuns.trigger,
      state: agentRuns.state,
      attempt: agentRuns.attempt,
      startedAt: agentRuns.startedAt,
      createdAt: agentRuns.createdAt,
      tokensInput: agentRuns.tokensInput,
      tokensOutput: agentRuns.tokensOutput,
      costUsd: num(sql`${agentRuns.costUsd}`),
      toolCalls: eventCounts.toolCalls,
      modelCalls: eventCounts.modelCalls,
      simulated: agentRuns.simulated,
      lastSummary: lastEvent.summary,
      lastKind: lastEvent.kind,
      lastAt: lastEvent.at,
      checkpoints: lastEvent.checkpoints
    })
    .from(agentRuns)
    .innerJoin(tenants, eq(tenants.id, agentRuns.tenantId))
    .innerJoin(agentInstances, eq(agentInstances.id, agentRuns.agentInstanceId))
    .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentInstances.definitionId))
    .where(inArray(agentRuns.state, ACTIVE))
    .orderBy(desc(agentRuns.createdAt))
    .limit(100);
  return rows.map((r) => {
    const steps = (r.checkpoints ?? []).map(parseStepFromSummary).filter((s): s is string => s !== null);
    return {
      id: r.id,
      tenantId: r.tenantId,
      tenantSlug: r.tenantSlug,
      tenantName: r.tenantName,
      agentInstanceId: r.agentInstanceId,
      agentName: r.agentName,
      definitionKey: r.definitionKey,
      trigger: r.trigger,
      state: r.state as LiveRunState,
      attempt: r.attempt,
      startedAt: iso(r.startedAt),
      createdAt: iso(r.createdAt)!,
      step: steps.length > 0 ? steps[steps.length - 1]! : null,
      steps,
      tokensInput: r.tokensInput,
      tokensOutput: r.tokensOutput,
      costUsd: r.costUsd,
      toolCalls: r.toolCalls,
      modelCalls: r.modelCalls,
      simulated: r.simulated,
      lastEventAt: iso(r.lastAt),
      lastEventSummary: r.lastSummary ?? null,
      lastEventKind: r.lastKind ?? null
    };
  });
}

async function readDone(tx: Tx): Promise<LiveDoneRun[]> {
  const rows = await tx
    .select({
      id: agentRuns.id,
      tenantId: agentRuns.tenantId,
      tenantName: tenants.name,
      agentName: agentInstances.name,
      definitionKey: agentDefinitions.key,
      trigger: agentRuns.trigger,
      state: agentRuns.state,
      summary: agentRuns.summary,
      costUsd: num(sql`${agentRuns.costUsd}`),
      toolCalls: eventCounts.toolCalls,
      modelCalls: eventCounts.modelCalls,
      simulated: agentRuns.simulated,
      startedAt: agentRuns.startedAt,
      finishedAt: agentRuns.finishedAt
    })
    .from(agentRuns)
    .innerJoin(tenants, eq(tenants.id, agentRuns.tenantId))
    .innerJoin(agentInstances, eq(agentInstances.id, agentRuns.agentInstanceId))
    .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentInstances.definitionId))
    .where(and(inArray(agentRuns.state, ["succeeded", "cancelled"]), sql`coalesce(${agentRuns.finishedAt}, ${agentRuns.updatedAt}) > now() - interval '24 hours'`))
    .orderBy(desc(agentRuns.finishedAt))
    .limit(50);
  return rows.map((r) => ({ ...r, state: r.state as LiveRunState, startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt) }));
}

async function readAgents(tx: Tx): Promise<LiveAgent[]> {
  const rows = await tx
    .select({
      id: agentInstances.id,
      tenantId: agentInstances.tenantId,
      tenantSlug: tenants.slug,
      tenantName: tenants.name,
      definitionKey: agentDefinitions.key,
      definitionName: agentDefinitions.name,
      tier: agentDefinitions.authority,
      department: agentDefinitions.department,
      name: agentInstances.name,
      state: agentInstances.state,
      currentRunId: sql<string | null>`(select r.id from agent_runs r where r.agent_instance_id = ${agentInstances.id} and r.state in ('queued','running','waiting_for_input','waiting_for_approval','paused','interrupted') order by r.created_at desc limit 1)`,
      lastActivityAt: sql<string | null>`greatest(${agentInstances.lastRunAt}, (select max(coalesce(r.finished_at, r.started_at, r.created_at)) from agent_runs r where r.agent_instance_id = ${agentInstances.id}))`,
      // cost_events is granted to the operator role (migration 0002); the month starts at the UTC calendar month.
      monthCostUsd: num(sql`coalesce((select sum(c.cost_usd) from cost_events c where c.agent_instance_id = ${agentInstances.id} and c.occurred_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'), 0)`),
      runsToday: num(sql`(select count(*) from agent_runs r where r.agent_instance_id = ${agentInstances.id} and r.created_at > now() - interval '24 hours')`)
    })
    .from(agentInstances)
    .innerJoin(tenants, eq(tenants.id, agentInstances.tenantId))
    .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentInstances.definitionId))
    .orderBy(tenants.name, agentInstances.name);
  return rows.map((r) => ({ ...r, tier: String(r.tier), department: r.department ?? null, currentRunId: r.currentRunId ?? null, lastActivityAt: iso(r.lastActivityAt) }));
}

async function readTimeline(tx: Tx): Promise<LiveStateChange[]> {
  // Runs alive in the last 45 minutes (started, or finished, inside the window), bounded to the last 24 hours.
  const rows = await tx
    .select({
      runId: runEvents.runId,
      seq: runEvents.seq,
      summary: runEvents.summary,
      occurredAt: runEvents.occurredAt,
      agentInstanceId: agentRuns.agentInstanceId,
      agentName: agentInstances.name,
      tenantName: tenants.name,
      runState: agentRuns.state,
      lastSeq: sql<number>`(select max(e2.seq) from run_events e2 where e2.run_id = ${agentRuns.id} and e2.kind = 'state_change')`.mapWith(Number)
    })
    .from(runEvents)
    .innerJoin(agentRuns, eq(agentRuns.id, runEvents.runId))
    .innerJoin(agentInstances, eq(agentInstances.id, agentRuns.agentInstanceId))
    .innerJoin(tenants, eq(tenants.id, agentRuns.tenantId))
    .where(
      and(
        eq(runEvents.kind, "state_change"),
        sql`${agentRuns.createdAt} > now() - interval '24 hours'`,
        sql`coalesce(${agentRuns.finishedAt}, now()) > now() - interval '45 minutes'`
      )
    )
    .orderBy(runEvents.runId, runEvents.seq)
    .limit(2000);
  return rows.map((r) => ({
    runId: r.runId,
    agentInstanceId: r.agentInstanceId,
    agentName: r.agentName,
    tenantName: r.tenantName,
    // The last state_change of a run always equals the run's current state; earlier ones are parsed from their summary.
    to: r.seq === r.lastSeq && isRunState(r.runState) ? (r.runState as LiveRunState) : parseStateFromSummary(r.summary),
    at: iso(r.occurredAt)!,
    seq: r.seq
  }));
}

async function readSchedules(tx: Tx): Promise<LiveSchedule[]> {
  const rows = await tx
    .select({
      id: schedules.id,
      tenantId: schedules.tenantId,
      tenantName: tenants.name,
      agentName: agentInstances.name,
      definitionKey: agentDefinitions.key,
      cron: schedules.cron,
      timezone: schedules.timezone,
      enabled: schedules.enabled,
      nextRunAt: schedules.nextRunAt,
      lastRunAt: schedules.lastRunAt,
      lastOutcome: sql<string | null>`(select r.state::text from agent_runs r where r.schedule_id = ${schedules.id} order by r.created_at desc limit 1)`
    })
    .from(schedules)
    .innerJoin(tenants, eq(tenants.id, schedules.tenantId))
    .innerJoin(agentInstances, eq(agentInstances.id, schedules.agentInstanceId))
    .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentInstances.definitionId))
    .orderBy(tenants.name, agentInstances.name);
  return rows.map((r) => ({ ...r, nextRunAt: iso(r.nextRunAt), lastRunAt: iso(r.lastRunAt), lastOutcome: r.lastOutcome ?? null }));
}

/** Event kinds the Flight Map turns into edges; `targetFromSummary` decides the target from the summary vocabulary. */
const COMMUNICATION_KINDS = ["tool_call", "model_call", "approval_requested", "approval_decided", "question_created", "note", "state_change"] as const;
const COMMUNICATIONS_WINDOW_MINUTES = 20;
export const COMMUNICATIONS_CAP = 400;

/**
 * Communications for the Flight Map (slice 3): run_events of the last 20 minutes with a public or internal
 * classification (the same rule as the last-event column), joined to agent_runs for the agent and tenant. The
 * payload column is not granted to the operator role, so the target is derived from the summary only; events
 * without a recognisable target are dropped. Newest 400 rows are read, returned oldest first (newest last).
 */
async function readCommunications(tx: Tx): Promise<LiveCommunication[]> {
  const rows = await tx
    .select({ runId: runEvents.runId, kind: runEvents.kind, summary: runEvents.summary, occurredAt: runEvents.occurredAt, agentInstanceId: agentRuns.agentInstanceId, tenantId: agentRuns.tenantId })
    .from(runEvents)
    .innerJoin(agentRuns, eq(agentRuns.id, runEvents.runId))
    .where(
      and(
        inArray(runEvents.kind, [...COMMUNICATION_KINDS]),
        inArray(runEvents.classification, ["public", "internal"]),
        sql`${runEvents.occurredAt} > now() - make_interval(mins => ${COMMUNICATIONS_WINDOW_MINUTES})`
      )
    )
    .orderBy(desc(runEvents.occurredAt), desc(runEvents.seq))
    .limit(COMMUNICATIONS_CAP);
  const out: LiveCommunication[] = [];
  for (const r of rows) {
    const mapped = targetFromSummary(r.kind, r.summary);
    if (!mapped) continue;
    out.push({ runId: r.runId, agentInstanceId: r.agentInstanceId, tenantId: r.tenantId, kind: mapped.kind, target: mapped.target, label: mapped.label, at: iso(r.occurredAt)! });
  }
  return out.reverse();
}

/**
 * Connectors for the Flight Map: connections in phase read_only or sandbox, one entry per (tenant, provider); `live`
 * when the latest sync run of any such connection ran in live mode. Metadata columns only (provider, phase and
 * sync_runs.mode are granted to the operator role; `config` is never selected).
 */
async function readConnectors(tx: Tx): Promise<LiveConnector[]> {
  const rows = await tx
    .select({
      tenantId: connections.tenantId,
      provider: connections.provider,
      latestMode: sql<string | null>`(select s.mode from ${syncRuns} s where s.connection_id = ${connections.id} order by s.started_at desc limit 1)`
    })
    .from(connections)
    .where(inArray(connections.phase, ["read_only", "sandbox"]))
    .orderBy(connections.tenantId, connections.provider);
  const byKey = new Map<string, LiveConnector>();
  for (const r of rows) {
    const key = `${r.tenantId}:${r.provider}`;
    const prev = byKey.get(key);
    const live = r.latestMode === "live";
    if (prev) prev.live = prev.live || live;
    else byKey.set(key, { tenantId: r.tenantId, provider: r.provider, live });
  }
  return [...byKey.values()];
}

// Operations Deck (slice 4) -----------------------------------------------------------------------

export const EVENTS_TICKER_CAP = 120;

/**
 * Live event ticker: the newest 120 run_events across tenants with classification public or internal (the operator may
 * know that confidential events exist, through the per-run counts, but never reads their summaries). Granted columns
 * only; the payload is never selected. Newest first.
 */
async function readEvents(tx: Tx): Promise<LiveEvent[]> {
  const rows = await tx
    .select({
      id: runEvents.id,
      seq: runEvents.seq,
      runId: runEvents.runId,
      agentInstanceId: agentRuns.agentInstanceId,
      agentName: agentInstances.name,
      tenantId: agentRuns.tenantId,
      tenantName: tenants.name,
      kind: runEvents.kind,
      summary: runEvents.summary,
      classification: runEvents.classification,
      costUsd: num(sql`coalesce(${runEvents.costUsd}, 0)`),
      tokens: num(sql`coalesce(${runEvents.tokensInput}, 0) + coalesce(${runEvents.tokensOutput}, 0)`),
      occurredAt: runEvents.occurredAt
    })
    .from(runEvents)
    .innerJoin(agentRuns, eq(agentRuns.id, runEvents.runId))
    .innerJoin(agentInstances, eq(agentInstances.id, agentRuns.agentInstanceId))
    .innerJoin(tenants, eq(tenants.id, agentRuns.tenantId))
    .where(inArray(runEvents.classification, ["public", "internal"]))
    .orderBy(desc(runEvents.occurredAt), desc(runEvents.seq))
    .limit(EVENTS_TICKER_CAP);
  return rows.map((r) => ({ ...r, kind: String(r.kind), classification: String(r.classification), occurredAt: iso(r.occurredAt)! }));
}

/**
 * Whether the current role (sbos_operator inside `withContext`) may SELECT a table. A plain catalog function, so a
 * missing grant never aborts the snapshot transaction; the UI then shows "not readable by the operator role".
 */
async function operatorMayRead(tx: Tx, table: string): Promise<boolean> {
  const res = await tx.execute<{ ok: boolean }>(sql`select has_table_privilege(current_user, ${`public.${table}`}, 'select') as ok`);
  return res.rows[0]?.ok === true;
}

const DAY = sql`now() - interval '24 hours'`;

/**
 * Background worker rows. pg-boss keeps its queue tables in its own schema, which the operator role cannot read, so the
 * counts are derived from the domain tables the worker writes: agent_runs for agent.run and agent.resume, schedules and
 * agent_runs for schedule.tick, sync_runs for connector.sync, notifications for notify.send, and the agency tables
 * tech_watch_runs and retention_sweeps. Each agency table is read only when the role holds SELECT on it.
 */
async function readWorkers(tx: Tx): Promise<LiveWorker[]> {
  const runCounts = async (resume: boolean) => {
    const trig = resume ? sql`${agentRuns.trigger} = 'resume'` : sql`${agentRuns.trigger} <> 'resume'`;
    const [r] = await tx
      .select({
        queued: num(sql`count(*) filter (where ${agentRuns.state} = 'queued')`),
        running: num(sql`count(*) filter (where ${agentRuns.state} = 'running')`),
        interrupted: num(sql`count(*) filter (where ${agentRuns.state} = 'interrupted')`),
        succeeded24h: num(sql`count(*) filter (where ${agentRuns.state} = 'succeeded' and ${agentRuns.finishedAt} > ${DAY})`),
        failed24h: num(sql`count(*) filter (where ${agentRuns.state} in ('failed','timed_out') and coalesce(${agentRuns.finishedAt}, ${agentRuns.updatedAt}) > ${DAY})`),
        lastAt: sql<string | null>`max(coalesce(${agentRuns.startedAt}, ${agentRuns.createdAt}))`
      })
      .from(agentRuns)
      .where(trig);
    return r ? { ...r, lastAt: iso(r.lastAt) } : null;
  };
  const scheduleCounts = async () => {
    const [sch] = await tx
      .select({
        enabled: num(sql`count(*) filter (where ${schedules.enabled})`),
        dueWithinHour: num(sql`count(*) filter (where ${schedules.enabled} and ${schedules.nextRunAt} <= now() + interval '1 hour')`),
        lastAt: sql<string | null>`max(${schedules.lastRunAt})`
      })
      .from(schedules);
    const [runs] = await tx
      .select({
        runs24h: num(sql`count(*)`),
        failed24h: num(sql`count(*) filter (where ${agentRuns.state} in ('failed','timed_out'))`)
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.trigger, "schedule"), sql`${agentRuns.createdAt} > ${DAY}`));
    return sch ? { enabled: sch.enabled, dueWithinHour: sch.dueWithinHour, runs24h: runs?.runs24h ?? 0, failed24h: runs?.failed24h ?? 0, lastAt: iso(sch.lastAt) } : null;
  };
  const syncCounts = async () => {
    const [r] = await tx
      .select({
        running: num(sql`count(*) filter (where ${syncRuns.status} = 'running')`),
        succeeded24h: num(sql`count(*) filter (where ${syncRuns.status} = 'succeeded' and ${syncRuns.startedAt} > ${DAY})`),
        failed24h: num(sql`count(*) filter (where ${syncRuns.status} = 'failed' and ${syncRuns.startedAt} > ${DAY})`),
        lastAt: sql<string | null>`max(${syncRuns.startedAt})`
      })
      .from(syncRuns);
    return r ? { ...r, lastAt: iso(r.lastAt) } : null;
  };
  const notificationCounts = async () => {
    if (!(await operatorMayRead(tx, "notifications"))) return null;
    const [r] = await tx
      .select({
        queued: num(sql`count(*) filter (where ${notifications.state} = 'queued')`),
        sent24h: num(sql`count(*) filter (where ${notifications.state} = 'sent' and ${notifications.sentAt} > ${DAY})`),
        failed24h: num(sql`count(*) filter (where ${notifications.state} = 'failed' and ${notifications.createdAt} > ${DAY})`),
        lastAt: sql<string | null>`max(coalesce(${notifications.sentAt}, ${notifications.createdAt}))`
      })
      .from(notifications);
    return r ? { ...r, lastAt: iso(r.lastAt) } : null;
  };
  const techWatchCounts = async () => {
    if (!(await operatorMayRead(tx, "tech_watch_runs"))) return null;
    const [r] = await tx
      .select({
        succeeded24h: num(sql`count(*) filter (where ${techWatchRuns.status} = 'succeeded' and ${techWatchRuns.startedAt} > ${DAY})`),
        failed24h: num(sql`count(*) filter (where ${techWatchRuns.status} = 'failed' and ${techWatchRuns.startedAt} > ${DAY})`),
        lastAt: sql<string | null>`max(${techWatchRuns.startedAt})`
      })
      .from(techWatchRuns);
    return r ? { ...r, lastAt: iso(r.lastAt) } : null;
  };
  const retentionCounts = async () => {
    if (!(await operatorMayRead(tx, "retention_sweeps"))) return null;
    const [r] = await tx
      .select({
        sweeps24h: num(sql`count(*) filter (where ${retentionSweeps.ranAt} > ${DAY})`),
        lastAt: sql<string | null>`max(${retentionSweeps.ranAt})`
      })
      .from(retentionSweeps);
    return r ? { ...r, lastAt: iso(r.lastAt) } : null;
  };
  const counts: WorkerCounts = {
    runs: await runCounts(false),
    resumes: await runCounts(true),
    schedules: await scheduleCounts(),
    syncs: await syncCounts(),
    notifications: await notificationCounts(),
    techWatch: await techWatchCounts(),
    retention: await retentionCounts()
  };
  return buildWorkerRows(counts);
}
