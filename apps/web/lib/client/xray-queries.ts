import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type TenantContext, type Tx } from "@sbos/db";
import { currentDashboard, latestObservations } from "@sbos/core";
import { ExecutiveBriefingSchema, type ExecutiveBriefing } from "@sbos/contracts";
import type { ActionTaskLite, BriefingLite, DashboardData, FindingLite, KpiLatestRow, ObservationPoint } from "@/components/dashboard/types";
import { getDb } from "../db";
import { maturityScore, type MaturityResult } from "./kpi-state";

/**
 * Milestone 3 reads for the Client Workspace: CEO Dashboard, KPI lineage, briefings, Business X-Ray and
 * the Management Action Center. Every function runs in TENANT context (`sbos_app`, `app.tenant_id` set),
 * so Row-Level Security limits the rows to the caller's tenant. Dates are returned as ISO strings where
 * the result is handed to the dashboard renderer (plain JSON for the client chart components).
 */
const { tenants, departments, systems, kpis, kpiObservations, actionTasks, findings, opportunities, briefings, processes, processSteps, approvals, questions, vaultFacts, users, memberships, agentInstances, auditEvents, schedules } = schema;

const num = (expr: ReturnType<typeof sql>) => sql<number>`${expr}`.mapWith(Number);
const iso = (d: Date | string | null | undefined): string | null => (d ? (typeof d === "string" ? new Date(d) : d).toISOString() : null);

function parseBriefing(row: { id: string; briefingDate: string; simulated: boolean; content: unknown }): BriefingLite | null {
  const parsed = ExecutiveBriefingSchema.safeParse(row.content);
  if (!parsed.success) return null;
  return { id: row.id, briefingDate: row.briefingDate, simulated: row.simulated, content: parsed.data };
}

async function kpiRows(tx: Tx, tenantId: string): Promise<KpiLatestRow[]> {
  const latest = await latestObservations(tx, tenantId);
  const fields = await tx.select({ id: kpis.id, sourceField: kpis.sourceField }).from(kpis);
  const fieldById = new Map(fields.map((f) => [f.id, f.sourceField]));
  return latest.rows.map((r) => ({
    kpiId: r.kpi_id,
    key: r.key,
    name: r.name,
    unit: r.unit,
    kpiStatus: r.kpi_status,
    sourceSystem: r.source_system,
    sourceField: fieldById.get(r.kpi_id) ?? "",
    formula: r.formula,
    ownerRole: r.owner_role,
    direction: r.direction,
    warningThreshold: r.warning_threshold,
    criticalThreshold: r.critical_threshold,
    lastSuccessfulSyncAt: iso(r.last_successful_sync_at),
    status: r.status ?? null,
    value: r.value ?? null,
    observedAt: iso(r.observed_at)
  }));
}

// CEO Dashboard ------------------------------------------------------------------------------------

export interface DashboardPage {
  dashboard: { id: string; title: string; version: number; reviewStatus: string; createdAt: Date; generatedBy: string | null; runId: string | null; specification: unknown } | null;
  data: DashboardData;
  ceoAgent: { id: string; name: string; state: string } | null;
  /** Earlier dashboard versions for the audience (metadata only). */
  versions: Array<{ id: string; version: number; reviewStatus: string; createdAt: Date; isCurrent: boolean }>;
}

export async function getDashboardPage(ctx: TenantContext, slug: string): Promise<DashboardPage> {
  return getDb().withContext(ctx, async (tx) => {
    const row = await currentDashboard(tx, ctx.tenantId, "ceo");
    const generatedBy = row?.generatedByAgentInstanceId ? (await tx.select({ name: agentInstances.name }).from(agentInstances).where(eq(agentInstances.id, row.generatedByAgentInstanceId)))[0]?.name ?? null : null;
    const data = await loadDashboardData(tx, ctx.tenantId, slug);
    const [ceoAgent] = await tx.select({ id: agentInstances.id, name: agentInstances.name, state: agentInstances.state }).from(agentInstances).where(sql`${agentInstances.serviceIdentity} like 'agent:ceo-intelligence:%'`).limit(1);
    const versions = await tx.select({ id: schema.dashboards.id, version: schema.dashboards.version, reviewStatus: schema.dashboards.reviewStatus, createdAt: schema.dashboards.createdAt, isCurrent: schema.dashboards.isCurrent }).from(schema.dashboards).where(eq(schema.dashboards.audience, "ceo")).orderBy(desc(schema.dashboards.version)).limit(10);
    return {
      dashboard: row ? { id: row.id, title: row.title, version: row.version, reviewStatus: row.reviewStatus, createdAt: row.createdAt, generatedBy, runId: row.runId, specification: row.specification } : null,
      data,
      ceoAgent: ceoAgent ?? null,
      versions
    };
  });
}

