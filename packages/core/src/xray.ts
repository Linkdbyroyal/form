import { and, desc, eq, sql } from "drizzle-orm";
import { DashboardSpecificationSchema, ExecutiveBriefingSchema, KpiObservationSchema, type DashboardSpecification, type ExecutiveBriefing } from "@sbos/contracts";
import { schema, writeAudit, type RequestContext, type Tx } from "@sbos/db";
import type { JobBackend } from "./job-backend";
import { requestApproval } from "./approvals";

const { findings, opportunities, kpis, kpiObservations, dashboards, dashboardWidgets, actionTasks, briefings, processes, processSteps, schedules } = schema;

// KPI Registry --------------------------------------------------------------------------------

export interface DefineKpiInput {
  tenantId: string;
  key: string;
  name: string;
  businessQuestion: string;
  formula: string;
  unit: string;
  sourceSystem: string;
  sourceField: string;
  ownerRole: string;
  filters?: Record<string, string>;
  refresh?: (typeof schema.refreshFrequency.enumValues)[number];
  direction?: "higher_is_better" | "lower_is_better";
  warningThreshold?: number | null;
  criticalThreshold?: number | null;
  reliability?: (typeof schema.kpiReliability.enumValues)[number];
  permissionScope?: string[];
  status?: (typeof schema.kpiStatus.enumValues)[number];
}

/** Creates or updates a KPI definition. The database refuses definitions without formula, source system and field. */
export async function defineKpi(tx: Tx, ctx: RequestContext, input: DefineKpiInput): Promise<string> {
  const values = {
    tenantId: input.tenantId,
    key: input.key,
    name: input.name,
    businessQuestion: input.businessQuestion,
    formula: input.formula,
    unit: input.unit,
    sourceSystem: input.sourceSystem,
    sourceField: input.sourceField,
    ownerRole: input.ownerRole,
    filters: input.filters ?? {},
    refresh: input.refresh ?? "daily",
    direction: input.direction ?? "higher_is_better",
    warningThreshold: input.warningThreshold === undefined || input.warningThreshold === null ? null : String(input.warningThreshold),
    criticalThreshold: input.criticalThreshold === undefined || input.criticalThreshold === null ? null : String(input.criticalThreshold),
    reliability: input.reliability ?? "unknown",
    permissionScope: input.permissionScope ?? ["client_admin"],
    status: input.status ?? "draft",
    createdByActorType: ctx.actorType,
    createdByActorId: ctx.actorId
  };
  const [row] = await tx
    .insert(kpis)
    .values(values)
    .onConflictDoUpdate({
      target: [kpis.tenantId, kpis.key],
      set: { name: values.name, businessQuestion: values.businessQuestion, formula: values.formula, unit: values.unit, sourceSystem: values.sourceSystem, sourceField: values.sourceField, ownerRole: values.ownerRole, filters: values.filters, refresh: values.refresh, direction: values.direction, warningThreshold: values.warningThreshold, criticalThreshold: values.criticalThreshold, reliability: values.reliability, permissionScope: values.permissionScope, status: values.status }
    })
    .returning({ id: kpis.id });
  await writeAudit(tx, ctx, { action: "kpi.defined", entityType: "kpi", entityId: row!.id, after: { key: input.key, sourceSystem: input.sourceSystem } });
  return row!.id;
}

export interface ObserveKpiInput {
  tenantId: string;
  kpiId: string;
  periodStart: Date;
  periodEnd: Date;
  /** Required when status is ok; must be absent otherwise. */
  value?: number | null;
  status: "ok" | "missing_data" | "stale_data" | "error";
  sourceId?: string | null;
  lineage: { query_or_formula: string; source_record_ids: string[] };
  runId?: string | null;
}

