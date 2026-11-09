import { and, desc, eq, sql } from "drizzle-orm";
import { schema, writeAudit, type RequestContext, type Tx } from "@sbos/db";
import type { JobBackend } from "./job-backend";

const { agentRuns, runEvents, agentInstances, agentTasks } = schema;

export type RunState = (typeof schema.runState.enumValues)[number];
export type RunEventKind = (typeof schema.runEventKind.enumValues)[number];
export type Classification = (typeof schema.classification.enumValues)[number];

export interface StartRunInput {
  tenantId: string;
  agentInstanceId: string;
  trigger: "schedule" | "event" | "command" | "resume" | "recovery";
  triggerRef?: string;
  taskId?: string | null;
  scheduleId?: string | null;
  skillVersionId?: string | null;
}

/** Creates a queued run and enqueues its job in the same transaction. */
export async function createRun(tx: Tx, ctx: RequestContext, jobs: JobBackend, input: StartRunInput): Promise<{ runId: string }> {
  const [run] = await tx
    .insert(agentRuns)
    .values({
      tenantId: input.tenantId,
      agentInstanceId: input.agentInstanceId,
      taskId: input.taskId ?? null,
      scheduleId: input.scheduleId ?? null,
      skillVersionId: input.skillVersionId ?? null,
      trigger: input.trigger,
      triggerRef: input.triggerRef ?? null,
      state: "queued"
    })
    .returning({ id: agentRuns.id });
  if (!run) throw new Error("run insert returned nothing");
  await appendRunEvent(tx, { tenantId: input.tenantId, runId: run.id, kind: "state_change", summary: `queued (trigger: ${input.trigger})`, payload: { to: "queued", trigger: input.trigger, triggerRef: input.triggerRef ?? null } });
  await writeAudit(tx, ctx, { action: "agent_run.created", entityType: "agent_run", entityId: run.id, after: { trigger: input.trigger, agentInstanceId: input.agentInstanceId } });
  if (input.taskId) {
    await tx.update(agentTasks).set({ state: "in_progress" }).where(and(eq(agentTasks.id, input.taskId), eq(agentTasks.tenantId, input.tenantId)));
  }
  const jobId = await jobs.enqueue("agent.run", { tenantId: input.tenantId, runId: run.id }, { singletonKey: `run:${run.id}` });
  if (jobId) await tx.update(agentRuns).set({ jobId }).where(eq(agentRuns.id, run.id));
  return { runId: run.id };
}

export interface RunEventInput {
  tenantId: string;
  runId: string;
  kind: RunEventKind;
  summary: string;
  payload?: Record<string, unknown>;
  classification?: Classification;
  tokensInput?: number;
  tokensOutput?: number;
  costUsd?: number;
  durationMs?: number;
}

/** Appends an event with the next sequence number. Summary must be neutral; detail goes in payload. */
export async function appendRunEvent(tx: Tx, input: RunEventInput): Promise<void> {
  const [row] = await tx.select({ next: sql<number>`coalesce(max(${runEvents.seq}), 0) + 1`.mapWith(Number) }).from(runEvents).where(eq(runEvents.runId, input.runId));
  await tx.insert(runEvents).values({
    tenantId: input.tenantId,
    runId: input.runId,
    seq: row?.next ?? 1,
    kind: input.kind,
    classification: input.classification ?? "internal",
    summary: input.summary,
    payload: input.payload ?? {},
    tokensInput: input.tokensInput ?? 0,
    tokensOutput: input.tokensOutput ?? 0,
    costUsd: String(input.costUsd ?? 0),
    durationMs: input.durationMs ?? null
  });
}

/** Transitions a run; the database trigger rejects illegal transitions. */
export async function transitionRun(
  tx: Tx,
  input: { tenantId: string; runId: string; to: RunState; summary?: string; payload?: Record<string, unknown>; patch?: Partial<typeof agentRuns.$inferInsert> }
): Promise<void> {
  const patch: Partial<typeof agentRuns.$inferInsert> = { state: input.to, ...(input.patch ?? {}) };
  if (input.to === "running") {
    patch.startedAt = patch.startedAt ?? new Date();
    patch.leaseExpiresAt = patch.leaseExpiresAt ?? new Date(Date.now() + 90_000);
  }
  if (["succeeded", "failed", "cancelled", "timed_out"].includes(input.to)) {
    patch.finishedAt = patch.finishedAt ?? new Date();
    patch.leaseExpiresAt = null;
  }
  const updated = await tx.update(agentRuns).set(patch).where(and(eq(agentRuns.id, input.runId), eq(agentRuns.tenantId, input.tenantId))).returning({ id: agentRuns.id });
  if (updated.length === 0) throw new Error(`run ${input.runId} not found in tenant ${input.tenantId}`);
  await appendRunEvent(tx, { tenantId: input.tenantId, runId: input.runId, kind: "state_change", summary: input.summary ?? input.to, payload: { to: input.to, ...(input.payload ?? {}) } });
  const instanceState = input.to === "running" ? "running" : input.to === "failed" ? "error" : input.to === "paused" ? "paused" : input.to.startsWith("waiting") ? "blocked" : "idle";
  const [run] = await tx.select({ agentInstanceId: agentRuns.agentInstanceId }).from(agentRuns).where(eq(agentRuns.id, input.runId));
  if (run) {
    await tx.update(agentInstances).set({ state: instanceState, ...(input.to === "running" ? { lastRunAt: new Date() } : {}) }).where(eq(agentInstances.id, run.agentInstanceId));
  }
}

export async function heartbeatRun(tx: Tx, tenantId: string, runId: string, leaseSeconds = 90): Promise<void> {
  await tx.update(agentRuns).set({ leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000) }).where(and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, tenantId), eq(agentRuns.state, "running")));
}

export async function saveCheckpoint(tx: Tx, tenantId: string, runId: string, checkpoint: Record<string, unknown>, summary: string): Promise<void> {
  await tx.update(agentRuns).set({ checkpoint }).where(and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, tenantId)));
  await appendRunEvent(tx, { tenantId, runId, kind: "checkpoint", summary, payload: { step: checkpoint.step ?? null } });
}

export async function getRun(tx: Tx, tenantId: string, runId: string) {
  const [run] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, tenantId)));
  return run ?? null;
}

export async function listRunEvents(tx: Tx, tenantId: string, runId: string) {
  return tx.select().from(runEvents).where(and(eq(runEvents.runId, runId), eq(runEvents.tenantId, tenantId))).orderBy(runEvents.seq);
}

export async function listRecentRuns(tx: Tx, tenantId: string, limit = 50) {
  return tx.select().from(agentRuns).where(eq(agentRuns.tenantId, tenantId)).orderBy(desc(agentRuns.createdAt)).limit(limit);
}