async function loadDashboardData(tx: Tx, tenantId: string, slug: string): Promise<DashboardData> {
  const kpiList = await kpiRows(tx, tenantId);
  const ids = kpiList.map((k) => k.kpiId);
  const obs = ids.length > 0 ? await tx.select({ kpiId: kpiObservations.kpiId, observedAt: kpiObservations.observedAt, periodStart: kpiObservations.periodStart, periodEnd: kpiObservations.periodEnd, status: kpiObservations.status, value: kpiObservations.value }).from(kpiObservations).where(inArray(kpiObservations.kpiId, ids)).orderBy(asc(kpiObservations.observedAt)).limit(2000) : [];
  const history: Record<string, ObservationPoint[]> = {};
  for (const o of obs) (history[o.kpiId] ??= []).push({ observedAt: o.observedAt.toISOString(), periodStart: o.periodStart.toISOString(), periodEnd: o.periodEnd.toISOString(), status: o.status, value: o.value });
  const taskRows = await tx
    .select({ id: actionTasks.id, title: actionTasks.title, state: actionTasks.state, ownerRole: actionTasks.ownerRole, ownerName: users.displayName, dueAt: actionTasks.dueAt, verificationNote: actionTasks.verificationNote })
    .from(actionTasks)
    .leftJoin(users, eq(users.id, actionTasks.ownerUserId))
    .orderBy(desc(actionTasks.createdAt))
    .limit(50);
  const tasks: ActionTaskLite[] = taskRows.map((t) => ({ ...t, dueAt: iso(t.dueAt) }));
  const findingRows: FindingLite[] = await tx.select({ id: findings.id, title: findings.title, severity: findings.severity, claim: findings.claim, department: findings.department, state: findings.state, ownerRole: findings.ownerRole }).from(findings).orderBy(desc(findings.createdAt)).limit(100);
  const [b] = await tx.select({ id: briefings.id, briefingDate: briefings.briefingDate, simulated: briefings.simulated, content: briefings.content }).from(briefings).where(eq(briefings.audience, "ceo")).orderBy(desc(briefings.briefingDate)).limit(1);
  return { slug, kpis: kpiList, history, tasks, findings: findingRows, briefing: b ? parseBriefing(b) : null };
}

// KPI lineage ----------------------------------------------------------------------------------------

export interface KpiLineage {
  kpi: typeof kpis.$inferSelect;
  latest: KpiLatestRow | null;
  observations: Array<{ id: string; observedAt: Date; periodStart: Date; periodEnd: Date; value: string | null; status: string; computedByActorType: string; computedByActorId: string; lineage: unknown; runId: string | null; sourceId: string | null }>;
  audit: Array<{ id: string; action: string; actorType: string; actorId: string; occurredAt: Date; metadata: unknown; afterHash: string | null }>;
}

export async function getKpiLineage(ctx: TenantContext, kpiId: string): Promise<KpiLineage | null> {
  return getDb().withContext(ctx, async (tx) => {
    const [kpi] = await tx.select().from(kpis).where(eq(kpis.id, kpiId));
    if (!kpi) return null;
    const latest = (await kpiRows(tx, ctx.tenantId)).find((k) => k.kpiId === kpiId) ?? null;
    const observations = await tx
      .select({ id: kpiObservations.id, observedAt: kpiObservations.observedAt, periodStart: kpiObservations.periodStart, periodEnd: kpiObservations.periodEnd, value: kpiObservations.value, status: kpiObservations.status, computedByActorType: kpiObservations.computedByActorType, computedByActorId: kpiObservations.computedByActorId, lineage: kpiObservations.lineage, runId: kpiObservations.runId, sourceId: kpiObservations.sourceId })
      .from(kpiObservations)
      .where(eq(kpiObservations.kpiId, kpiId))
      .orderBy(desc(kpiObservations.observedAt))
      .limit(200);
    const audit = await tx
      .select({ id: auditEvents.id, action: auditEvents.action, actorType: auditEvents.actorType, actorId: auditEvents.actorId, occurredAt: auditEvents.occurredAt, metadata: auditEvents.metadata, afterHash: auditEvents.afterHash })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "kpi"), eq(auditEvents.entityId, kpiId)))
      .orderBy(desc(auditEvents.occurredAt))
      .limit(100);
    return { kpi, latest, observations, audit };
  });
}

