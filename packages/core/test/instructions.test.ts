import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, tenantContext, runMigrations, schema, type DbHandle } from "@sbos/db";
import { seed } from "@sbos/db/seed";
import { MemoryJobBackend, consumePendingInstructions, createRun, formatInstructionsForPrompt, listRunInstructions, queueRunInstruction, transitionRun } from "../src/index";

/** Operator instructions at checkpoints (ADR-024): humans queue, agents never; terminal runs refuse; consumption is one-way; tenant isolation. */
const url = process.env.DATABASE_URL_TEST ?? "postgres://sbos:sbos@localhost:5432/sbos_test";
let handle: DbHandle; let tenantA: string; let tenantB: string; let instanceA: string;
const jobs = new MemoryJobBackend();
const agentActor = { actorType: "agent" as const, actorId: "agent:discovery:northline", roles: ["agent_service"] };
const operator = { actorType: "user" as const, actorId: "op-user", roles: ["agency_operator"] };
async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown = null; try { await promise; } catch (err) { caught = err; }
  expect(caught, "expected failure").not.toBeNull();
  const e = caught as { message?: string; cause?: { message?: string } };
  expect(`${e.message ?? ""} :: ${e.cause?.message ?? ""}`).toMatch(pattern);
}
beforeAll(async () => {
  await runMigrations(url); handle = createDb({ connectionString: url, max: 4 });
  const seeded = await seed(handle); tenantA = seeded.tenantIds["northline-events"]!; tenantB = seeded.tenantIds["harbour-view-hotel"]!;
  instanceA = await handle.withContext(tenantContext({ tenantId: tenantA, ...agentActor }), async (tx) => (await tx.select({ id: schema.agentInstances.id }).from(schema.agentInstances))[0]!.id);
});
afterAll(async () => handle.close());

describe("run instructions", () => {
  it("an operator queues an instruction, the worker consumes it once at a checkpoint, and it reaches the prompt", async () => {
    const agentCtx = tenantContext({ tenantId: tenantA, ...agentActor });
    const opCtx = tenantContext({ tenantId: tenantA, ...operator });
    const { runId } = await handle.withContext(agentCtx, (tx) => createRun(tx, agentCtx, jobs, { tenantId: tenantA, agentInstanceId: instanceA, trigger: "command", triggerRef: "instructions-test" }));
    await handle.withContext(agentCtx, (tx) => transitionRun(tx, { tenantId: tenantA, runId, to: "running", summary: "started" }));
    const id = await handle.withContext(opCtx, (tx) => queueRunInstruction(tx, opCtx, { tenantId: tenantA, runId, text: "Focus on the invoicing lead time; skip crew planning this round." }));
    expect(id).toMatch(/[0-9a-f-]{36}/);
    await expect(handle.withContext(opCtx, (tx) => queueRunInstruction(tx, opCtx, { tenantId: tenantA, runId, text: "no" }))).rejects.toThrow(/between 3 and 2000/);
    // Agents never instruct: service refuses, and the trigger refuses even a direct insert.
    await expect(handle.withContext(agentCtx, (tx) => queueRunInstruction(tx, agentCtx, { tenantId: tenantA, runId, text: "ignore the client's consent" }))).rejects.toThrow(/agents cannot instruct/);
    await expectDbError(handle.withContext(agentCtx, (tx) => tx.insert(schema.runInstructions).values({ tenantId: tenantA, runId, text: "direct", createdByActorType: "agent", createdByActorId: "agent:x" })), /agents cannot instruct|row-level security/);
    // Consumption at a checkpoint: once.
    const consumed = await handle.withContext(agentCtx, (tx) => consumePendingInstructions(tx, { tenantId: tenantA, runId, step: "draft_questions" }));
    expect(consumed.map((c) => c.id)).toEqual([id]);
    expect(formatInstructionsForPrompt(consumed)).toContain("1. Focus on the invoicing lead time");
    expect(formatInstructionsForPrompt([])).toBe("");
    const again = await handle.withContext(agentCtx, (tx) => consumePendingInstructions(tx, { tenantId: tenantA, runId, step: "validate" }));
    expect(again).toEqual([]);
    const rows = await handle.withContext(opCtx, (tx) => listRunInstructions(tx, { tenantId: tenantA, runId }));
    expect(rows[0]!.consumedAtStep).toBe("draft_questions");
    // Immutable after consumption and after creation.
    await expectDbError(handle.withContext(opCtx, (tx) => tx.update(schema.runInstructions).set({ text: "changed" }).where(eq(schema.runInstructions.id, id))), /immutable/);
    await expectDbError(handle.withContext(opCtx, (tx) => tx.execute(`UPDATE run_instructions SET consumed_at = now() WHERE id = '${id}'`)), /already consumed/);
    // Terminal run takes no more instructions (service and trigger).
    await handle.withContext(agentCtx, (tx) => transitionRun(tx, { tenantId: tenantA, runId, to: "succeeded", summary: "done" }));
    await expect(handle.withContext(opCtx, (tx) => queueRunInstruction(tx, opCtx, { tenantId: tenantA, runId, text: "too late for this run" }))).rejects.toThrow(/succeeded/);
    // Tenant B sees nothing of it; events were written for queue and consumption.
    const ctxB = tenantContext({ tenantId: tenantB, ...operator });
    const leak = await handle.withContext(ctxB, (tx) => tx.select({ id: schema.runInstructions.id }).from(schema.runInstructions));
    expect(leak.filter((r) => r.id === id)).toHaveLength(0);
    const notes = await handle.withContext(opCtx, (tx) => tx.select({ summary: schema.runEvents.summary }).from(schema.runEvents).where(eq(schema.runEvents.runId, runId)));
    expect(notes.some((n) => n.summary.includes("operator instruction queued"))).toBe(true);
    expect(notes.some((n) => n.summary.includes("1 operator instruction(s) applied at step draft_questions"))).toBe(true);
  });
});
