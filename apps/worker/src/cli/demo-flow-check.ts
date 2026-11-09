/**
 * Spec 11 demo flow, scripted against a running worker (Milestone 3).
 * consultant creates client (seed) -> CEO answers intake -> departments and applications known -> Finance and Operations
 * ask follow-up questions -> agent delivers an evidence-based pain point and a proposed workflow -> CEO approves ->
 * task owner receives it -> scheduled check verifies -> CEO dashboard reflects the change with source, timestamp, status.
 * Usage: DATABASE_URL=... WORKER_PORT=8081 tsx src/cli/demo-flow-check.ts  (after autonomy-check has published round 1 and answered a question)
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { agencyContext, createDb, operatorContext, schema, tenantContext } from "@sbos/db";
import { activateActionTask, advancePhase, answerQuestion, createActionTask, createRun, createTask, currentDashboard, decideApproval, grantConsent, latestObservations, proposeConnection, recordSecurityReview, setOpportunityState } from "@sbos/core";
import { BossJobBackend } from "../boss-backend";

const { tenants, agentInstances, agentRuns, questions, approvals, findings, opportunities, actionTasks, kpis, briefings, memberships, vaultDocuments, runEvents, schedules, knowledgePromotionRequests, agencyKnowledgeRecords, connections, syncRuns, kpiObservations, systems } = schema;
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const handle = createDb({ connectionString: url, max: 4 });
const boss = new PgBoss({ connectionString: url, schema: "pgboss", supervise: false, schedule: false });
await boss.start();
const jobs = new BossJobBackend(boss);
const OPERATOR = operatorContext({ actorType: "user", actorId: "demo-flow", roles: ["agency_operator"] });
const results: Array<{ step: number; name: string; ok: boolean; detail: string }> = [];
const record = (step: number, name: string, ok: boolean, detail: string) => { results.push({ step, name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} step ${step}: ${name} :: ${detail}`); };
async function waitFor<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 120_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 1500)); }
  throw new Error(`timeout waiting for ${label}`);
}
async function runAgent(tenantId: string, instanceId: string, title: string, instruction: string): Promise<string> {
  const ctx = tenantContext({ tenantId, actorType: "system", actorId: "demo-flow", roles: ["agent_service"] });
  const { runId } = await handle.withContext(ctx, async (tx) => {
    const taskId = await createTask(tx, ctx, { tenantId, agentInstanceId: instanceId, title, instruction, createdBy: { actorType: "system", actorId: "demo-flow" } });
    return createRun(tx, ctx, jobs, { tenantId, agentInstanceId: instanceId, trigger: "command", triggerRef: "demo-flow", taskId });
  });
  return runId;
}
async function runState(runId: string) {
  const [r] = await handle.withContext(OPERATOR, (tx) => tx.select({ state: agentRuns.state, summary: agentRuns.summary }).from(agentRuns).where(eq(agentRuns.id, runId)));
  return r ?? null;
}
async function waitSettled(runId: string, accept: string[]) {
  return waitFor(`run ${runId} in ${accept.join("/")}`, async () => {
    const r = await runState(runId);
    if (!r) return null;
    if (accept.includes(r.state)) return r;
    if (["failed", "cancelled", "timed_out"].includes(r.state)) throw new Error(`run ${runId} ended ${r.state}: ${r.summary}`);
    return null;
  });
}

try {
  const t = await handle.withContext(OPERATOR, async (tx) => {
    const [a] = await tx.select({ id: tenants.id, slug: tenants.slug }).from(tenants).where(eq(tenants.slug, "northline-events"));
    const inst = await tx.select({ id: agentInstances.id, identity: agentInstances.serviceIdentity }).from(agentInstances).where(eq(agentInstances.tenantId, a!.id));
    const byKey = (k: string) => inst.find((i) => i.identity.startsWith(`agent:${k}:`))?.id;
    return { tenantId: a!.id, slug: a!.slug, finance: byKey("finance-agent")!, ops: byKey("operations-agent")!, redesign: byKey("process-redesign")!, ceo: byKey("ceo-intelligence")!, briefing: byKey("executive-briefing")!, perf: byKey("performance-agent")! };
  });
  const [ceoUser] = await handle.withContext(tenantContext({ tenantId: t.tenantId, actorType: "system", actorId: "demo-flow", roles: ["agent_service"] }), (tx) => tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.tenantId, t.tenantId), eq(memberships.roleKey, "client_admin"))));
  const ceoCtx = tenantContext({ tenantId: t.tenantId, actorType: "user", actorId: ceoUser!.userId, roles: ["client_admin"] });
  const [mgr] = await handle.withContext(ceoCtx, (tx) => tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.tenantId, t.tenantId), eq(memberships.roleKey, "department_manager"))));
  const mgrCtx = tenantContext({ tenantId: t.tenantId, actorType: "user", actorId: mgr!.userId, roles: ["department_manager"] });

  // Precondition: at least one answered question exists (autonomy-check leaves one). Answer two more as the CEO so finance and ops have material.
  const open = await handle.withContext(ceoCtx, (tx) => tx.select({ id: questions.id, text: questions.questionText, dept: questions.department }).from(questions).where(eq(questions.state, "open")).limit(10));
  for (const q of open.slice(0, 2)) {
    await handle.withContext(ceoCtx, (tx) => answerQuestion(tx, ceoCtx, { tenantId: t.tenantId, questionId: q.id, value: q.dept === "finance" || /invoice|payment|QuickBooks/i.test(q.text) ? "Invoices are typed over from the project system after the warehouse confirms the return by chat; this takes about a week and extra costs are often missed." : "Crew and equipment are planned in the project system; returns are checked manually and conflicts are found on the day itself.", role: "client_admin" }));
  }
  const answered = await handle.withContext(ceoCtx, (tx) => tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(questions).where(eq(questions.state, "answered")));
  record(1, "CEO answered intake questions; departments and applications are known", (answered[0]?.n ?? 0) >= 2, `${answered[0]?.n} answered questions`);

  // Finance and Operations agents: each asks follow-up questions and records findings; questions wait for publication approval.
  const finRun = await runAgent(t.tenantId, t.finance, "Finance review", "Review finance after intake answers");
  const opsRun = await runAgent(t.tenantId, t.ops, "Operations review", "Review operations after intake answers");
  const finState = await waitSettled(finRun, ["waiting_for_approval", "succeeded"]);
  const opsState = await waitSettled(opsRun, ["waiting_for_approval", "succeeded"]);
  const fnd = await handle.withContext(ceoCtx, (tx) => tx.select({ id: findings.id, dept: findings.department, claim: findings.claim, title: findings.title }).from(findings));
  record(2, "Finance and Operations agents produced findings with claim types and follow-up questions", fnd.length >= 1 && fnd.every((f) => f.claim !== "data_observation"), `${fnd.length} findings (${fnd.map((f) => `${f.dept}:${f.claim}`).join(", ")}); runs ${finState.state}/${opsState.state}`);
  for (const runId of [finRun, opsRun]) {
    const [appr] = await handle.withContext(ceoCtx, (tx) => tx.select({ id: approvals.id, state: approvals.state }).from(approvals).where(and(eq(approvals.runId, runId), eq(approvals.state, "pending"))));
    if (appr) await handle.withContext(ceoCtx, (tx) => decideApproval(tx, ceoCtx, jobs, { tenantId: t.tenantId, approvalId: appr.id, decision: "approved", decidedBy: { userId: ceoUser!.userId, actorId: ceoUser!.userId } }));
  }
  await waitSettled(finRun, ["succeeded"]);
  await waitSettled(opsRun, ["succeeded"]);
  const deptQuestions = await handle.withContext(ceoCtx, (tx) => tx.select({ id: questions.id, dept: questions.department }).from(questions).where(and(eq(questions.state, "open"), sql`${questions.department} in ('finance','operations')`)));
  record(3, "Follow-up questions published after CEO approval", deptQuestions.length >= 2, `${deptQuestions.length} open department questions`);

  // Process redesign: evidence-based pain point and proposed workflow, waiting for CEO approval.
  const rdRun = await runAgent(t.tenantId, t.redesign, "Process redesign", "Redesign the highest-impact process from the findings");
  await waitSettled(rdRun, ["succeeded"]);
  const [opp] = await handle.withContext(ceoCtx, (tx) => tx.select().from(opportunities).orderBy(desc(opportunities.createdAt)).limit(1));
  const procs = await handle.withContext(ceoCtx, (tx) => tx.select({ variant: schema.processes.variant, key: schema.processes.key }).from(schema.processes));
  record(4, "Agent delivered a pain point (AS-IS), a proposed workflow (TO-BE) and an opportunity with labelled business case", !!opp && opp.state === "proposed" && procs.some((p) => p.variant === "as_is") && procs.some((p) => p.variant === "to_be"), `opportunity "${opp?.title}" (${opp?.intervention}); processes ${procs.map((p) => `${p.key}/${p.variant}`).join(", ")}`);

  // Approval gate: state cannot advance before the CEO decides; then the action task goes to its owner with a verification schedule.
  let blocked = false;
  try { await handle.withContext(ceoCtx, (tx) => setOpportunityState(tx, ceoCtx, { tenantId: t.tenantId, opportunityId: opp!.id, state: "approved" })); } catch { blocked = true; }
  await handle.withContext(ceoCtx, (tx) => decideApproval(tx, ceoCtx, jobs, { tenantId: t.tenantId, approvalId: opp!.approvalId!, decision: "approved", decidedBy: { userId: ceoUser!.userId, actorId: ceoUser!.userId }, note: "Go ahead with the closure check" }));
  await handle.withContext(ceoCtx, (tx) => setOpportunityState(tx, ceoCtx, { tenantId: t.tenantId, opportunityId: opp!.id, state: "approved" }));
  const { taskId } = await handle.withContext(ceoCtx, (tx) => createActionTask(tx, ceoCtx, { tenantId: t.tenantId, title: `Implement: ${opp!.title}`, issue: "Late invoicing after project closure", proposedAction: "Warehouse confirms returns in the project system; finance invoices within two working days", opportunityId: opp!.id, ownerRole: "department_manager", sourceIds: opp!.sourceIds, approvalId: opp!.approvalId }));
  const act = await handle.withContext(ceoCtx, (tx) => activateActionTask(tx, ceoCtx, jobs, { tenantId: t.tenantId, taskId, ownerUserId: mgr!.userId, verifyAfterDays: 7, verificationAgentInstanceId: t.perf }));
  const [task] = await handle.withContext(mgrCtx, (tx) => tx.select({ state: actionTasks.state, owner: actionTasks.ownerUserId }).from(actionTasks).where(eq(actionTasks.id, taskId)));
  record(5, "CEO approved; risky state change was blocked before approval; task owner received the task with a verification schedule", blocked && task?.state === "assigned" && task.owner === mgr!.userId && !!act.scheduleId, `blocked before approval=${blocked}, task state=${task?.state}, schedule=${act.scheduleId}`);

  // Scheduled check verifies the outcome: run the performance agent now with the schedule's instruction.
  const [sched] = await handle.withContext(ceoCtx, (tx) => tx.select({ instruction: schedules.instruction }).from(schedules).where(eq(schedules.id, act.scheduleId!)));
  const perfRun = await runAgent(t.tenantId, t.perf, "Verify action", sched!.instruction ?? `Verify whether action task ${taskId} was carried out.`);
  const perfState = await waitSettled(perfRun, ["waiting_for_approval", "succeeded"]);
  const [taskAfter] = await handle.withContext(mgrCtx, (tx) => tx.select({ state: actionTasks.state, note: actionTasks.verificationNote }).from(actionTasks).where(eq(actionTasks.id, taskId)));
  const perfEvents = await handle.withContext(OPERATOR, (tx) => tx.select({ kind: runEvents.kind, summary: runEvents.summary }).from(runEvents).where(eq(runEvents.runId, perfRun)));
  record(6, "Verification run did not assume completion: task set to verifying and a question for the owner awaits publication", taskAfter?.state === "verifying" && perfState.state === "waiting_for_approval", `task=${taskAfter?.state}, run=${perfState.state}, events=${perfEvents.map((e) => e.kind).join(",")}`);

  // CEO Intelligence: KPI registry and dashboard with missing-data states; briefing with eight sections.
  const ceoRun = await runAgent(t.tenantId, t.ceo, "CEO intelligence", "Define KPIs and the CEO dashboard");
  await waitSettled(ceoRun, ["succeeded"]);
  const obs = await handle.withContext(ceoCtx, (tx) => latestObservations(tx, t.tenantId));
  const dash = await handle.withContext(ceoCtx, (tx) => currentDashboard(tx, t.tenantId, "ceo"));
  const spec = dash?.specification as { widgets: Array<{ type: string }> } | undefined;
  const missing = obs.rows.filter((r) => r.status !== "ok");
  const okRows = obs.rows.filter((r) => r.status === "ok");
  record(7, "KPI registry defined with sources; external KPIs show Missing data, never invented numbers; dashboard spec validated", obs.rows.length >= 3 && missing.every((r) => r.value === null) && okRows.length >= 1 && !!spec && spec.widgets.some((w) => w.type === "data_gap_list"), `${obs.rows.length} KPIs, ${missing.length} missing data, ${okRows.length} ok (${okRows.map((r) => `${r.key}=${r.value}`).join(",")}), widgets ${spec?.widgets.map((w) => w.type).join("/")}`);

  const brRun = await runAgent(t.tenantId, t.briefing, "Executive briefing", "Daily briefing");
  await waitSettled(brRun, ["succeeded"]);
  const [br] = await handle.withContext(ceoCtx, (tx) => tx.select({ content: briefings.content, simulated: briefings.simulated }).from(briefings).orderBy(desc(briefings.createdAt)).limit(1));
  const content = br?.content as { sections: Record<string, unknown[]>; top_priorities: string[] } | undefined;
  const docs = await handle.withContext(ceoCtx, (tx) => tx.select({ path: vaultDocuments.path }).from(vaultDocuments).where(sql`${vaultDocuments.path} like '12_kpis_and_reports/%' or ${vaultDocuments.path} like '04_processes_as_is/%' or ${vaultDocuments.path} like '05_processes_to_be/%' or ${vaultDocuments.path} like '14_findings_and_evidence/%'`));
  record(8, "Executive briefing with exactly eight sections and 5 to 7 priorities; vault holds processes, findings, KPI registry and briefing", !!content && Object.keys(content.sections).length === 8 && content.top_priorities.length >= 5 && content.top_priorities.length <= 7 && docs.length >= 4, `sections=${content ? Object.keys(content.sections).length : 0}, priorities=${content?.top_priorities.length}, simulated=${br?.simulated}, vault docs: ${docs.map((d) => d.path).join(", ")}`);

  // Tenant B isolation across everything created here.
  const [tb] = await handle.withContext(OPERATOR, (tx) => tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, "harbour-view-hotel")));
  const ctxB = tenantContext({ tenantId: tb!.id, actorType: "user", actorId: "ceo-b", roles: ["client_admin"] });
  const leaks = await handle.withContext(ctxB, async (tx) => ({ f: (await tx.select().from(findings)).length, o: (await tx.select().from(opportunities)).length, k: (await tx.select().from(kpis)).length, b: (await tx.select().from(briefings)).length, a: (await tx.select().from(actionTasks)).length }));
  record(9, "Tenant B sees none of tenant A's findings, opportunities, KPIs, briefings or tasks", Object.values(leaks).every((n) => n === 0), JSON.stringify(leaks));

  // Spec 4H: the redesign agent nominated a reusable insight; it waits for a human reviewer and nothing reached the agency vault.
  const nominations = await handle.withContext(ceoCtx, (tx) => tx.select({ id: knowledgePromotionRequests.id, state: knowledgePromotionRequests.state, risk: knowledgePromotionRequests.identifiabilityRisk }).from(knowledgePromotionRequests));
  const agencyCtx = agencyContext({ tenantId: null, actorType: "user", actorId: "reviewer", roles: ["agency_reviewer"] });
  const abstracted = await handle.withContext(agencyCtx, (tx) => tx.select({ id: agencyKnowledgeRecords.id }).from(agencyKnowledgeRecords).where(eq(agencyKnowledgeRecords.origin, "abstracted_from_client")));
  const leakB = await handle.withContext(ctxB, (tx) => tx.select({ id: knowledgePromotionRequests.id }).from(knowledgePromotionRequests));
  record(10, "Agent nominated a reusable insight; it is only a nomination (state nominated), no agency record exists, tenant B cannot see it", nominations.length >= 1 && nominations.every((n) => n.state === "nominated") && abstracted.length === 0 && leakB.length === 0, `nominations=${nominations.map((n) => `${n.state}/${n.risk}`).join(",")}, abstracted records=${abstracted.length}, visible to tenant B=${leakB.length}`);

  // Spec ADR-011 / M5: a connection runs through metadata -> consent -> security review -> read_only; the worker's
  // connector.sync job writes observations with lineage from sandbox fixtures, nothing leaves the platform.
  const [rentman] = await handle.withContext(ceoCtx, (tx) => tx.select({ id: systems.id }).from(systems).where(eq(systems.name, "Rentman")));
  const connectionId = await handle.withContext(ceoCtx, (tx) => proposeConnection(tx, ceoCtx, { tenantId: t.tenantId, provider: "rentman", systemId: rentman?.id ?? null, syncIntervalMinutes: 30, reason: "demo flow: closed projects not invoiced" }));
  await jobs.enqueue("connector.sync", { tenantId: t.tenantId, connectionId, trigger: "manual" as const });
  const skipped = await waitFor("metadata sync skipped", () => handle.withContext(ceoCtx, async (tx) => (await tx.select().from(syncRuns).where(and(eq(syncRuns.connectionId, connectionId), eq(syncRuns.status, "skipped"))))[0] ?? null));
  await handle.withContext(ceoCtx, (tx) => grantConsent(tx, ceoCtx, { tenantId: t.tenantId, connectionId, scopes: ["projects:read", "invoices:read"], reason: "demo flow: CEO consent, read-only, no amounts", userId: ceoUser!.userId }));
  const reviewerCtx = agencyContext({ tenantId: t.tenantId, actorType: "user", actorId: "demo-reviewer", roles: ["agency_reviewer"] });
  await handle.withContext(reviewerCtx, (tx) => recordSecurityReview(tx, reviewerCtx, { tenantId: t.tenantId, connectionId, outcome: "approved", note: "demo flow: scopes limited to status and dates" }));
  await handle.withContext(reviewerCtx, (tx) => advancePhase(tx, reviewerCtx, { tenantId: t.tenantId, connectionId, to: "read_only", reason: "demo flow: sandbox fixtures" }));
  await jobs.enqueue("connector.sync", { tenantId: t.tenantId, connectionId, trigger: "manual" as const });
  const synced = await waitFor("sandbox sync succeeded", () => handle.withContext(ceoCtx, async (tx) => (await tx.select().from(syncRuns).where(and(eq(syncRuns.connectionId, connectionId), eq(syncRuns.status, "succeeded"))))[0] ?? null));
  const lineage = await handle.withContext(ceoCtx, (tx) => tx.select({ status: kpiObservations.status, lineage: kpiObservations.lineage }).from(kpiObservations).where(eq(kpiObservations.syncRunId, synced.id)));
  const connRow = await handle.withContext(ceoCtx, async (tx) => (await tx.select({ phase: connections.phase, status: connections.status, lastSyncAt: connections.lastSyncAt }).from(connections).where(eq(connections.id, connectionId)))[0]!);
  const leakConn = await handle.withContext(ctxB, (tx) => tx.select({ id: syncRuns.id }).from(syncRuns));
  record(11, "Connection phases: metadata sync skipped without network; after CEO consent, security review and read_only the worker wrote sandbox observations with lineage; tenant B sees nothing", (skipped.details as { networkCalls?: number }).networkCalls === 0 && synced.mode === "sandbox" && lineage.length >= 2 && lineage.every((l) => (l.lineage as { query_or_formula?: string }).query_or_formula?.includes("Rentman.")) && connRow.phase === "read_only" && connRow.status === "active" && !!connRow.lastSyncAt && leakConn.length === 0, `skipped run networkCalls=${(skipped.details as { networkCalls?: number }).networkCalls}, synced mode=${synced.mode}, observations=${lineage.map((l) => l.status).join(",")}, phase=${connRow.phase}/${connRow.status}, tenant B sync runs=${leakConn.length}`);
} catch (err) {
  record(0, "unexpected error", false, (err as Error).message);
} finally {
  await boss.stop({ graceful: false });
  await handle.close();
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
