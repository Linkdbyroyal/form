import { and, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { schema, type Tx } from "@sbos/db";
import { readPlatformBudget } from "@sbos/core";
import { getDb } from "../db";
import { getOperatorContext } from "../request-context";
import { monthStartUtc } from "../format";

/**
 * Mission Control reads. Every function runs in OPERATOR context (`sbos_operator` role), which has
 * SELECT on metadata columns only. Content columns (`agent_tasks.instruction`, `agent_runs.checkpoint`
 * and `result`, `run_events.payload`, `questions.question_text` and friends) are never selected here;
 * selecting one would make Postgres raise `permission denied`, which we let propagate on purpose.
 */
const { tenants, agentInstances, agentDefinitions, skillVersions, agentTasks, agentRuns, runEvents, approvals, schedules, incidents, budgets, costEvents, agentFeedback } = schema;

const num = (expr: ReturnType<typeof sql>) => sql<number>`${expr}`.mapWith(Number);

async function operatorRead<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().withContext(await getOperatorContext(), fn);
}

export type AgentState = (typeof schema.agentState.enumValues)[number];
export type RunState = (typeof schema.runState.enumValues)[number];
export type TaskState = (typeof schema.taskState.enumValues)[number];
export type IncidentState = (typeof schema.incidentState.enumValues)[number];

const OPEN_RUN_STATES: RunState[] = ["queued", "running", "waiting_for_input", "waiting_for_approval", "paused", "interrupted"];
export const STOPPABLE_RUN_STATES: readonly RunState[] = OPEN_RUN_STATES;

// Summary -------------------------------------------------------------------------------------

export interface MissionControlSummary {
  instancesByState: Array<{ state: AgentState; n: number }>;
  instances: number;
  runsLast24h: { succeeded: number; failed: number; other: number };
  runsActive: number;
  pendingApprovals: number;
  openIncidents: number;
  monthToDateUsd: number;
  monthToDateSimulatedUsd: number;
}

export async function getMissionControlSummary(): Promise<MissionControlSummary> {
  return operatorRead(async (tx) => {
    const byState = await tx.select({ state: agentInstances.state, n: num(sql`count(*)`) }).from(agentInstances).groupBy(agentInstances.state);
    const runs24 = await tx
      .select({ state: agentRuns.state, n: num(sql`count(*)`) })
      .from(agentRuns)
      .where(sql`${agentRuns.createdAt} > now() - interval '24 hours'`)
      .groupBy(agentRuns.state);
    const [active] = await tx.select({ n: num(sql`count(*)`) }).from(agentRuns).where(inArray(agentRuns.state, OPEN_RUN_STATES));
    const [pending] = await tx.select({ n: num(sql`count(*)`) }).from(approvals).where(eq(approvals.state, "pending"));
    const [open] = await tx.select({ n: num(sql`count(*)`) }).from(incidents).where(eq(incidents.state, "open"));
    const [mtd] = await tx
      .select({ total: num(sql`coalesce(sum(${costEvents.costUsd}), 0)`), simulated: num(sql`coalesce(sum(case when ${costEvents.simulated} then ${costEvents.costUsd} else 0 end), 0)`) })
      .from(costEvents)
      .where(gte(costEvents.occurredAt, monthStartUtc()));
    const runsLast24h = { succeeded: 0, failed: 0, other: 0 };
    for (const r of runs24) {
      if (r.state === "succeeded") runsLast24h.succeeded += r.n;
      else if (r.state === "failed" || r.state === "timed_out") runsLast24h.failed += r.n;
      else runsLast24h.other += r.n;
    }
    return {
      instancesByState: byState,
      instances: byState.reduce((a, b) => a + b.n, 0),
      runsLast24h,
      runsActive: active?.n ?? 0,
      pendingApprovals: pending?.n ?? 0,
      openIncidents: open?.n ?? 0,
      monthToDateUsd: mtd?.total ?? 0,
      monthToDateSimulatedUsd: mtd?.simulated ?? 0
    };
  });
}

