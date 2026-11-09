import { desc, eq, sql } from "drizzle-orm";
import { schema, type TenantContext, type Tx } from "@sbos/db";
import { readFactsForAgent } from "@sbos/core";
import type { TenantSnapshot, ToolGateway } from "@sbos/agents";

const { departments, systems, questions, answers, findings, opportunities, kpis, kpiObservations, actionTasks, incidents } = schema;

/** Reads the authorised tenant context for an agent run. Facts go through the retrieval audit. */
export async function assembleSnapshot(tx: Tx, ctx: TenantContext, gateway: ToolGateway, tenant: TenantSnapshot["company"] & { id: string }, runId: string): Promise<TenantSnapshot> {
  gateway.authorize("systems.read");
  gateway.authorize("questions.read");
  gateway.authorize("vault.read");
  const deps = await tx.select({ key: departments.key, name: departments.name, headRole: departments.headRole }).from(departments);
  const sys = await tx.select({ name: systems.name, vendor: systems.vendor, function: systems.function, claimStatus: systems.claimStatus, apiCapabilities: systems.apiCapabilities, sourceOfTruthFor: systems.sourceOfTruthFor }).from(systems);
  const qs = await tx.select({ id: questions.id, department: questions.department, question_text: questions.questionText, state: questions.state }).from(questions).where(sql`${questions.state} <> 'superseded'`);
  const ans = await tx
    .select({ question_text: questions.questionText, answer_text: answers.answerText, department: questions.department, answered_by_role: answers.answeredByRole, fact_id: answers.factId, source_id: answers.sourceId })
    .from(answers)
    .innerJoin(questions, eq(questions.id, answers.questionId))
    .orderBy(desc(answers.answeredAt));
  const factRows = await readFactsForAgent(tx, ctx, { tenantId: tenant.id, runId, limit: 100 });
  const fnd = await tx.select({ id: findings.id, title: findings.title, department: findings.department, severity: findings.severity, claim: findings.claim, state: findings.state }).from(findings).orderBy(desc(findings.createdAt)).limit(50);
  const opp = await tx.select({ id: opportunities.id, title: opportunities.title, intervention: opportunities.intervention, state: opportunities.state }).from(opportunities).orderBy(desc(opportunities.createdAt)).limit(50);
  const kp = await tx.execute<{ id: string; key: string; name: string; unit: string; status: string; latest_status: string | null; latest_value: string | null; source_system: string }>(sql`
    SELECT k.id, k.key, k.name, k.unit, k.status::text AS status, k.source_system, o.status::text AS latest_status, o.value::text AS latest_value
    FROM ${kpis} k LEFT JOIN LATERAL (SELECT status, value FROM ${kpiObservations} WHERE kpi_id = k.id ORDER BY observed_at DESC LIMIT 1) o ON true
    WHERE k.tenant_id = ${tenant.id} AND k.status <> 'retired' ORDER BY k.name`);
  const tasks = await tx.select({ id: actionTasks.id, title: actionTasks.title, state: actionTasks.state, owner_role: actionTasks.ownerRole, due_at: actionTasks.dueAt }).from(actionTasks).orderBy(desc(actionTasks.createdAt)).limit(50);
  const [inc] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(incidents).where(sql`${incidents.tenantId} = ${tenant.id} AND ${incidents.state} = 'open'`);
  return {
    tenantId: tenant.id,
    company: { name: tenant.name, industry: tenant.industry, locale: tenant.locale, kind: tenant.kind },
    departments: deps,
    systems: sys.map((s) => ({ ...s, apiCapabilities: s.apiCapabilities as string[] })),
    questions: qs,
    answers: ans,
    facts: factRows.map((f) => ({ id: f.id, statement: f.statement, verification: f.verification, subject_key: f.subjectKey })),
    findings: fnd,
    opportunities: opp,
    kpis: kp.rows,
    actionTasks: tasks.map((t) => ({ ...t, due_at: t.due_at ? t.due_at.toISOString() : null })),
    openIncidents: inc?.n ?? 0
  };
}
