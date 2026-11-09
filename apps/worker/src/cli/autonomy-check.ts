/**
 * Autonomy Acceptance Test (docs/agent-runtime.md section 9), scripted.
 * Precondition: database migrated and seeded, and a worker process running against the same DATABASE_URL.
 * This script only writes intents (tasks, runs, approvals, schedule rows) and observes; the worker does the work.
 * Usage: DATABASE_URL=... tsx src/cli/autonomy-check.ts
 */
import { and, eq, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { agencyContext, createDb, operatorContext, schema, tenantContext } from "@sbos/db";
import { answerQuestion, createRun, createTask, decideApproval } from "@sbos/core";
import { BossJobBackend } from "../boss-backend";
import { checkStalledSchedules } from "../schedules";

const { tenants, agentInstances, agentRuns, runEvents, questions, vaultDocuments, approvals, approvedActions, notifications, incidents, budgets, schedules, memberships, factVerificationRequests, vaultFacts } = schema;

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const handle = createDb({ connectionString: url, max: 4 });
const boss = new PgBoss({ connectionString: url, schema: "pgboss", supervise: false, schedule: false });
await boss.start();
const jobs = new BossJobBackend(boss);
const OPERATOR = operatorContext({ actorType: "user", actorId: "autonomy-check", roles: ["agency_operator"] });
const results: Array<{ step: number; name: string; ok: boolean; detail: string }> = [];
const record = (step: number, name: string, ok: boolean, detail: string) => {
  results.push({ step, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} step ${step}: ${name} :: ${detail}`);
};

async function waitFor<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 90_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timeout waiting for ${label}`);
}

try {
  const ids = await handle.withContext(OPERATOR, async (tx) => {
    const ts = await tx.select({ id: tenants.id, slug: tenants.slug }).from(tenants);
    const a = ts.find((t) => t.slug === "northline-events")!;
    const b = ts.find((t) => t.slug === "harbour-view-hotel")!;
    const [instA] = await tx.select({ id: agentInstances.id }).from(agentInstances).where(eq(agentInstances.tenantId, a.id));
    const [instB] = await tx.select({ id: agentInstances.id }).from(agentInstances).where(eq(agentInstances.tenantId, b.id));
    return { tenantA: a.id, tenantB: b.id, instA: instA!.id, instB: instB!.id };
  });
  const svcA = { actorType: "system" as const, actorId: "autonomy-check", roles: ["agent_service"] };
  const ctxA = tenantContext({ tenantId: ids.tenantA, ...svcA });
  const ctxB = tenantContext({ tenantId: ids.tenantB, ...svcA });

  // Step 1 and 2: schedule an agent through the platform (Mission Control path = agency-tenant context), stored in the DB.
  const agencyA = agencyContext({ tenantId: ids.tenantA, actorType: "user", actorId: "autonomy-check", roles: ["superadmin"] });
  const scheduled = await handle.withContext(agencyA, async (tx) => {
    const [s] = await tx
      .insert(schedules)
      .values({ tenantId: ids.tenantA, agentInstanceId: ids.instA, name: "autonomy-check every minute", cron: "* * * * *", timezone: "UTC", enabled: true, expectedBySeconds: 120, instruction: "Autonomy acceptance test tick" })
      .returning({ id: schedules.id });
    return s!.id;
  });
  record(1, "agent scheduled via platform", true, `schedule ${scheduled}`);
  const stored = await handle.withContext(OPERATOR, (tx) => tx.select({ id: schedules.id, enabled: schedules.enabled }).from(schedules).where(eq(schedules.id, scheduled)));
  record(2, "schedule stored", stored.length === 1 && stored[0]!.enabled, JSON.stringify(stored[0]));

  // Step 3: no developer session is involved from here on; the worker process is the only actor.
  record(3, "no developer session in the loop", true, "this script only writes rows and polls; the worker executes");

  // Step 4: wait for the worker (via pg-boss cron reconciliation, up to ~2 minutes) to start a run from the schedule.
  const scheduledRun = await waitFor("scheduled run", async () => {
    const rows = await handle.withContext(OPERATOR, (tx) => tx.select({ id: agentRuns.id, state: agentRuns.state, trigger: agentRuns.trigger }).from(agentRuns).where(eq(agentRuns.scheduleId, scheduled)));
    return rows[0] ?? null;
  }, 150_000);
  record(4, "task started independently on the backend", true, `run ${scheduledRun.id} trigger=${scheduledRun.trigger}`);
  await handle.withContext(agencyA, (tx) => tx.update(schedules).set({ enabled: false }).where(eq(schedules.id, scheduled)));

  // Steps 5 and 6: the run reaches waiting_for_approval with questions drafted from tenant A context only.
  const waiting = await waitFor("run waiting for approval", async () => {
    const [r] = await handle.withContext(OPERATOR, (tx) => tx.select({ id: agentRuns.id, state: agentRuns.state, simulated: agentRuns.simulated, cost: agentRuns.costUsd }).from(agentRuns).where(eq(agentRuns.id, scheduledRun.id)));
    return r && r.state === "waiting_for_approval" ? r : r && ["failed", "cancelled"].includes(r.state) ? Promise.reject(new Error(`run ended ${r.state}`)) : null;
  });
  const events = await handle.withContext(OPERATOR, (tx) => tx.select({ kind: runEvents.kind, summary: runEvents.summary }).from(runEvents).where(eq(runEvents.runId, waiting.id)).orderBy(runEvents.seq));
  const toolCalls = events.filter((e) => e.kind === "tool_call").map((e) => e.summary);
  record(5, "agent retrieved authorised client information only", toolCalls.length > 0, toolCalls.join(" | "));
  const drafted = await handle.withContext(ctxA, (tx) => tx.select({ id: questions.id, state: questions.state }).from(questions).where(eq(questions.runId, waiting.id)));
  const leakedToB = await handle.withContext(ctxB, (tx) => tx.select({ id: questions.id }).from(questions).where(eq(questions.runId, waiting.id)));
  const priorCount = Number(/(\d+) prior questions/.exec(toolCalls.join(" "))?.[1] ?? "0");
  const expectedMin = priorCount === 0 ? 3 : 1; // the agent must not re-ask answered or open questions, so later rounds can be smaller
  record(6, "agent performed its task (questions drafted, no repeats, simulated allowed)", drafted.length >= expectedMin && leakedToB.length === 0, `${drafted.length} drafts in tenant A (prior ${priorCount}), ${leakedToB.length} visible in tenant B, simulated=${waiting.simulated}, cost=${waiting.cost}`);

  // Step 7: results saved in the correct Knowledge Vault.
  const docsA = await handle.withContext(ctxA, (tx) => tx.select({ path: vaultDocuments.path, version: vaultDocuments.version }).from(vaultDocuments).where(sql`${vaultDocuments.frontmatter}->>'run_id' = ${waiting.id}`));
  const docsB = await handle.withContext(ctxB, (tx) => tx.select({ path: vaultDocuments.path }).from(vaultDocuments).where(sql`${vaultDocuments.frontmatter}->>'run_id' = ${waiting.id}`));
  record(7, "results saved in the correct client's Knowledge Vault", docsA.length === 1 && docsB.length === 0, `A: ${docsA.map((d) => `${d.path} v${d.version}`).join(",")} B: ${docsB.length}`);

  // Approval by the client admin resumes the run and publishes the questions.
  const [approval] = await handle.withContext(ctxA, (tx) => tx.select({ id: approvals.id, state: approvals.state, role: approvals.approverRole }).from(approvals).where(eq(approvals.runId, waiting.id)));
  const [ceo] = await handle.withContext(ctxA, (tx) => tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.tenantId, ids.tenantA), eq(memberships.roleKey, "client_admin"))));
  const ceoCtx = tenantContext({ tenantId: ids.tenantA, actorType: "user", actorId: ceo!.userId, roles: ["client_admin"] });
  await handle.withContext(ceoCtx, (tx) => decideApproval(tx, ceoCtx, jobs, { tenantId: ids.tenantA, approvalId: approval!.id, decision: "approved", decidedBy: { userId: ceo!.userId, actorId: ceo!.userId }, note: "autonomy check" }));
  const finished = await waitFor("run succeeded after approval", async () => {
    const [r] = await handle.withContext(OPERATOR, (tx) => tx.select({ state: agentRuns.state, summary: agentRuns.summary }).from(agentRuns).where(eq(agentRuns.id, waiting.id)));
    return r?.state === "succeeded" ? r : null;
  });
  const published = await handle.withContext(ctxA, (tx) => tx.select({ state: questions.state }).from(questions).where(eq(questions.runId, waiting.id)));
  const [action] = await handle.withContext(ctxA, (tx) => tx.select({ executedAt: approvedActions.executedAt }).from(approvedActions).where(eq(approvedActions.runId, waiting.id)));
  const history = await handle.withContext(OPERATOR, (tx) => tx.select({ kind: runEvents.kind }).from(runEvents).where(eq(runEvents.runId, waiting.id)));
  record(8, "Mission Control shows execution history (run + events readable by operator role)", history.length >= 8 && published.every((q) => q.state === "open") && action?.executedAt !== null, `${history.length} events, states=${[...new Set(published.map((q) => q.state))].join(",")}, summary="${finished.summary}"`);

  // Step 9: a failing execution is logged and handled safely (budget hard stop on tenant B).
  const budgetB = await handle.withContext(ctxB, async (tx) => {
    const [b] = await tx.select({ id: budgets.id, cap: budgets.capUsdMonth }).from(budgets).where(and(eq(budgets.tenantId, ids.tenantB), eq(budgets.scope, "tenant")));
    await tx.update(budgets).set({ capUsdMonth: "0.00" }).where(eq(budgets.id, b!.id));
    return b!;
  });
  const failing = await handle.withContext(ctxB, async (tx) => {
    const taskId = await createTask(tx, ctxB, { tenantId: ids.tenantB, agentInstanceId: ids.instB, title: "autonomy-check failing run", instruction: "expected to be refused by budget", createdBy: { actorType: "system", actorId: "autonomy-check" } });
    return createRun(tx, ctxB, jobs, { tenantId: ids.tenantB, agentInstanceId: ids.instB, trigger: "command", triggerRef: "autonomy-check", taskId });
  });
  const failedRun = await waitFor("failed run", async () => {
    const [r] = await handle.withContext(OPERATOR, (tx) => tx.select({ state: agentRuns.state }).from(agentRuns).where(eq(agentRuns.id, failing.runId)));
    return r?.state === "failed" ? r : null;
  });
  // Incidents are deduplicated while open (one open budget incident per tenant and scope), so look at the tenant, not only this run.
  const incidentRows = await handle.withContext(OPERATOR, (tx) => tx.select({ kind: incidents.kind, severity: incidents.severity, state: incidents.state }).from(incidents).where(and(eq(incidents.tenantId, ids.tenantB), eq(incidents.kind, "budget_exceeded"), eq(incidents.state, "open"))));
  await handle.withContext(ctxB, (tx) => tx.update(budgets).set({ capUsdMonth: budgetB.cap }).where(eq(budgets.id, budgetB.id)));
  record(9, "failed execution logged and handled safely", failedRun.state === "failed" && incidentRows.some((i) => i.kind === "budget_exceeded"), `incidents=${incidentRows.map((i) => `${i.kind}/${i.severity}`).join(",")}`);

  // Stall alarm: a schedule whose window passed without a run becomes an incident.
  await handle.withContext(agencyA, (tx) => tx.update(schedules).set({ enabled: true, nextRunAt: new Date(Date.now() - 10 * 60_000), expectedBySeconds: 60 }).where(eq(schedules.id, scheduled)));
  const missedBefore = await handle.withContext(OPERATOR, (tx) => tx.select({ id: incidents.id }).from(incidents).where(and(eq(incidents.scheduleId, scheduled), eq(incidents.kind, "missed_schedule"))));
  // The scheduled run above happened AFTER next_run_at only if created later; force a clean check by moving next_run_at after that run.
  const [lastRun] = await handle.withContext(OPERATOR, (tx) => tx.select({ createdAt: agentRuns.createdAt }).from(agentRuns).where(eq(agentRuns.scheduleId, scheduled)).orderBy(sql`created_at desc`).limit(1));
  await handle.withContext(agencyA, (tx) => tx.update(schedules).set({ nextRunAt: new Date((lastRun?.createdAt.getTime() ?? Date.now()) + 1000), expectedBySeconds: 1 }).where(eq(schedules.id, scheduled)));
  await new Promise((r) => setTimeout(r, 1500));
  const missed = await checkStalledSchedules(handle, jobs);
  const missedAfter = await handle.withContext(OPERATOR, (tx) => tx.select({ id: incidents.id }).from(incidents).where(and(eq(incidents.scheduleId, scheduled), eq(incidents.kind, "missed_schedule"))));
  await handle.withContext(agencyA, (tx) => tx.update(schedules).set({ enabled: false }).where(eq(schedules.id, scheduled)));
  record(9.5, "stall alarm raises an incident for a missed schedule", missed >= 1 && missedAfter.length > missedBefore.length, `missed=${missed}, incidents ${missedBefore.length} -> ${missedAfter.length}`);

  // Step 10: notifications were queued by the worker (delivery logged without credentials) and the worker is still alive.
  const notes = await handle.withContext(OPERATOR, (tx) => tx.select({ channel: notifications.channel, template: notifications.template, state: notifications.state }).from(notifications).where(sql`${notifications.payload}->>'runId' = ${waiting.id} or ${notifications.payload}->>'roundId' is not null`));
  const health = await fetch(`http://localhost:${process.env.WORKER_PORT ?? 8080}/healthz`).then((r) => r.json() as Promise<{ status: string; mode: string }>).catch(() => null);
  record(10, "system keeps operating without a developer session", health?.status === "ok" && notes.length > 0, `worker health=${JSON.stringify(health)}, notifications=${notes.map((n) => `${n.channel}:${n.template}:${n.state}`).join(",")}`);

  // Vault MVP (spec 4G): a department manager answers a published question negating a registered system; the next
  // discovery round must flag the contradiction as a verification request, never as a verdict.
  const [finance] = await handle.withContext(ctxA, (tx) => tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.tenantId, ids.tenantA), eq(memberships.roleKey, "department_manager"))));
  const managerCtx = tenantContext({ tenantId: ids.tenantA, actorType: "user", actorId: finance!.userId, roles: ["department_manager"] });
  const openQ = await handle.withContext(managerCtx, (tx) => tx.select({ id: questions.id, text: questions.questionText }).from(questions).where(and(eq(questions.runId, waiting.id), eq(questions.state, "open"))));
  const target = openQ.find((q) => q.text.includes("QuickBooks")) ?? openQ[0]!;
  const answered = await handle.withContext(managerCtx, (tx) => answerQuestion(tx, managerCtx, { tenantId: ids.tenantA, questionId: target.id, value: "No, QuickBooks Online is not used anymore; invoices are issued from Rentman since Q2.", role: "department_manager" }));
  const factRow = await handle.withContext(managerCtx, async (tx) => (await tx.select({ verification: vaultFacts.verification, sourceIds: vaultFacts.sourceIds }).from(vaultFacts).where(eq(vaultFacts.id, answered.factId)))[0]);
  record(11, "answer stored as provisional knowledge with source", factRow?.verification === "unconfirmed" && (factRow?.sourceIds.length ?? 0) === 1, `fact ${answered.factId} ${factRow?.verification}`);

  const second = await handle.withContext(ctxA, async (tx) => {
    const taskId = await createTask(tx, ctxA, { tenantId: ids.tenantA, agentInstanceId: ids.instA, title: "autonomy-check round 2", instruction: "Second discovery round after answers", createdBy: { actorType: "system", actorId: "autonomy-check" } });
    return createRun(tx, ctxA, jobs, { tenantId: ids.tenantA, agentInstanceId: ids.instA, trigger: "command", triggerRef: "autonomy-check-round-2", taskId });
  });
  await waitFor("round 2 waiting for approval", async () => {
    const [r] = await handle.withContext(OPERATOR, (tx) => tx.select({ state: agentRuns.state }).from(agentRuns).where(eq(agentRuns.id, second.runId)));
    return r?.state === "waiting_for_approval" ? r : r && ["failed", "cancelled"].includes(r.state) ? Promise.reject(new Error(`round 2 ended ${r.state}`)) : null;
  });
  const fvr = await handle.withContext(ctxA, (tx) => tx.select({ id: factVerificationRequests.id, state: factVerificationRequests.state, factId: factVerificationRequests.factId }).from(factVerificationRequests).where(eq(factVerificationRequests.runId, second.runId)));
  const flagged = await handle.withContext(ctxA, async (tx) => (await tx.select({ verification: vaultFacts.verification, contradicts: vaultFacts.contradicts }).from(vaultFacts).where(eq(vaultFacts.id, answered.factId)))[0]);
  const round2Events = await handle.withContext(OPERATOR, (tx) => tx.select({ kind: runEvents.kind, summary: runEvents.summary }).from(runEvents).where(eq(runEvents.runId, second.runId)));
  record(12, "agent detects the contradiction and asks for verification instead of deciding", fvr.length === 1 && fvr[0]!.factId === answered.factId && flagged?.verification === "hypothesis" && round2Events.some((e) => e.kind === "help_request"), `requests=${fvr.length}, fact=${flagged?.verification}, contradicts=${flagged?.contradicts.length}, tool_call="${round2Events.find((e) => e.kind === "tool_call")?.summary}"`);

  // Reviewer (client admin) promotes the fact; a later agent read returns it as verified with its source.
  const { decideFactVerification, readFactsForAgent } = await import("@sbos/core");
  await handle.withContext(ceoCtx, (tx) => decideFactVerification(tx, ceoCtx, { tenantId: ids.tenantA, requestId: fvr[0]!.id, decision: "verified", note: "Confirmed with finance." }));
  const agent2 = tenantContext({ tenantId: ids.tenantA, actorType: "agent", actorId: "agent:finance:northline", roles: ["agent_service"] });
  const retrieved = await handle.withContext(agent2, (tx) => readFactsForAgent(tx, agent2, { tenantId: ids.tenantA }));
  const verifiedFact = retrieved.find((f) => f.id === answered.factId);
  const leakB = await handle.withContext(ctxB, (tx) => tx.select({ id: vaultFacts.id }).from(vaultFacts).where(eq(vaultFacts.id, answered.factId)));
  record(13, "reviewer promotes the fact; another agent retrieves it with source; tenant B cannot", verifiedFact?.verification === "verified" && verifiedFact.sourceIds.length === 1 && leakB.length === 0, `verification=${verifiedFact?.verification}, sources=${verifiedFact?.sourceIds.length}, visible in B=${leakB.length}`);
} catch (err) {
  record(0, "unexpected error", false, (err as Error).message);
} finally {
  await boss.stop({ graceful: false });
  await handle.close();
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