// Briefings ------------------------------------------------------------------------------------------

export interface BriefingPage {
  latest: BriefingLite | null;
  /** Raw content when the stored briefing fails the contract (shown as an error, never rendered as a briefing). */
  invalidLatest: { id: string; briefingDate: string } | null;
  earlier: Array<{ id: string; briefingDate: string; simulated: boolean; createdAt: Date; priorities: number }>;
  /** Titles for ids a briefing item may reference as evidence. */
  refs: Record<string, { kind: "finding" | "opportunity" | "task"; title: string }>;
}

export async function getBriefingPage(ctx: TenantContext, briefingId: string | null): Promise<BriefingPage> {
  return getDb().withContext(ctx, async (tx) => {
    const rows = await tx.select({ id: briefings.id, briefingDate: briefings.briefingDate, simulated: briefings.simulated, content: briefings.content, createdAt: briefings.createdAt }).from(briefings).where(eq(briefings.audience, "ceo")).orderBy(desc(briefings.briefingDate)).limit(60);
    const chosen = (briefingId ? rows.find((r) => r.id === briefingId) : rows[0]) ?? null;
    const latest = chosen ? parseBriefing(chosen) : null;
    const earlier = rows.filter((r) => r.id !== chosen?.id).map((r) => ({ id: r.id, briefingDate: r.briefingDate, simulated: r.simulated, createdAt: r.createdAt, priorities: Array.isArray((r.content as { top_priorities?: unknown[] })?.top_priorities) ? (r.content as { top_priorities: unknown[] }).top_priorities.length : 0 }));
    const refs: BriefingPage["refs"] = {};
    for (const f of await tx.select({ id: findings.id, title: findings.title }).from(findings)) refs[f.id] = { kind: "finding", title: f.title };
    for (const o of await tx.select({ id: opportunities.id, title: opportunities.title }).from(opportunities)) refs[o.id] = { kind: "opportunity", title: o.title };
    for (const t of await tx.select({ id: actionTasks.id, title: actionTasks.title }).from(actionTasks)) refs[t.id] = { kind: "task", title: t.title };
    return { latest, invalidLatest: chosen && !latest ? { id: chosen.id, briefingDate: chosen.briefingDate } : null, earlier, refs };
  });
}

// Business X-Ray -------------------------------------------------------------------------------------

export interface XrayDepartment {
  id: string;
  key: string;
  name: string;
  headRole: string | null;
  maturity: MaturityResult;
  questions: { open: number; answered: number; draft: number; total: number };
  findings: { open: number; critical: number; high: number };
  systems: number;
}

export interface XrayProcess {
  id: string;
  key: string;
  name: string;
  department: string | null;
  variant: string;
  ownerRole: string | null;
  description: string | null;
  verification: string;
  sourceCount: number;
  steps: Array<{ id: string; seq: number; kind: string; name: string; ownerRole: string | null; systemName: string | null; input: string | null; output: string | null; waitTimeHint: string | null; exceptions: string | null; control: string | null; intervention: string | null }>;
}

