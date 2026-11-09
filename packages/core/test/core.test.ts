import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, tenantContext, runMigrations, schema, type DbHandle } from "@sbos/db";
import { seed } from "@sbos/db/seed";
import { createRun, transitionRun, requestApproval, decideApproval, registerAction, markActionExecuted, MemoryJobBackend, checkBudget, recordCost, writeVaultDocument, queueNotification } from "../src/index";

const url = process.env.DATABASE_URL_TEST ?? "postgres://sbos:sbos@localhost:5432/sbos_test";
let handle: DbHandle;
let tenantA: string;
let tenantB: string;
let instanceA: string;
const jobs = new MemoryJobBackend();
const agentActor = { actorType: "agent" as const, actorId: "agent:discovery:northline", roles: ["agent_service"] };
const ceoActor = { actorType: "user" as const, actorId: "ceo-user", roles: ["client_admin"] };

async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown = null;
  try { await promise; } catch (err) { caught = err; }
  expect(caught, "expected failure").not.toBeNull();
  const e = caught as { message?: string; cause?: { message?: string } };
  expect(`${e.message ?? ""} :: ${e.cause?.message ?? ""}`).toMatch(pattern);
}

beforeAll(async () => {
  await runMigrations(url);
  handle = createDb({ connectionString: url, max: 4 });
  const seeded = await seed(handle);
  tenantA = seeded.tenantIds["northline-events"]!;
  tenantB = seeded.tenantIds["harbour-view-hotel"]!;
  instanceA = await handle.withContext(tenantContext({ tenantId: tenantA, ...agentActor }), async (tx) => (await tx.select({ id: schema.agentInstances.id }).from(schema.agentInstances))[0]!.id);
});
afterAll(async () => handle.close());

describe("run state machine", () => {
  it("enforces transitions in the database and enqueues the job", async () => {
    const ctx = tenantContext({ tenantId: tenantA, ...agentActor });
    const { runId } = await handle.withContext(ctx, (tx) => createRun(tx, ctx, jobs, { tenantId: tenantA, agentInstanceId: instanceA, trigger: "command", triggerRef: "test" }));
    expect(jobs.jobs.at(-1)?.name).toBe("agent.run");
    await handle.withContext(ctx, (tx) => transitionRun(tx, { tenantId: tenantA, runId, to: "running" }));
    await expectDbError(handle.withContext(ctx, (tx) => transitionRun(tx, { tenantId: tenantA, runId, to: "queued" })), /invalid run transition running -> queued/);
    await handle.withContext(ctx, (tx) => transitionRun(tx, { tenantId: tenantA, runId, to: "succeeded" }));
    await expectDbError(handle.withContext(ctx, (tx) => transitionRun(tx, { tenantId: tenantA, runId, to: "running" })), /terminal/);
    const events = await handle.withContext(ctx, (tx) => tx.select().from(schema.runEvents).where(sql`run_id = ${runId}`));
    expect(events.map((e) => e.kind)).toEqual(["state_change", "state_change", "state_change"]);
  });

  it("tenant B cannot see tenant A runs", async () => {
    const rows = await handle.withContext(tenantContext({ tenantId: tenantB, ...agentActor }), (tx) => tx.select().from(schema.agentRuns));
    expect(rows.every((r) => r.tenantId === tenantB)).toBe(true);
  });
});