/** Records an observation. Both the contract and the CHECK constraint forbid a number when data is missing or stale. */
export async function observeKpi(tx: Tx, ctx: RequestContext, input: ObserveKpiInput): Promise<string> {
  const [kpi] = await tx.select({ id: kpis.id, sourceSystem: kpis.sourceSystem, status: kpis.status }).from(kpis).where(and(eq(kpis.id, input.kpiId), eq(kpis.tenantId, input.tenantId)));
  if (!kpi) throw new Error("kpi not found");
  const value = input.status === "ok" ? (input.value ?? null) : null;
  KpiObservationSchema.parse({
    kpi_id: input.kpiId,
    tenant_id: input.tenantId,
    observed_at: new Date().toISOString(),
    period_start: input.periodStart.toISOString(),
    period_end: input.periodEnd.toISOString(),
    value,
    status: input.status,
    source: { source_id: input.sourceId ?? "00000000-0000-4000-8000-000000000000", system: kpi.sourceSystem },
    computed_by: { actor_type: ctx.actorType, actor_id: ctx.actorId },
    lineage: input.lineage
  });
  const [row] = await tx
    .insert(kpiObservations)
    .values({ tenantId: input.tenantId, kpiId: input.kpiId, periodStart: input.periodStart, periodEnd: input.periodEnd, value: value === null ? null : String(value), status: input.status, sourceId: input.sourceId ?? null, computedByActorType: ctx.actorType, computedByActorId: ctx.actorId, lineage: input.lineage, runId: input.runId ?? null })
    .returning({ id: kpiObservations.id });
  const nextStatus = input.status === "ok" ? "active" : input.status === "stale_data" ? "stale" : input.status === "missing_data" ? "missing_source" : kpi.status;
  await tx.update(kpis).set({ status: nextStatus, ...(input.status === "ok" ? { lastSuccessfulSyncAt: new Date() } : {}) }).where(eq(kpis.id, input.kpiId));
  return row!.id;
}

export async function latestObservations(tx: Tx, tenantId: string) {
  return tx.execute<{ kpi_id: string; key: string; name: string; unit: string; status: string; value: string | null; observed_at: Date; kpi_status: string; source_system: string; formula: string; owner_role: string; direction: string; warning_threshold: string | null; critical_threshold: string | null; last_successful_sync_at: Date | null }>(sql`
    SELECT k.id AS kpi_id, k.key, k.name, k.unit, k.status AS kpi_status, k.source_system, k.formula, k.owner_role, k.direction::text AS direction,
           k.warning_threshold::text AS warning_threshold, k.critical_threshold::text AS critical_threshold, k.last_successful_sync_at,
           o.status::text AS status, o.value::text AS value, o.observed_at
    FROM kpis k
    LEFT JOIN LATERAL (SELECT status, value, observed_at FROM kpi_observations WHERE kpi_id = k.id ORDER BY observed_at DESC LIMIT 1) o ON true
    WHERE k.tenant_id = ${tenantId} AND k.status <> 'retired'
    ORDER BY k.name`);
}

// Findings and opportunities ------------------------------------------------------------------

export interface CreateFindingInput {
  tenantId: string;
  title: string;
  description: string;
  department: string;
  severity: (typeof schema.findingSeverity.enumValues)[number];
  urgency: string;
  impact: { description: string; estimated_annual_cost?: { amount: number; currency: string; is_estimate: true } };
  ownerRole: string;
  claim: "client_statement" | "data_observation" | "hypothesis";
  evidenceIds?: string[];
  sourceIds: string[];
  confidence: number;
  processId?: string | null;
  agentInstanceId?: string | null;
  runId?: string | null;
}

export async function createFinding(tx: Tx, ctx: RequestContext, input: CreateFindingInput): Promise<string> {
  if (input.sourceIds.length === 0) throw new Error("a finding needs at least one source");
  const [row] = await tx
    .insert(findings)
    .values({ tenantId: input.tenantId, title: input.title, description: input.description, department: input.department, processId: input.processId ?? null, severity: input.severity, urgency: input.urgency, impact: input.impact, ownerRole: input.ownerRole, evidenceIds: input.evidenceIds ?? [], sourceIds: input.sourceIds, claim: input.claim, confidence: String(input.confidence), agentInstanceId: input.agentInstanceId ?? null, runId: input.runId ?? null })
    .returning({ id: findings.id });
  await writeAudit(tx, ctx, { action: "finding.created", entityType: "finding", entityId: row!.id, after: { severity: input.severity, claim: input.claim } });
  return row!.id;
}

export interface CreateOpportunityInput {
  tenantId: string;
  title: string;
  description: string;
  findingIds: string[];
  intervention: (typeof schema.interventionType.enumValues)[number];
  businessCase: Record<string, unknown>;
  priorityScore: { impact: number; feasibility: number; risk: number; time_to_value: number };
  sourceIds: string[];
  confidence: number;
  toBeProcessId?: string | null;
  agentInstanceId?: string | null;
  runId?: string | null;
  approverRole?: string;
}