export interface XrayPage {
  tenant: { id: string; name: string; slug: string; kind: string; status: string; industry: string | null; locale: string; createdAt: Date };
  departments: XrayDepartment[];
  systems: Array<{ id: string; name: string; vendor: string | null; function: string; departmentKey: string | null; claimStatus: string; apiCapabilities: string[]; sourceOfTruthFor: string[] }>;
  facts: { total: number; verified: number; byVerification: Array<{ verification: string; n: number }> };
  processes: XrayProcess[];
  findings: Array<{ id: string; title: string; description: string; department: string; severity: string; urgency: string; claim: string; confidence: number; state: string; reviewStatus: string; ownerRole: string; sourceCount: number; evidenceCount: number; impact: unknown; createdAt: Date }>;
  openQuestionsByDepartment: Array<{ department: string; n: number }>;
  pendingApprovals: Array<{ id: string; subjectType: string; summary: string; approverRole: string; risk: string; createdAt: Date }>;
  opportunities: Array<{ id: string; title: string; description: string; intervention: string; state: string; requiresApproval: boolean; approvalId: string | null; approvalState: string | null; priorityScore: unknown; businessCase: unknown; confidence: number; findingIds: string[]; toBeProcessId: string | null; createdAt: Date }>;
}

export async function getXrayPage(ctx: TenantContext): Promise<XrayPage | null> {
  return getDb().withContext(ctx, async (tx) => {
    const [tenant] = await tx.select({ id: tenants.id, name: tenants.name, slug: tenants.slug, kind: tenants.kind, status: tenants.status, industry: tenants.industry, locale: tenants.locale, createdAt: tenants.createdAt }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    if (!tenant) return null;
    const deps = await tx.select({ id: departments.id, key: departments.key, name: departments.name, headRole: departments.headRole }).from(departments).orderBy(departments.name);
    const sys = await tx
      .select({ id: systems.id, name: systems.name, vendor: systems.vendor, function: systems.function, departmentKey: departments.key, claimStatus: systems.claimStatus, apiCapabilities: systems.apiCapabilities, sourceOfTruthFor: systems.sourceOfTruthFor })
      .from(systems)
      .leftJoin(departments, eq(departments.id, systems.departmentId))
      .orderBy(systems.name);
    const qCounts = await tx.select({ department: questions.department, state: questions.state, n: num(sql`count(*)`) }).from(questions).groupBy(questions.department, questions.state);
    const factCounts = await tx.select({ verification: vaultFacts.verification, n: num(sql`count(*)`) }).from(vaultFacts).groupBy(vaultFacts.verification);
    const factsTotal = factCounts.reduce((a, r) => a + r.n, 0);
    const factsVerified = factCounts.filter((r) => r.verification === "verified" || r.verification === "approved_policy").reduce((a, r) => a + r.n, 0);
    const findingRows = await tx.select({ id: findings.id, title: findings.title, description: findings.description, department: findings.department, severity: findings.severity, urgency: findings.urgency, claim: findings.claim, confidence: num(sql`${findings.confidence}`), state: findings.state, reviewStatus: findings.reviewStatus, ownerRole: findings.ownerRole, sourceCount: num(sql`coalesce(array_length(${findings.sourceIds}, 1), 0)`), evidenceCount: num(sql`coalesce(array_length(${findings.evidenceIds}, 1), 0)`), impact: findings.impact, createdAt: findings.createdAt }).from(findings).orderBy(desc(findings.createdAt));
    const procRows = await tx.select({ id: processes.id, key: processes.key, name: processes.name, department: processes.department, variant: processes.variant, ownerRole: processes.ownerRole, description: processes.description, verification: processes.verification, sourceCount: num(sql`coalesce(array_length(${processes.sourceIds}, 1), 0)`) }).from(processes).orderBy(processes.key, processes.variant);
    const stepRows = procRows.length > 0 ? await tx.select({ id: processSteps.id, processId: processSteps.processId, seq: processSteps.seq, kind: processSteps.kind, name: processSteps.name, ownerRole: processSteps.ownerRole, systemName: processSteps.systemName, input: processSteps.input, output: processSteps.output, waitTimeHint: processSteps.waitTimeHint, exceptions: processSteps.exceptions, control: processSteps.control, intervention: processSteps.intervention }).from(processSteps).where(inArray(processSteps.processId, procRows.map((p) => p.id))).orderBy(asc(processSteps.seq)) : [];
    const pending = await tx.select({ id: approvals.id, subjectType: approvals.subjectType, summary: approvals.summary, approverRole: approvals.approverRole, risk: approvals.risk, createdAt: approvals.createdAt }).from(approvals).where(eq(approvals.state, "pending")).orderBy(approvals.createdAt);
    const opps = await tx
      .select({ id: opportunities.id, title: opportunities.title, description: opportunities.description, intervention: opportunities.intervention, state: opportunities.state, requiresApproval: opportunities.requiresApproval, approvalId: opportunities.approvalId, approvalState: approvals.state, priorityScore: opportunities.priorityScore, businessCase: opportunities.businessCase, confidence: num(sql`${opportunities.confidence}`), findingIds: opportunities.findingIds, toBeProcessId: opportunities.toBeProcessId, createdAt: opportunities.createdAt })
      .from(opportunities)
      .leftJoin(approvals, eq(approvals.id, opportunities.approvalId))
      .orderBy(desc(opportunities.createdAt));

    const departmentsOut: XrayDepartment[] = deps.map((d) => {
      const q = qCounts.filter((r) => r.department === d.key);
      const count = (state: string) => q.filter((r) => r.state === state).reduce((a, r) => a + r.n, 0);
      const open = count("open");
      const answered = count("answered");
      const draft = count("draft");
      const total = q.reduce((a, r) => a + r.n, 0);
      const f = findingRows.filter((r) => r.department === d.key && r.state === "open");
      const critical = f.filter((r) => r.severity === "critical").length;
      const high = f.filter((r) => r.severity === "high").length;
      const deptSystems = sys.filter((s) => s.departmentKey === d.key);
      const verifiedSystems = deptSystems.filter((s) => s.claimStatus !== "stated").length;
      return {
        ...d,
        questions: { open, answered, draft, total },
        findings: { open: f.length, critical, high },
        systems: deptSystems.length,
        maturity: maturityScore({ answeredQuestions: answered, totalQuestions: total, verifiedFacts: factsVerified, totalFacts: factsTotal, systems: deptSystems.length, verifiedSystems, openCriticalFindings: critical, openHighFindings: high })
      };
    });
    const openByDept = qCounts.filter((r) => r.state === "open").map((r) => ({ department: r.department, n: r.n })).sort((a, b) => b.n - a.n);
    return {
      tenant,
      departments: departmentsOut,
      systems: sys,
      facts: { total: factsTotal, verified: factsVerified, byVerification: factCounts },
      processes: procRows.map((p) => ({ ...p, steps: stepRows.filter((s) => s.processId === p.id).map(({ processId: _p, ...s }) => s) })),
      findings: findingRows,
      openQuestionsByDepartment: openByDept,
      pendingApprovals: pending,
      opportunities: opps
    };
  });
}

// Management Action Center ---------------------------------------------------------------------------

export interface ActionCenterPage {
  opportunities: Array<{ id: string; title: string; description: string; intervention: string; state: string; requiresApproval: boolean; approvalId: string | null; approval: { state: string; approverRole: string; risk: string; summary: string; decidedAt: Date | null; decisionNote: string | null; requestedByActorId: string } | null; priorityScore: unknown; businessCase: unknown; sourceIds: string[]; findingTitles: string[]; createdAt: Date; taskCount: number }>;
  tasks: Array<{ id: string; title: string; issue: string; proposedAction: string; state: string; ownerRole: string | null; ownerUserId: string | null; ownerName: string | null; ownerEmail: string | null; dueAt: Date | null; verificationNote: string | null; closedAt: Date | null; opportunityId: string | null; opportunityTitle: string | null; approvalId: string | null; approvalState: string | null; schedule: { id: string; name: string; cron: string; enabled: boolean; nextRunAt: Date | null; lastRunAt: Date | null } | null; createdAt: Date }>;
  members: Array<{ userId: string; displayName: string; email: string; roleKey: string; departmentKey: string | null }>;
  performanceAgent: { id: string; name: string; state: string } | null;
}

export async function getActionCenterPage(ctx: TenantContext): Promise<ActionCenterPage> {
  return getDb().withContext(ctx, async (tx) => {
    const oppRows = await tx
      .select({ id: opportunities.id, title: opportunities.title, description: opportunities.description, intervention: opportunities.intervention, state: opportunities.state, requiresApproval: opportunities.requiresApproval, approvalId: opportunities.approvalId, priorityScore: opportunities.priorityScore, businessCase: opportunities.businessCase, sourceIds: opportunities.sourceIds, findingIds: opportunities.findingIds, createdAt: opportunities.createdAt, aState: approvals.state, aApproverRole: approvals.approverRole, aRisk: approvals.risk, aSummary: approvals.summary, aDecidedAt: approvals.decidedAt, aNote: approvals.decisionNote, aRequestedBy: approvals.requestedByActorId })
      .from(opportunities)
      .leftJoin(approvals, eq(approvals.id, opportunities.approvalId))
      .orderBy(desc(opportunities.createdAt));
    const findingTitles = new Map((await tx.select({ id: findings.id, title: findings.title }).from(findings)).map((f) => [f.id, f.title]));
    const taskRows = await tx
      .select({ id: actionTasks.id, title: actionTasks.title, issue: actionTasks.issue, proposedAction: actionTasks.proposedAction, state: actionTasks.state, ownerRole: actionTasks.ownerRole, ownerUserId: actionTasks.ownerUserId, ownerName: users.displayName, ownerEmail: users.email, dueAt: actionTasks.dueAt, verificationNote: actionTasks.verificationNote, closedAt: actionTasks.closedAt, opportunityId: actionTasks.opportunityId, opportunityTitle: opportunities.title, approvalId: actionTasks.approvalId, approvalState: approvals.state, scheduleId: schedules.id, scheduleName: schedules.name, scheduleCron: schedules.cron, scheduleEnabled: schedules.enabled, scheduleNext: schedules.nextRunAt, scheduleLast: schedules.lastRunAt, createdAt: actionTasks.createdAt })
      .from(actionTasks)
      .leftJoin(users, eq(users.id, actionTasks.ownerUserId))
      .leftJoin(opportunities, eq(opportunities.id, actionTasks.opportunityId))
      .leftJoin(approvals, eq(approvals.id, actionTasks.approvalId))
      .leftJoin(schedules, eq(schedules.id, actionTasks.verificationScheduleId))
      .orderBy(desc(actionTasks.createdAt));
    const members = await tx.select({ userId: memberships.userId, displayName: users.displayName, email: users.email, roleKey: memberships.roleKey, departmentKey: memberships.departmentKey }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).orderBy(users.displayName);
    const [performanceAgent] = await tx.select({ id: agentInstances.id, name: agentInstances.name, state: agentInstances.state }).from(agentInstances).where(sql`${agentInstances.serviceIdentity} like 'agent:performance-agent:%'`).limit(1);
    return {
      opportunities: oppRows.map((o) => ({
        id: o.id,
        title: o.title,
        description: o.description,
        intervention: o.intervention,
        state: o.state,
        requiresApproval: o.requiresApproval,
        approvalId: o.approvalId,
        approval: o.aState ? { state: o.aState, approverRole: o.aApproverRole!, risk: o.aRisk!, summary: o.aSummary!, decidedAt: o.aDecidedAt, decisionNote: o.aNote, requestedByActorId: o.aRequestedBy! } : null,
        priorityScore: o.priorityScore,
        businessCase: o.businessCase,
        sourceIds: o.sourceIds,
        findingTitles: o.findingIds.map((id) => findingTitles.get(id) ?? id.slice(0, 8)),
        createdAt: o.createdAt,
        taskCount: taskRows.filter((t) => t.opportunityId === o.id).length
      })),
      tasks: taskRows.map((t) => ({
        id: t.id,
        title: t.title,
        issue: t.issue,
        proposedAction: t.proposedAction,
        state: t.state,
        ownerRole: t.ownerRole,
        ownerUserId: t.ownerUserId,
        ownerName: t.ownerName,
        ownerEmail: t.ownerEmail,
        dueAt: t.dueAt,
        verificationNote: t.verificationNote,
        closedAt: t.closedAt,
        opportunityId: t.opportunityId,
        opportunityTitle: t.opportunityTitle,
        approvalId: t.approvalId,
        approvalState: t.approvalState,
        schedule: t.scheduleId ? { id: t.scheduleId, name: t.scheduleName!, cron: t.scheduleCron!, enabled: t.scheduleEnabled!, nextRunAt: t.scheduleNext, lastRunAt: t.scheduleLast } : null,
        createdAt: t.createdAt
      })),
      members,
      performanceAgent: performanceAgent ?? null
    };
  });
}