// Agents --------------------------------------------------------------------------------------

export interface AgentInstanceRow {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  name: string;
  definitionKey: string;
  definitionName: string;
  state: AgentState;
  skillVersion: string | null;
  model: string | null;
  defaultModel: string;
  lastRunAt: Date | null;
  nextScheduledRunAt: Date | null;
  monthToDateUsd: number;
}

export async function listAgentInstances(): Promise<AgentInstanceRow[]> {
  const since = monthStartUtc();
  return operatorRead((tx) =>
    tx
      .select({
        id: agentInstances.id,
        tenantId: agentInstances.tenantId,
        tenantSlug: tenants.slug,
        tenantName: tenants.name,
        name: agentInstances.name,
        definitionKey: agentDefinitions.key,
        definitionName: agentDefinitions.name,
        state: agentInstances.state,
        skillVersion: skillVersions.version,
        model: agentInstances.model,
        defaultModel: agentDefinitions.defaultModel,
        lastRunAt: agentInstances.lastRunAt,
        nextScheduledRunAt: agentInstances.nextScheduledRunAt,
        monthToDateUsd: num(sql`(select coalesce(sum(c.cost_usd), 0) from cost_events c where c.agent_instance_id = ${agentInstances.id} and c.occurred_at >= ${since})`)
      })
      .from(agentInstances)
      .innerJoin(tenants, eq(tenants.id, agentInstances.tenantId))
      .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentInstances.definitionId))
      .leftJoin(skillVersions, eq(skillVersions.id, agentInstances.skillVersionId))
      .orderBy(tenants.name, agentInstances.name)
  );
}

