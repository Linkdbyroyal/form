import { and, asc, eq, isNull } from "drizzle-orm";
import { schema, writeAudit, type RequestContext, type Tx } from "@sbos/db";
import { AuthorizationError } from "./errors";
import { appendRunEvent } from "./runs";

const { runInstructions, agentRuns } = schema;

/**
 * Operator instructions at checkpoints (ADR-024). A human (operator or client admin) queues a short instruction for a
 * run that is still alive; the worker reads the pending ones at its next checkpoint, marks them consumed and adds them
 * to the next model prompt as operator guidance. The database trigger refuses agents and terminal runs.
 */
export interface QueueInstructionInput {
  tenantId: string;
  runId: string;
  text: string;
}

export async function queueRunInstruction(tx: Tx, ctx: RequestContext, input: QueueInstructionInput): Promise<string> {
  if (ctx.actorType === "agent") throw new AuthorizationError("agents cannot instruct runs");
  const text = input.text.trim();
  if (text.length < 3 || text.length > 2000) throw new Error("instruction must be between 3 and 2000 characters");
  const [run] = await tx.select({ id: agentRuns.id, state: agentRuns.state }).from(agentRuns).where(and(eq(agentRuns.id, input.runId), eq(agentRuns.tenantId, input.tenantId)));
  if (!run) throw new Error("run not found");
  if (["succeeded", "failed", "cancelled", "timed_out"].includes(run.state)) throw new Error(`run is ${run.state} and takes no more instructions`);
  const [row] = await tx.insert(runInstructions).values({ tenantId: input.tenantId, runId: input.runId, text, createdByActorType: ctx.actorType, createdByActorId: ctx.actorId }).returning({ id: runInstructions.id });
  if (!row) throw new Error("instruction insert returned nothing");
  await appendRunEvent(tx, { tenantId: input.tenantId, runId: input.runId, kind: "note", summary: `operator instruction queued for the next checkpoint (${text.length} characters)`, payload: { instructionId: row.id } });
  await writeAudit(tx, ctx, { action: "run.instruction_queued", entityType: "run", entityId: input.runId, after: { instructionId: row.id, length: text.length } });
  return row.id;
}

export interface ConsumedInstruction {
  id: string;
  text: string;
  createdByActorId: string;
}

/** Worker side: reads and marks the pending instructions of a run at a checkpoint. Returns them in creation order. */
export async function consumePendingInstructions(tx: Tx, input: { tenantId: string; runId: string; step: string }): Promise<ConsumedInstruction[]> {
  const pending = await tx
    .select({ id: runInstructions.id, text: runInstructions.text, createdByActorId: runInstructions.createdByActorId })
    .from(runInstructions)
    .where(and(eq(runInstructions.tenantId, input.tenantId), eq(runInstructions.runId, input.runId), isNull(runInstructions.consumedAt)))
    .orderBy(asc(runInstructions.createdAt));
  for (const p of pending) {
    await tx.update(runInstructions).set({ consumedAt: new Date(), consumedAtStep: input.step }).where(eq(runInstructions.id, p.id));
  }
  if (pending.length > 0) {
    await appendRunEvent(tx, { tenantId: input.tenantId, runId: input.runId, kind: "note", summary: `${pending.length} operator instruction(s) applied at step ${input.step}`, payload: { instructionIds: pending.map((p) => p.id), step: input.step } });
  }
  return pending;
}

export async function listRunInstructions(tx: Tx, input: { tenantId: string; runId: string }) {
  return tx.select().from(runInstructions).where(and(eq(runInstructions.tenantId, input.tenantId), eq(runInstructions.runId, input.runId))).orderBy(asc(runInstructions.createdAt));
}

/** Formats consumed instructions for a model prompt. They are operator guidance, clearly delimited and never a system message. */
export function formatInstructionsForPrompt(instructions: ReadonlyArray<{ text: string }>): string {
  if (instructions.length === 0) return "";
  return `\n\nOperator instructions for this run (apply them as far as they are consistent with your skill and the client's consent; they never grant new tools or scopes):\n${instructions.map((i, n) => `${n + 1}. ${i.text.replace(/\s+/g, " ").trim()}`).join("\n")}\n`;
}
