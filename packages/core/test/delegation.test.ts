import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, tenantContext, runMigrations, schema, ensureAgencyAgents, VENTURE_ANALYSTS, type DbHandle } from "@sbos/db";
import { seed } from "@sbos/db/seed";
import { MemoryJobBackend, createRun, listChildRuns, lockRun, pendingChildren, transitionRun, wakeParentRun } from "../src/index";

/** Delegation between runs (ADR-025): parent_run_id lineage, the wake protocol and the agency-only Venture Lab catalogue. */
const url = process.env.DATABASE_URL_TEST ?? "postgres://sbos:sbos@localhost:5432/sbos_test";
let handle: DbHandle; let agencyId: string; let northline: string; let labInstance: string; let analystInstances: string[];
const jobs = new MemoryJobBackend();
const agent = { actorType: "agent" as const, actorId: "agent:venture-lab:agency", roles: ["agent_service"] };

beforeAll(async () => {
  await runMigrations(url); handle = createDb({ connectionString: url, max: 4 });
  const seeded = await seed(handle); agencyId = seeded.agencyTenantId; northline = seeded.tenantIds["northline-events"]!;
  const rows = await handle.withContext(tenantContext({ tenantId: agencyId, ...agent }), (tx) => tx.select({ id: schema.agentInstances.id, def: schema.agentDefinitions.key }).from(schema.agentInstances).innerJoin(schema.agentDefinitions, eq(schema.agentDefinitions.id, schema.agentInstances.definitionId)));
  labInstance = rows.find((r) => r.def === "venture-lab")!.id;
  analystInstances = rows.filter((r) => r.def === "venture-analyst").map((r) => r.id);
});
afterAll(async () => handle.close());

describe("venture lab catalogue", () => {
  it("seeds one orchestrator, the analysts and a disabled weekly schedule in the agency tenant only, and stays idempotent", async () => {
    expect(analystInstances).toHaveLength(VENTURE_ANALYSTS);
    const ctx = tenantContext({ tenantId: agencyId, ...agent });
    const sched = await handle.withContext(ctx, (tx) => tx.select({ enabled: schema.schedules.enabled, cron: schema.schedules.cron }).from(schema.schedules).where(eq(schema.schedules.agentInstanceId, labInstance)));
    expect(sched).toEqual([{ enabled: false, cron: "0 2 * * 1" }]);
    const clientRows = await handle.withContext(tenantContext({ tenantId: northline, ...agent }), (tx) => tx.select({ def: schema.agentDefinitions.key }).from(schema.agentInstances).innerJoin(schema.agentDefinitions, eq(schema.agentDefinitions.id, schema.agentInstances.definitionId)));
    expect(clientRows.some((r) => r.def.startsWith("venture"))).toBe(false);
    const again = await ensureAgencyAgents(handle);
    expect(again.agencyTenantId).toBe(agencyId);
    const count = await handle.withContext(ctx, (tx) => tx.select({ id: schema.agentInstances.id }).from(schema.agentInstances));
    expect(count).toHaveLength(1 + VENTURE_ANALYSTS);
  });
});