/** Creates a proposed opportunity and a pending approval for it. Nothing changes in production without the decision. */
export async function proposeOpportunity(tx: Tx, ctx: RequestContext, input: CreateOpportunityInput): Promise<{ opportunityId: string; approvalId: string }> {
  const p = input.priorityScore;
  const composite = Math.round(((p.impact * p.feasibility * p.time_to_value) / Math.max(1, p.risk)) * 100) / 100;
  const [row] = await tx
    .insert(opportunities)
    .values({ tenantId: input.tenantId, title: input.title, description: input.description, findingIds: input.findingIds, intervention: input.intervention, businessCase: input.businessCase, priorityScore: { ...p, composite }, toBeProcessId: input.toBeProcessId ?? null, sourceIds: input.sourceIds, confidence: String(input.confidence), agentInstanceId: input.agentInstanceId ?? null, runId: input.runId ?? null, requiresApproval: true })
    .returning({ id: opportunities.id });
  const { approvalId } = await requestApproval(tx, ctx, {
    tenantId: input.tenantId,
    runId: null,
    subjectType: "opportunity",
    subjectId: row!.id,
    requestedBy: { actorType: ctx.actorType, actorId: ctx.actorId },
    approverRole: input.approverRole ?? "client_admin",
    risk: "medium",
    summary: `Approve opportunity: ${input.title}`,
    rationale: input.description.slice(0, 500)
  });
  await tx.update(opportunities).set({ approvalId }).where(eq(opportunities.id, row!.id));
  await writeAudit(tx, ctx, { action: "opportunity.proposed", entityType: "opportunity", entityId: row!.id, after: { intervention: input.intervention, composite } });
  return { opportunityId: row!.id, approvalId };
}

/** Moves an approved opportunity forward; the trigger blocks it unless the linked approval is approved. */
export async function setOpportunityState(tx: Tx, ctx: RequestContext, input: { tenantId: string; opportunityId: string; state: (typeof schema.opportunityState.enumValues)[number] }): Promise<void> {
  await tx.update(opportunities).set({ state: input.state }).where(and(eq(opportunities.id, input.opportunityId), eq(opportunities.tenantId, input.tenantId)));
  await writeAudit(tx, ctx, { action: "opportunity.state", entityType: "opportunity", entityId: input.opportunityId, after: { state: input.state } });
}

// Management Action Center -----------------------------------------------------------------------

export interface CreateActionTaskInput {
  tenantId: string;
  title: string;
  issue: string;
  proposedAction: string;
  opportunityId?: string | null;
  findingId?: string | null;
  ownerRole: string;
  dueAt?: Date | null;
  sourceIds: string[];
  /** When the opportunity is already approved, reuse its approval; otherwise a new approval is requested. */
  approvalId?: string | null;
}

export async function createActionTask(tx: Tx, ctx: RequestContext, input: CreateActionTaskInput): Promise<{ taskId: string; approvalId: string }> {
  let approvalId = input.approvalId ?? null;
  if (!approvalId) {
    const r = await requestApproval(tx, ctx, { tenantId: input.tenantId, subjectType: "action_task", requestedBy: { actorType: ctx.actorType, actorId: ctx.actorId }, approverRole: "client_admin", risk: "medium", summary: `Approve action: ${input.title}`, rationale: input.proposedAction.slice(0, 500) });
    approvalId = r.approvalId;
  }
  const [row] = await tx
    .insert(actionTasks)
    .values({ tenantId: input.tenantId, title: input.title, issue: input.issue, proposedAction: input.proposedAction, opportunityId: input.opportunityId ?? null, findingId: input.findingId ?? null, ownerRole: input.ownerRole, approvalId, state: "awaiting_approval", dueAt: input.dueAt ?? null, sourceIds: input.sourceIds, createdByActorType: ctx.actorType, createdByActorId: ctx.actorId })
    .returning({ id: actionTasks.id });
  await writeAudit(tx, ctx, { action: "action_task.created", entityType: "action_task", entityId: row!.id, after: { ownerRole: input.ownerRole } });
  return { taskId: row!.id, approvalId };
}

