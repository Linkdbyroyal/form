/**
 * Venture Lab smoke test (ADR-025). Precondition: database migrated and seeded (or the worker has run once, which
 * ensures the agency catalogue), and a worker process running against the same DATABASE_URL.
 * This script only writes one intent (a task and a run for the Venture Lab orchestrator) and observes; the worker
 * delegates, analyses and synthesises. Usage: DATABASE_URL=... tsx src/cli/venture-lab-check.ts [focus text]
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { createDb, operatorContext, schema, tenantContext } from "@sbos/db";
import { createRun, createTask } from "@sbos/core";
import { BossJobBackend } from "../boss-backend";

const { tenants, agentInstances, agentDefinitions, agentRuns, runEvents, approvals, opportunities, vaultDocuments, notifications, agentTasks } = schema;

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const focus = process.argv.slice(2).join(" ").trim() || "Smoke test: service lines and productised offers the agency could launch for SMEs in the next twelve months.";
const handle = createDb({ connectionString: url, max: 4 });
const boss = new PgBoss({ connectionString: url, schema: "pgboss", supervise: false, schedule: false });
await boss.start();
const jobs = new BossJobBackend(boss);
const OPERATOR = operatorContext({ actorType: "user", actorId: "venture-lab-check", roles: ["agency_operator"] });
const results: Array<{ step: number; name: string; ok: boolean; detail: string }> = [];
const record = (step: number, name: string, ok: boolean, detail: string) => {
  results.push({ step, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} step ${step}: ${name} :: ${detail}`);
};
async function waitFor<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 180_000): Promise<T> {
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
    const [agency] = await tx.select({ id: tenants.id, slug: tenants.slug }).from(tenants).where(sql`${tenants.kind} = 'agency'`);
    if (!agency) throw new Error("no agency tenant in this database");
    const [lab] = await tx.select({ id: agentInstances.id }).from(agentInstances).innerJoin(agentDefinitions, eq(agentDefinitions.id, agentInstances.definitionId)).where(and(eq(agentInstances.tenantId, agency.id), eq(agentDefinitions.key, "venture-lab")));
    const analysts = await tx.select({ id: agentInstances.id }).from(agentInstances).innerJoin(agentDefinitions, eq(agentDefinitions.id, agentInstances.definitionId)).where(and(eq(agentInstances.tenantId, agency.id), eq(agentDefinitions.key, "venture-analyst")));
    if (!lab) throw new Error("no Venture Lab instance in the agency tenant (start the worker once, or re-seed)");
    return { agency: agency.id, slug: agency.slug, lab: lab.id, analysts: analysts.length };
  });
  record(1, "venture lab catalogue present", ids.analysts > 0, `orchestrator ${ids.lab.slice(0, 8)}, ${ids.analysts} analyst instance(s)`);

  const ctx = tenantContext({ tenantId: ids.agency, actorType: "system", actorId: "venture-lab-check", roles: ["agent_service"] });
  const started = await handle.withContext(ctx, async (tx) => {
    const taskId = await createTask(tx, ctx, { tenantId: ids.agency, agentInstanceId: ids.lab, title: "Venture Lab smoke test", instruction: focus, priority: "medium", createdBy: { actorType: "system", actorId: "venture-lab-check" } });
    return createRun(tx, ctx, jobs, { tenantId: ids.agency, agentInstanceId: ids.lab, trigger: "command", triggerRef: "venture-lab-check", taskId });
  });
  record(2, "orchestrator run queued", true, `run ${started.runId}`);

  const children = await waitFor("delegated child runs", async () => {
    const rows = await handle.withContext(OPERATOR, (tx) => tx.select({ id: agentRuns.id, state: agentRuns.state, agentInstanceId: agentRuns.agentInstanceId, tenantId: agentRuns.tenantId }).from(agentRuns).where(eq(agentRuns.parentRunId, started.runId)));
    return rows.length > 0 ? rows : null;
  });
  record(3, "child runs carry parent_run_id", children.every((c) => c.tenantId === ids.agency), `${children.length} child run(s) on ${new Set(children.map((c) => c.agentInstanceId)).size} analyst instance(s)`);

  const waiting = await waitFor("parent waiting or finished", async () => {
    const [r] = await handle.withContext(OPERATOR, (tx) => tx.select({ state: agentRuns.state }).from(agentRuns).where(eq(agentRuns.id, started.runId)));
    return r && ["waiting_for_input", "succeeded", "failed"].includes(r.state) ? r : null;
  });
  const sawWaiting = await handle.withContext(OPERATOR, (tx) => tx.select({ id: runEvents.id }).from(runEvents).where(and(eq(runEvents.runId, started.runId), eq(runEvents.kind, "state_change"), sql`${runEvents.summary} like 'waiting for % delegated run(s)'`)));
  record(4, "parent suspended while analysts work", sawWaiting.length > 0 || waiting.state === "succeeded", `parent state now ${waiting.state}; waiting events: ${sawWaiting.length}`);

  const parent = await waitFor("parent terminal", async () => {
    const [r] = await handle.withContext(OPERATOR, (tx) => tx.select({ state: agentRuns.state, summary: agentRuns.summary, costUsd: agentRuns.costUsd, simulated: agentRuns.simulated }).from(agentRuns).where(eq(agentRuns.id, started.runId)));
    return r && ["succeeded", "failed", "cancelled"].includes(r.state) ? r : null;
  }, 300_000);
  const childStates = await handle.withContext(OPERATOR, (tx) => tx.select({ state: agentRuns.state }).from(agentRuns).where(eq(agentRuns.parentRunId, started.runId)));
  record(5, "parent woken by the last child and finished", parent.state === "succeeded" && childStates.every((c) => c.state === "succeeded"), `parent ${parent.state} (${parent.simulated ? "simulated" : "live"}, cost ${parent.costUsd}); children: ${childStates.map((c) => c.state).join(", ")}; summary: ${parent.summary ?? ""}`);

  const wake = await handle.withContext(OPERATOR, (tx) => tx.select({ summary: runEvents.summary }).from(runEvents).where(and(eq(runEvents.runId, started.runId), sql`${runEvents.summary} like 'delegated run % finished%'`)));
  record(6, "every child completion left a note on the parent", wake.length === children.length, `${wake.length} note(s)`);

  const agencyCtx = tenantContext({ tenantId: ids.agency, actorType: "system", actorId: "venture-lab-check", roles: ["superadmin"] });
  const outcome = await handle.withContext(agencyCtx, async (tx) => {
    const opps = await tx.select({ id: opportunities.id, title: opportunities.title, state: opportunities.state, approvalId: opportunities.approvalId }).from(opportunities).where(sql`${opportunities.businessCase} ->> 'lab_run_id' = ${started.runId}`);
    const apps = opps.length > 0 ? await tx.select({ state: approvals.state, approverRole: approvals.approverRole }).from(approvals).where(sql`${approvals.id} in (select approval_id from opportunities where business_case ->> 'lab_run_id' = ${started.runId})`) : [];
    const docs = await tx.select({ path: vaultDocuments.path }).from(vaultDocuments).where(sql`${vaultDocuments.path} like ${`01_strategy_and_goals/venture-%${started.runId.slice(0, 8)}%`}`).orderBy(desc(vaultDocuments.createdAt));
    const notes = await tx.select({ channel: notifications.channel, state: notifications.state }).from(notifications).where(and(eq(notifications.template, "venture_lab.scorecard"), sql`${notifications.payload} ->> 'runId' = ${started.runId}`));
    const tasks = await tx.select({ state: agentTasks.state }).from(agentTasks).where(sql`${agentTasks.metadata} ->> 'parent_run_id' = ${started.runId}`);
    return { opps, apps, docs, notes, tasks };
  });
  record(7, "one opportunity per analysed venture, each awaiting the owner's approval", outcome.opps.length === children.length && outcome.apps.every((a) => a.state === "pending" && a.approverRole === "superadmin"), `${outcome.opps.length} opportunit(ies): ${outcome.opps.map((o) => o.title).join(" | ")}`);
  record(8, "scorecard and venture notes written to the agency vault", outcome.docs.length === children.length + 1, outcome.docs.map((d) => d.path).join(", "));
  record(9, "owner notified (e-mail per superadmin member, Pumble)", outcome.notes.length >= 1, `${outcome.notes.length} notification(s): ${outcome.notes.map((n) => `${n.channel}:${n.state}`).join(", ")}`);
  record(10, "delegated tasks closed", outcome.tasks.every((t) => t.state === "done"), `${outcome.tasks.length} task(s): ${[...new Set(outcome.tasks.map((t) => t.state))].join(", ")}`);

  // Isolation: a demo tenant sees none of it.
  const [demo] = await handle.withContext(OPERATOR, (tx) => tx.select({ id: tenants.id }).from(tenants).where(sql`${tenants.kind} <> 'agency'`).limit(1));
  if (demo) {
    const demoCtx = tenantContext({ tenantId: demo.id, actorType: "system", actorId: "venture-lab-check", roles: ["superadmin"] });
    const leak = await handle.withContext(demoCtx, async (tx) => {
      const r = await tx.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.parentRunId, started.runId));
      const o = await tx.select({ id: opportunities.id }).from(opportunities).where(sql`${opportunities.businessCase} ->> 'lab_run_id' = ${started.runId}`);
      return r.length + o.length;
    });
    record(11, "tenant isolation: another tenant sees no lab runs or opportunities", leak === 0, `${leak} row(s) visible`);
  }
} catch (err) {
  record(99, "unexpected failure", false, (err as Error).message);
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map((f) => f.step).join(", ")}` : ""}`);
  await boss.stop({ graceful: false });
  await handle.close();
  process.exit(failed.length ? 1 : 0);
}