describe("delegation and the wake protocol", () => {
  it("child runs carry parent_run_id; a terminal child wakes a waiting parent exactly once and enqueues its resume", async () => {
    const ctx = tenantContext({ tenantId: agencyId, ...agent });
    const parent = await handle.withContext(ctx, (tx) => createRun(tx, ctx, jobs, { tenantId: agencyId, agentInstanceId: labInstance, trigger: "command", triggerRef: "test" }));
    await handle.withContext(ctx, (tx) => transitionRun(tx, { tenantId: agencyId, runId: parent.runId, to: "running" }));
    const children = await handle.withContext(ctx, async (tx) => Promise.all([0, 1].map((i) => createRun(tx, ctx, jobs, { tenantId: agencyId, agentInstanceId: analystInstances[i]!, trigger: "event", triggerRef: `delegation:${parent.runId}`, parentRunId: parent.runId }))));
    const listed = await handle.withContext(ctx, (tx) => listChildRuns(tx, agencyId, parent.runId));
    expect(listed.map((c) => c.id).sort()).toEqual(children.map((c) => c.runId).sort());
    expect(pendingChildren(listed)).toBe(2);

    // Parent is running (collect has not suspended yet): a finishing child leaves it alone, just a note.
    await handle.withContext(ctx, async (tx) => {
      await transitionRun(tx, { tenantId: agencyId, runId: children[0]!.runId, to: "running" });
      await transitionRun(tx, { tenantId: agencyId, runId: children[0]!.runId, to: "succeeded", summary: "done" });
      const r = await wakeParentRun(tx, jobs, { tenantId: agencyId, childRunId: children[0]!.runId });
      expect(r).toEqual({ parentRunId: parent.runId, woke: false });
    });
    // Parent locks itself, sees one pending child and suspends.
    await handle.withContext(ctx, async (tx) => {
      const locked = await lockRun(tx, agencyId, parent.runId);
      expect(locked?.state).toBe("running");
      const pending = pendingChildren(await listChildRuns(tx, agencyId, parent.runId));
      expect(pending).toBe(1);
      await transitionRun(tx, { tenantId: agencyId, runId: parent.runId, to: "waiting_for_input", summary: "waiting for 1 delegated run(s)" });
    });
    // The last child fails: the parent is re-queued and its resume job carries the child_finished reason.
    const before = jobs.jobs.length;
    await handle.withContext(ctx, async (tx) => {
      await transitionRun(tx, { tenantId: agencyId, runId: children[1]!.runId, to: "running" });
      await transitionRun(tx, { tenantId: agencyId, runId: children[1]!.runId, to: "failed", summary: "failed" });
      const r = await wakeParentRun(tx, jobs, { tenantId: agencyId, childRunId: children[1]!.runId });
      expect(r).toEqual({ parentRunId: parent.runId, woke: true });
    });
    const [p] = await handle.withContext(ctx, (tx) => tx.select({ state: schema.agentRuns.state }).from(schema.agentRuns).where(eq(schema.agentRuns.id, parent.runId)));
    expect(p?.state).toBe("queued");
    const resume = jobs.jobs.slice(before).find((j) => j.name === "agent.resume");
    expect(resume?.payload).toMatchObject({ runId: parent.runId, reason: "child_finished" });
    expect(resume?.options).toMatchObject({ singletonKey: `resume:${parent.runId}`, startAfterSeconds: 3 });
    // Nothing pending any more; a second wake from the same child is a no-op (parent no longer waiting).
    const after = await handle.withContext(ctx, (tx) => listChildRuns(tx, agencyId, parent.runId));
    expect(pendingChildren(after)).toBe(0);
    const again = await handle.withContext(ctx, (tx) => wakeParentRun(tx, jobs, { tenantId: agencyId, childRunId: children[1]!.runId }));
    expect(again.woke).toBe(false);
    // A run without a parent never wakes anything.
    const lone = await handle.withContext(ctx, (tx) => wakeParentRun(tx, jobs, { tenantId: agencyId, childRunId: parent.runId }));
    expect(lone).toEqual({ parentRunId: null, woke: false });
  });

  it("another tenant cannot see or wake the agency's delegated runs", async () => {
    const ctxA = tenantContext({ tenantId: agencyId, ...agent });
    const parent = await handle.withContext(ctxA, (tx) => createRun(tx, ctxA, jobs, { tenantId: agencyId, agentInstanceId: labInstance, trigger: "command" }));
    const child = await handle.withContext(ctxA, (tx) => createRun(tx, ctxA, jobs, { tenantId: agencyId, agentInstanceId: analystInstances[0]!, trigger: "event", parentRunId: parent.runId }));
    const ctxB = tenantContext({ tenantId: northline, ...agent });
    expect(await handle.withContext(ctxB, (tx) => listChildRuns(tx, northline, parent.runId))).toEqual([]);
    expect(await handle.withContext(ctxB, (tx) => lockRun(tx, northline, parent.runId))).toBeNull();
    expect(await handle.withContext(ctxB, (tx) => wakeParentRun(tx, jobs, { tenantId: northline, childRunId: child.runId }))).toEqual({ parentRunId: null, woke: false });
  });
});