export interface RunRow {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  agentInstanceId: string;
  agentName: string;
  taskId: string | null;
  scheduleId: string | null;
  trigger: string;
  triggerRef: string | null;
  state: RunState;
  attempt: number;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  simulated: boolean;
  summary: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

const runColumns = {
  id: agentRuns.id,
  tenantId: agentRuns.tenantId,
  tenantSlug: tenants.slug,
  tenantName: tenants.name,
  agentInstanceId: agentRuns.agentInstanceId,
  agentName: agentInstances.name,
  taskId: agentRuns.taskId,
  scheduleId: agentRuns.scheduleId,
  trigger: agentRuns.trigger,
  triggerRef: agentRuns.triggerRef,
  state: agentRuns.state,
  attempt: agentRuns.attempt,
  tokensInput: agentRuns.tokensInput,
  tokensOutput: agentRuns.tokensOutput,
  costUsd: num(sql`${agentRuns.costUsd}`),
  simulated: agentRuns.simulated,
  summary: agentRuns.summary,
  startedAt: agentRuns.startedAt,
  finishedAt: agentRuns.finishedAt,
  createdAt: agentRuns.createdAt
};

export interface TaskRow {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  agentInstanceId: string | null;
  agentName: string | null;
  title: string;
  department: string | null;
  priority: string;
  state: TaskState;
  ownerRole: string | null;
  createdByActorType: string;
  createdByActorId: string;
  dueAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const taskColumns = {
  id: agentTasks.id,
  tenantId: agentTasks.tenantId,
  tenantSlug: tenants.slug,
  tenantName: tenants.name,
  agentInstanceId: agentTasks.agentInstanceId,
  agentName: agentInstances.name,
  title: agentTasks.title,
  department: agentTasks.department,
  priority: agentTasks.priority,
  state: agentTasks.state,
  ownerRole: agentTasks.ownerRole,
  createdByActorType: agentTasks.createdByActorType,
  createdByActorId: agentTasks.createdByActorId,
  dueAt: agentTasks.dueAt,
  createdAt: agentTasks.createdAt,
  updatedAt: agentTasks.updatedAt
};

export interface ScheduleRow {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  agentInstanceId: string;
  agentName: string;
  name: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  expectedBySeconds: number;
  misfire: string;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
}

const scheduleColumns = {
  id: schedules.id,
  tenantId: schedules.tenantId,
  tenantSlug: tenants.slug,
  tenantName: tenants.name,
  agentInstanceId: schedules.agentInstanceId,
  agentName: agentInstances.name,
  name: schedules.name,
  cron: schedules.cron,
  timezone: schedules.timezone,
  enabled: schedules.enabled,
  expectedBySeconds: schedules.expectedBySeconds,
  misfire: schedules.misfire,
  lastRunAt: schedules.lastRunAt,
  nextRunAt: schedules.nextRunAt
};

export interface AgentDetail {
  instance: {
    id: string;
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    name: string;
    state: AgentState;
    serviceIdentity: string;
    model: string | null;
    lastRunAt: Date | null;
    nextScheduledRunAt: Date | null;
    createdAt: Date;
  };
  definition: { key: string; name: string; mission: string; department: string | null; defaultModel: string; allowedTools: string[]; authority: string; escalationRole: string | null; status: string };
  skillVersion: { id: string; version: string; releaseChannel: string; allowedTools: string[] } | null;
  budgets: Array<{ id: string; scope: string; capUsdMonth: number; runCapUsd: number; warnRatio: number; hardStop: boolean; spentUsdMonth: number }>;
  runs: RunRow[];
  openTasks: TaskRow[];
  schedules: ScheduleRow[];
  feedback: Array<{ id: string; kind: string; message: string; givenByActorId: string; runId: string | null; createdAt: Date }>;
}

export async function getAgentDetail(id: string): Promise<AgentDetail | null> {
  const since = monthStartUtc();
  return operatorRead(async (tx) => {
    const [row] = await tx
      .select({
        instance: {
          id: agentInstances.id,
          tenantId: agentInstances.tenantId,
          tenantSlug: tenants.slug,
          tenantName: tenants.name,
          name: agentInstances.name,
          state: agentInstances.state,
          serviceIdentity: agentInstances.serviceIdentity,
          model: agentInstances.model,
          lastRunAt: agentInstances.lastRunAt,
          nextScheduledRunAt: agentInstances.nextScheduledRunAt,
          createdAt: agentInstances.createdAt
        },
        definition: {
          key: agentDefinitions.key,
          name: agentDefinitions.name,
          mission: agentDefinitions.mission,
          department: agentDefinitions.department,
          defaultModel: agentDefinitions.defaultModel,
          allowedTools: agentDefinitions.allowedTools,
          authority: agentDefinitions.authority,
          escalationRole: agentDefinitions.escalationRole,
          status: agentDefinitions.status
        },
        skillVersionId: agentInstances.skillVersionId
      })
      .from(agentInstances)
      .innerJoin(tenants, eq(tenants.id, agentInstances.tenantId))
      .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentInstances.definitionId))
      .where(eq(agentInstances.id, id));
    if (!row) return null;

    const [skill] = row.skillVersionId
      ? await tx.select({ id: skillVersions.id, version: skillVersions.version, releaseChannel: skillVersions.releaseChannel, allowedTools: skillVersions.allowedTools }).from(skillVersions).where(eq(skillVersions.id, row.skillVersionId))
      : [];

    const [tenantSpent] = await tx.select({ v: num(sql`coalesce(sum(${costEvents.costUsd}), 0)`) }).from(costEvents).where(and(eq(costEvents.tenantId, row.instance.tenantId), gte(costEvents.occurredAt, since)));
    const [instanceSpent] = await tx.select({ v: num(sql`coalesce(sum(${costEvents.costUsd}), 0)`) }).from(costEvents).where(and(eq(costEvents.agentInstanceId, id), gte(costEvents.occurredAt, since)));
    const budgetRows = await tx
      .select({ id: budgets.id, scope: budgets.scope, agentInstanceId: budgets.agentInstanceId, capUsdMonth: num(sql`${budgets.capUsdMonth}`), runCapUsd: num(sql`${budgets.runCapUsd}`), warnRatio: num(sql`${budgets.warnRatio}`), hardStop: budgets.hardStop })
      .from(budgets)
      .where(eq(budgets.tenantId, row.instance.tenantId))
      .orderBy(budgets.scope);
    const budgetList = budgetRows
      .filter((b) => b.scope === "tenant" || b.agentInstanceId === id)
      .map((b) => ({ id: b.id, scope: b.scope, capUsdMonth: b.capUsdMonth, runCapUsd: b.runCapUsd, warnRatio: b.warnRatio, hardStop: b.hardStop, spentUsdMonth: b.scope === "tenant" ? (tenantSpent?.v ?? 0) : (instanceSpent?.v ?? 0) }));

    const runs = await tx
      .select(runColumns)
      .from(agentRuns)
      .innerJoin(tenants, eq(tenants.id, agentRuns.tenantId))
      .innerJoin(agentInstances, eq(agentInstances.id, agentRuns.agentInstanceId))
      .where(eq(agentRuns.agentInstanceId, id))
      .orderBy(desc(agentRuns.createdAt))
      .limit(20);

    const openTasks = await tx
      .select(taskColumns)
      .from(agentTasks)
      .innerJoin(tenants, eq(tenants.id, agentTasks.tenantId))
      .leftJoin(agentInstances, eq(agentInstances.id, agentTasks.agentInstanceId))
      .where(and(eq(agentTasks.agentInstanceId, id), inArray(agentTasks.state, ["draft", "open", "assigned", "in_progress", "waiting_input", "waiting_approval"])))
      .orderBy(desc(agentTasks.createdAt))
      .limit(50);

    const scheduleRows = await tx
      .select(scheduleColumns)
      .from(schedules)
      .innerJoin(tenants, eq(tenants.id, schedules.tenantId))
      .innerJoin(agentInstances, eq(agentInstances.id, schedules.agentInstanceId))
      .where(eq(schedules.agentInstanceId, id))
      .orderBy(schedules.name);

    const feedback = await tx
      .select({ id: agentFeedback.id, kind: agentFeedback.kind, message: agentFeedback.message, givenByActorId: agentFeedback.givenByActorId, runId: agentFeedback.runId, createdAt: agentFeedback.createdAt })
      .from(agentFeedback)
      .where(eq(agentFeedback.agentInstanceId, id))
      .orderBy(desc(agentFeedback.createdAt))
      .limit(10);

    return { instance: row.instance, definition: row.definition, skillVersion: skill ?? null, budgets: budgetList, runs, openTasks, schedules: scheduleRows, feedback };
  });
}