/**
 * After the approval is decided: assigns the task to its owner and schedules a verification run for the
 * Performance agent instance (if the tenant has one). The DB trigger refuses the transition without an approved approval.
 */
export async function activateActionTask(tx: Tx, ctx: RequestContext, jobs: JobBackend, input: { tenantId: string; taskId: string; ownerUserId?: string | null; verifyAfterDays?: number; verificationAgentInstanceId?: string | null }): Promise<{ scheduleId: string | null }> {
  const [task] = await tx.select().from(actionTasks).where(and(eq(actionTasks.id, input.taskId), eq(actionTasks.tenantId, input.tenantId)));
  if (!task) throw new Error("action task not found");
  let scheduleId: string | null = null;
  if (input.verificationAgentInstanceId) {
    const due = new Date(Date.now() + (input.verifyAfterDays ?? 7) * 86_400_000);
    const [s] = await tx
      .insert(schedules)
      .values({ tenantId: input.tenantId, agentInstanceId: input.verificationAgentInstanceId, name: `Verify action: ${task.title}`.slice(0, 120), cron: `${due.getUTCMinutes()} ${due.getUTCHours()} ${due.getUTCDate()} ${due.getUTCMonth() + 1} *`, timezone: "UTC", enabled: true, expectedBySeconds: 3600, instruction: `Verify whether action task ${task.id} was carried out and what changed. Report evidence, do not assume.` })
      .returning({ id: schedules.id });
    scheduleId = s!.id;
  }
  await tx.update(actionTasks).set({ state: "assigned", ownerUserId: input.ownerUserId ?? null, verificationScheduleId: scheduleId }).where(eq(actionTasks.id, task.id));
  await writeAudit(tx, ctx, { action: "action_task.assigned", entityType: "action_task", entityId: task.id, after: { ownerUserId: input.ownerUserId ?? null, scheduleId } });
  void jobs;
  return { scheduleId };
}

export async function setActionTaskState(tx: Tx, ctx: RequestContext, input: { tenantId: string; taskId: string; state: (typeof schema.actionTaskState.enumValues)[number]; note?: string }): Promise<void> {
  await tx
    .update(actionTasks)
    .set({ state: input.state, verificationNote: input.note ?? null, ...(input.state === "closed" ? { closedAt: new Date() } : {}) })
    .where(and(eq(actionTasks.id, input.taskId), eq(actionTasks.tenantId, input.tenantId)));
  await writeAudit(tx, ctx, { action: "action_task.state", entityType: "action_task", entityId: input.taskId, after: { state: input.state } });
}

// Dashboards and briefings ------------------------------------------------------------------------

/** Validates the specification against the contract (widget whitelist) and stores it as the current dashboard for its audience. */
export async function publishDashboard(tx: Tx, ctx: RequestContext, input: { tenantId: string; specification: unknown; agentInstanceId?: string | null; runId?: string | null }): Promise<{ dashboardId: string; version: number; spec: DashboardSpecification }> {
  const spec = DashboardSpecificationSchema.parse(input.specification);
  if (spec.tenant_id !== input.tenantId) throw new Error("dashboard specification tenant mismatch");
  const [prev] = await tx.select({ version: dashboards.version }).from(dashboards).where(and(eq(dashboards.tenantId, input.tenantId), eq(dashboards.audience, spec.audience_role))).orderBy(desc(dashboards.version)).limit(1);
  const version = (prev?.version ?? 0) + 1;
  await tx.update(dashboards).set({ isCurrent: false }).where(and(eq(dashboards.tenantId, input.tenantId), eq(dashboards.audience, spec.audience_role)));
  const [row] = await tx
    .insert(dashboards)
    .values({ tenantId: input.tenantId, audience: spec.audience_role, title: spec.title, locale: spec.locale, version, specification: spec, reviewStatus: spec.review_status, generatedByAgentInstanceId: input.agentInstanceId ?? null, runId: input.runId ?? null, isCurrent: true })
    .returning({ id: dashboards.id });
  await tx.insert(dashboardWidgets).values(spec.widgets.map((w) => ({ tenantId: input.tenantId, dashboardId: row!.id, widgetKey: w.widget_id, type: w.type, kpiIds: w.kpi_ids, priority: w.priority, reason: w.reason, size: w.size, config: w.config ?? {} })));
  await writeAudit(tx, ctx, { action: "dashboard.published", entityType: "dashboard", entityId: row!.id, after: { audience: spec.audience_role, version, widgets: spec.widgets.length } });
  return { dashboardId: row!.id, version, spec };
}