describe("approval gate", () => {
  it("blocks execution without an approved approval and resumes the run after approval", async () => {
    const ctx = tenantContext({ tenantId: tenantA, ...agentActor });
    const { runId } = await handle.withContext(ctx, (tx) => createRun(tx, ctx, jobs, { tenantId: tenantA, agentInstanceId: instanceA, trigger: "command" }));
    await handle.withContext(ctx, (tx) => transitionRun(tx, { tenantId: tenantA, runId, to: "running" }));

    const actionId = await handle.withContext(ctx, (tx) => registerAction(tx, { tenantId: tenantA, runId, actionType: "publish_questions", risk: "medium", payload: { count: 3 } }));
    await expectDbError(handle.withContext(ctx, (tx) => markActionExecuted(tx, { tenantId: tenantA, actionId, result: {} })), /requires an approval/);

    const { approvalId } = await handle.withContext(ctx, (tx) => requestApproval(tx, ctx, { tenantId: tenantA, runId, subjectType: "approved_action", subjectId: actionId, requestedBy: agentActor, approverRole: "client_admin", risk: "medium", summary: "Publish 3 questions", rationale: "Questions go to client staff" }));
    let run = await handle.withContext(ctx, (tx) => tx.select().from(schema.agentRuns).where(sql`id = ${runId}`));
    expect(run[0]?.state).toBe("waiting_for_approval");

    await handle.withContext(ctx, (tx) => tx.update(schema.approvedActions).set({ approvalId }).where(sql`id = ${actionId}`));
    await expectDbError(handle.withContext(ctx, (tx) => markActionExecuted(tx, { tenantId: tenantA, actionId, result: {} })), /is pending/);

    const ceo = tenantContext({ tenantId: tenantA, ...ceoActor });
    await handle.withContext(ceo, (tx) => decideApproval(tx, ceo, jobs, { tenantId: tenantA, approvalId, decision: "approved", decidedBy: { actorId: ceoActor.actorId } }));
    expect(jobs.jobs.at(-1)?.name).toBe("agent.resume");
    run = await handle.withContext(ctx, (tx) => tx.select().from(schema.agentRuns).where(sql`id = ${runId}`));
    expect(run[0]?.state).toBe("queued");

    await handle.withContext(ctx, (tx) => markActionExecuted(tx, { tenantId: tenantA, actionId, result: { published: 3 } }));
    await expectDbError(handle.withContext(ceo, (tx) => decideApproval(tx, ceo, jobs, { tenantId: tenantA, approvalId, decision: "rejected", decidedBy: { actorId: ceoActor.actorId } })), /already approved/);
  });

  it("an approval from another tenant does not unlock an action", async () => {
    const ctxA = tenantContext({ tenantId: tenantA, ...agentActor });
    const ctxB = tenantContext({ tenantId: tenantB, ...agentActor });
    const ceoB = tenantContext({ tenantId: tenantB, ...ceoActor });
    const instanceB = await handle.withContext(ctxB, async (tx) => (await tx.select({ id: schema.agentInstances.id }).from(schema.agentInstances))[0]!.id);
    const { runId } = await handle.withContext(ctxB, (tx) => createRun(tx, ctxB, jobs, { tenantId: tenantB, agentInstanceId: instanceB, trigger: "command" }));
    const { approvalId } = await handle.withContext(ctxB, (tx) => requestApproval(tx, ctxB, { tenantId: tenantB, runId: null, subjectType: "x", requestedBy: agentActor, approverRole: "client_admin", risk: "high", summary: "x", rationale: "x" }));
    await handle.withContext(ceoB, (tx) => decideApproval(tx, ceoB, jobs, { tenantId: tenantB, approvalId, decision: "approved", decidedBy: { actorId: "ceo-b" } }));
    void runId;
    // Tenant A cannot even reference tenant B's approval row through RLS: the FK lookup fails or the gate rejects it.
    const actionId = await handle.withContext(ctxA, (tx) => registerAction(tx, { tenantId: tenantA, actionType: "publish_questions", risk: "high", payload: {} }));
    await expectDbError(
      handle.withContext(ctxA, (tx) => tx.update(schema.approvedActions).set({ approvalId, executedAt: new Date() }).where(sql`id = ${actionId}`)),
      /tenant match: f|violates foreign key|is missing/
    );
  });
});

describe("budgets and costs", () => {
  it("hard-stops when the tenant cap is spent", async () => {
    const ctx = tenantContext({ tenantId: tenantA, ...agentActor });
    const { runId } = await handle.withContext(ctx, (tx) => createRun(tx, ctx, jobs, { tenantId: tenantA, agentInstanceId: instanceA, trigger: "command" }));
    const before = await handle.withContext(ctx, (tx) => checkBudget(tx, { tenantId: tenantA, agentInstanceId: instanceA, platform: { capUsdMonth: 25, spentUsdMonth: 0, hardStop: true, runCapUsd: 0.5 } }));
    expect(before.ok).toBe(true);
    expect(before.runCapUsd).toBe(0.25);
    await handle.withContext(ctx, (tx) => recordCost(tx, { tenantId: tenantA, runId, agentInstanceId: instanceA, model: "claude-sonnet-5-5", tokensInput: 1, tokensOutput: 1, costUsd: 6.0, simulated: false }));
    const after = await handle.withContext(ctx, (tx) => checkBudget(tx, { tenantId: tenantA, agentInstanceId: instanceA, platform: { capUsdMonth: 25, spentUsdMonth: 6, hardStop: true, runCapUsd: 0.5 } }));
    expect(after.ok).toBe(false);
    expect(after.blockedBy?.scope).toBe("agent_instance");
  });
});

describe("vault and notifications", () => {
  it("writes documents with revisions and rejects content in notification payloads", async () => {
    const ctx = tenantContext({ tenantId: tenantA, ...agentActor });
    const first = await handle.withContext(ctx, (tx) => writeVaultDocument(tx, ctx, { tenantId: tenantA, path: "13_interviews_and_open_questions/round-test.md", title: "Round test", frontmatter: { round: 1 }, bodyMarkdown: "# Round 1" }));
    const second = await handle.withContext(ctx, (tx) => writeVaultDocument(tx, ctx, { tenantId: tenantA, path: "13_interviews_and_open_questions/round-test.md", title: "Round test", frontmatter: { round: 1 }, bodyMarkdown: "# Round 1 updated" }));
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.documentId).toBe(first.documentId);
    const revisions = await handle.withContext(ctx, (tx) => tx.select().from(schema.vaultRevisions).where(sql`document_id = ${first.documentId}`));
    expect(revisions.length).toBe(2);
    await expect(handle.withContext(ctx, (tx) => queueNotification(tx, jobs, { tenantId: tenantA, channel: "email", template: "x", subject: "x", payload: { question_text: "secret" } }))).rejects.toThrow(/may not contain/);
    await expect(handle.withContext(ctx, (tx) => writeVaultDocument(tx, ctx, { tenantId: tenantA, path: "../etc/passwd", title: "x", frontmatter: {}, bodyMarkdown: "x" }))).rejects.toThrow(/vault path/);
  });
});