// Tasks ---------------------------------------------------------------------------------------

export async function listTasks(state: TaskState | null): Promise<TaskRow[]> {
  return operatorRead((tx) =>
    tx
      .select(taskColumns)
      .from(agentTasks)
      .innerJoin(tenants, eq(tenants.id, agentTasks.tenantId))
      .leftJoin(agentInstances, eq(agentInstances.id, agentTasks.agentInstanceId))
      .where(state ? eq(agentTasks.state, state) : undefined)
      .orderBy(desc(agentTasks.createdAt))
      .limit(200)
  );
}

export async function countTasksByState(): Promise<Array<{ state: TaskState; n: number }>> {
  return operatorRead((tx) => tx.select({ state: agentTasks.state, n: num(sql`count(*)`) }).from(agentTasks).groupBy(agentTasks.state));
}

// Runs ----------------------------------------------------------------------------------------

export async function listRuns(filter: { state?: RunState | null; tenantId?: string | null }): Promise<RunRow[]> {
  return operatorRead((tx) => {
    const conditions: SQL[] = [];
    if (filter.state) conditions.push(eq(agentRuns.state, filter.state));
    if (filter.tenantId) conditions.push(eq(agentRuns.tenantId, filter.tenantId));
    return tx
      .select(runColumns)
      .from(agentRuns)
      .innerJoin(tenants, eq(tenants.id, agentRuns.tenantId))
      .innerJoin(agentInstances, eq(agentInstances.id, agentRuns.agentInstanceId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(agentRuns.createdAt))
      .limit(100);
  });
}

export interface RunEventRow {
  id: string;
  seq: number;
  kind: string;
  classification: string;
  summary: string;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  durationMs: number | null;
  occurredAt: Date;
}

export interface RunDetail {
  run: RunRow & { jobId: string | null; leaseExpiresAt: Date | null; skillVersionId: string | null; error: unknown; updatedAt: Date };
  events: RunEventRow[];
  approvals: Array<{ id: string; state: string; risk: string; approverRole: string; summary: string; createdAt: Date }>;
  incidents: Array<{ id: string; kind: string; severity: string; title: string; state: string; createdAt: Date }>;
  task: { id: string; title: string; priority: string; state: string } | null;
}

export async function getRunDetail(id: string): Promise<RunDetail | null> {
  return operatorRead(async (tx) => {
    const [run] = await tx
      .select({ ...runColumns, jobId: agentRuns.jobId, leaseExpiresAt: agentRuns.leaseExpiresAt, skillVersionId: agentRuns.skillVersionId, error: agentRuns.error, updatedAt: agentRuns.updatedAt })
      .from(agentRuns)
      .innerJoin(tenants, eq(tenants.id, agentRuns.tenantId))
      .innerJoin(agentInstances, eq(agentInstances.id, agentRuns.agentInstanceId))
      .where(eq(agentRuns.id, id));
    if (!run) return null;
    // `payload` is deliberately absent: the operator role has no grant on it.
    const events = await tx
      .select({
        id: runEvents.id,
        seq: runEvents.seq,
        kind: runEvents.kind,
        classification: runEvents.classification,
        summary: runEvents.summary,
        tokensInput: runEvents.tokensInput,
        tokensOutput: runEvents.tokensOutput,
        costUsd: num(sql`${runEvents.costUsd}`),
        durationMs: runEvents.durationMs,
        occurredAt: runEvents.occurredAt
      })
      .from(runEvents)
      .where(eq(runEvents.runId, id))
      .orderBy(runEvents.seq);
    const approvalRows = await tx
      .select({ id: approvals.id, state: approvals.state, risk: approvals.risk, approverRole: approvals.approverRole, summary: approvals.summary, createdAt: approvals.createdAt })
      .from(approvals)
      .where(eq(approvals.runId, id))
      .orderBy(desc(approvals.createdAt));
    const incidentRows = await tx
      .select({ id: incidents.id, kind: incidents.kind, severity: incidents.severity, title: incidents.title, state: incidents.state, createdAt: incidents.createdAt })
      .from(incidents)
      .where(eq(incidents.runId, id))
      .orderBy(desc(incidents.createdAt));
    const [task] = run.taskId ? await tx.select({ id: agentTasks.id, title: agentTasks.title, priority: agentTasks.priority, state: agentTasks.state }).from(agentTasks).where(eq(agentTasks.id, run.taskId)) : [];
    return { run, events, approvals: approvalRows, incidents: incidentRows, task: task ?? null };
  });
}

// Approvals -----------------------------------------------------------------------------------

export interface ApprovalRow {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  runId: string | null;
  taskId: string | null;
  subjectType: string;
  requestedByActorType: string;
  requestedByActorId: string;
  approverRole: string;
  risk: string;
  summary: string;
  blocking: boolean;
  state: string;
  decidedByActorId: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

const approvalColumns = {
  id: approvals.id,
  tenantId: approvals.tenantId,
  tenantSlug: tenants.slug,
  tenantName: tenants.name,
  runId: approvals.runId,
  taskId: approvals.taskId,
  subjectType: approvals.subjectType,
  requestedByActorType: approvals.requestedByActorType,
  requestedByActorId: approvals.requestedByActorId,
  approverRole: approvals.approverRole,
  risk: approvals.risk,
  summary: approvals.summary,
  blocking: approvals.blocking,
  state: approvals.state,
  decidedByActorId: approvals.decidedByActorId,
  decidedAt: approvals.decidedAt,
  decisionNote: approvals.decisionNote,
  expiresAt: approvals.expiresAt,
  createdAt: approvals.createdAt
};

/** True when an operator (agency role) may decide this approval; client roles decide in the client workspace. */
export function operatorMayDecide(approverRole: string): boolean {
  return approverRole.startsWith("agency_") || approverRole === "superadmin";
}

export async function listApprovals(): Promise<{ pending: ApprovalRow[]; decided: ApprovalRow[] }> {
  return operatorRead(async (tx) => {
    const pending = await tx.select(approvalColumns).from(approvals).innerJoin(tenants, eq(tenants.id, approvals.tenantId)).where(eq(approvals.state, "pending")).orderBy(approvals.createdAt);
    const decided = await tx
      .select(approvalColumns)
      .from(approvals)
      .innerJoin(tenants, eq(tenants.id, approvals.tenantId))
      .where(sql`${approvals.state} <> 'pending'`)
      .orderBy(desc(approvals.decidedAt), desc(approvals.updatedAt))
      .limit(20);
    return { pending, decided };
  });
}

// Schedules -----------------------------------------------------------------------------------

export async function listSchedules(): Promise<ScheduleRow[]> {
  return operatorRead((tx) =>
    tx
      .select(scheduleColumns)
      .from(schedules)
      .innerJoin(tenants, eq(tenants.id, schedules.tenantId))
      .innerJoin(agentInstances, eq(agentInstances.id, schedules.agentInstanceId))
      .orderBy(tenants.name, schedules.name)
  );
}

// Costs ---------------------------------------------------------------------------------------

export interface CostsView {
  platform: { capUsdMonth: number; spentUsdMonth: number; hardStop: boolean; runCapUsd: number } | null;
  monthStart: Date;
  perTenant: Array<{ tenantId: string; tenantSlug: string; tenantName: string; capUsdMonth: number | null; spentUsdMonth: number; simulatedUsd: number; events: number }>;
  perAgent: Array<{ agentInstanceId: string; agentName: string; tenantName: string; capUsdMonth: number | null; spentUsdMonth: number; events: number }>;
  recent: Array<{ id: string; tenantName: string; agentName: string | null; runId: string | null; model: string; tokensInput: number; tokensOutput: number; costUsd: number; simulated: boolean; occurredAt: Date }>;
}

export async function getCostsView(): Promise<CostsView> {
  const since = monthStartUtc();
  return operatorRead(async (tx) => {
    const platform = await readPlatformBudget(tx);
    const perTenant = await tx
      .select({
        tenantId: tenants.id,
        tenantSlug: tenants.slug,
        tenantName: tenants.name,
        capUsdMonth: sql<number | null>`(select b.cap_usd_month from budgets b where b.scope = 'tenant' and b.tenant_id = ${tenants.id})`.mapWith((v: unknown) => (v === null ? null : Number(v))),
        spentUsdMonth: num(sql`coalesce((select sum(c.cost_usd) from cost_events c where c.tenant_id = ${tenants.id} and c.occurred_at >= ${since}), 0)`),
        simulatedUsd: num(sql`coalesce((select sum(c.cost_usd) from cost_events c where c.tenant_id = ${tenants.id} and c.occurred_at >= ${since} and c.simulated), 0)`),
        events: num(sql`(select count(*) from cost_events c where c.tenant_id = ${tenants.id} and c.occurred_at >= ${since})`)
      })
      .from(tenants)
      .where(sql`${tenants.kind} <> 'agency'`)
      .orderBy(tenants.name);
    const perAgent = await tx
      .select({
        agentInstanceId: agentInstances.id,
        agentName: agentInstances.name,
        tenantName: tenants.name,
        capUsdMonth: sql<number | null>`(select b.cap_usd_month from budgets b where b.scope = 'agent_instance' and b.agent_instance_id = ${agentInstances.id})`.mapWith((v: unknown) => (v === null ? null : Number(v))),
        spentUsdMonth: num(sql`coalesce((select sum(c.cost_usd) from cost_events c where c.agent_instance_id = ${agentInstances.id} and c.occurred_at >= ${since}), 0)`),
        events: num(sql`(select count(*) from cost_events c where c.agent_instance_id = ${agentInstances.id} and c.occurred_at >= ${since})`)
      })
      .from(agentInstances)
      .innerJoin(tenants, eq(tenants.id, agentInstances.tenantId))
      .orderBy(tenants.name, agentInstances.name);
    const recent = await tx
      .select({
        id: costEvents.id,
        tenantName: tenants.name,
        agentName: agentInstances.name,
        runId: costEvents.runId,
        model: costEvents.model,
        tokensInput: costEvents.tokensInput,
        tokensOutput: costEvents.tokensOutput,
        costUsd: num(sql`${costEvents.costUsd}`),
        simulated: costEvents.simulated,
        occurredAt: costEvents.occurredAt
      })
      .from(costEvents)
      .innerJoin(tenants, eq(tenants.id, costEvents.tenantId))
      .leftJoin(agentInstances, eq(agentInstances.id, costEvents.agentInstanceId))
      .orderBy(desc(costEvents.occurredAt))
      .limit(50);
    return { platform, monthStart: since, perTenant, perAgent, recent };
  });
}

// Incidents -----------------------------------------------------------------------------------

export interface IncidentRow {
  id: string;
  tenantId: string | null;
  tenantName: string | null;
  tenantSlug: string | null;
  kind: string;
  severity: string;
  title: string;
  details: unknown;
  runId: string | null;
  scheduleId: string | null;
  agentInstanceId: string | null;
  state: IncidentState;
  acknowledgedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

export async function listIncidents(state: IncidentState | null): Promise<IncidentRow[]> {
  return operatorRead((tx) =>
    tx
      .select({
        id: incidents.id,
        tenantId: incidents.tenantId,
        tenantName: tenants.name,
        tenantSlug: tenants.slug,
        kind: incidents.kind,
        severity: incidents.severity,
        title: incidents.title,
        details: incidents.details,
        runId: incidents.runId,
        scheduleId: incidents.scheduleId,
        agentInstanceId: incidents.agentInstanceId,
        state: incidents.state,
        acknowledgedBy: incidents.acknowledgedBy,
        resolvedAt: incidents.resolvedAt,
        createdAt: incidents.createdAt
      })
      .from(incidents)
      .leftJoin(tenants, eq(tenants.id, incidents.tenantId))
      .where(state ? eq(incidents.state, state) : undefined)
      .orderBy(desc(incidents.createdAt))
      .limit(200)
  );
}

export async function countIncidentsByState(): Promise<Array<{ state: IncidentState; n: number }>> {
  return operatorRead((tx) => tx.select({ state: incidents.state, n: num(sql`count(*)`) }).from(incidents).groupBy(incidents.state));
}

/** Tenants for filter drop-downs (metadata only). */
export async function listTenantOptions(): Promise<Array<{ id: string; slug: string; name: string }>> {
  return operatorRead((tx) => tx.select({ id: tenants.id, slug: tenants.slug, name: tenants.name }).from(tenants).where(sql`${tenants.kind} <> 'agency'`).orderBy(tenants.name));
}