export async function currentDashboard(tx: Tx, tenantId: string, audience: (typeof schema.dashboardAudience.enumValues)[number]) {
  const [row] = await tx.select().from(dashboards).where(and(eq(dashboards.tenantId, tenantId), eq(dashboards.audience, audience), eq(dashboards.isCurrent, true)));
  return row ?? null;
}

export async function storeBriefing(tx: Tx, ctx: RequestContext, input: { tenantId: string; briefing: unknown; vaultDocumentId?: string | null; agentInstanceId?: string | null; runId?: string | null; simulated: boolean }): Promise<{ briefingId: string; briefing: ExecutiveBriefing }> {
  const briefing = ExecutiveBriefingSchema.parse(input.briefing);
  if (briefing.tenant_id !== input.tenantId) throw new Error("briefing tenant mismatch");
  const [row] = await tx
    .insert(briefings)
    .values({ tenantId: input.tenantId, briefingDate: briefing.briefing_date, audience: "ceo", content: briefing, vaultDocumentId: input.vaultDocumentId ?? null, agentInstanceId: input.agentInstanceId ?? null, runId: input.runId ?? null, simulated: input.simulated })
    .onConflictDoUpdate({ target: [briefings.tenantId, briefings.briefingDate, briefings.audience], set: { content: briefing, vaultDocumentId: input.vaultDocumentId ?? null, runId: input.runId ?? null, simulated: input.simulated } })
    .returning({ id: briefings.id });
  await writeAudit(tx, ctx, { action: "briefing.stored", entityType: "briefing", entityId: row!.id, after: { date: briefing.briefing_date, priorities: briefing.top_priorities.length } });
  return { briefingId: row!.id, briefing };
}

// Processes ----------------------------------------------------------------------------------------

export interface ProcessStepInput {
  kind: (typeof schema.processStepKind.enumValues)[number];
  name: string;
  ownerRole?: string | null;
  systemName?: string | null;
  input?: string | null;
  output?: string | null;
  waitTimeHint?: string | null;
  exceptions?: string | null;
  control?: string | null;
  intervention?: (typeof schema.interventionType.enumValues)[number] | null;
}

export async function upsertProcess(tx: Tx, ctx: RequestContext, input: { tenantId: string; key: string; name: string; department?: string | null; variant: "as_is" | "to_be"; ownerRole?: string | null; description?: string | null; sourceIds: string[]; steps: ProcessStepInput[] }): Promise<string> {
  const [existing] = await tx.select({ id: processes.id }).from(processes).where(and(eq(processes.tenantId, input.tenantId), eq(processes.key, input.key), eq(processes.variant, input.variant)));
  let processId: string;
  if (existing) {
    processId = existing.id;
    await tx.update(processes).set({ name: input.name, department: input.department ?? null, ownerRole: input.ownerRole ?? null, description: input.description ?? null, sourceIds: input.sourceIds }).where(eq(processes.id, processId));
    await tx.delete(processSteps).where(eq(processSteps.processId, processId));
  } else {
    const [row] = await tx.insert(processes).values({ tenantId: input.tenantId, key: input.key, name: input.name, department: input.department ?? null, variant: input.variant, ownerRole: input.ownerRole ?? null, description: input.description ?? null, sourceIds: input.sourceIds, createdByActorType: ctx.actorType, createdByActorId: ctx.actorId }).returning({ id: processes.id });
    processId = row!.id;
  }
  if (input.steps.length > 0) {
    await tx.insert(processSteps).values(input.steps.map((s, i) => ({ tenantId: input.tenantId, processId, seq: i + 1, kind: s.kind, name: s.name, ownerRole: s.ownerRole ?? null, systemName: s.systemName ?? null, input: s.input ?? null, output: s.output ?? null, waitTimeHint: s.waitTimeHint ?? null, exceptions: s.exceptions ?? null, control: s.control ?? null, intervention: s.intervention ?? null, sourceIds: input.sourceIds })));
  }
  await writeAudit(tx, ctx, { action: existing ? "process.updated" : "process.created", entityType: "process", entityId: processId, after: { key: input.key, variant: input.variant, steps: input.steps.length } });
  return processId;
}
