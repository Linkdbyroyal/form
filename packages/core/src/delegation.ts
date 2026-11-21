import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Tx } from "@sbos/db";
import type { JobBackend } from "./job-backend";
import { appendRunEvent, transitionRun } from "./runs";

const { agentRuns, agentInstances } = schema;

export const TERMINAL_RUN_STATES = ["succeeded", "failed", "cancelled", "timed_out"] as const;

/**
 * Delegation between runs (ADR-025). A parent run that delegated work suspends in `waiting_for_input` after locking
 * its own row and finding children still alive. Whoever moves a child to a terminal state calls `wakeParentRun` in
 * the same transaction: it locks the parent row (so the parent's check and the child's completion serialise on one
 * row), re-queues the parent when it is waiting, and enqueues its resume job. The parent then re-checks its children
 * at the `collect` step; a child that finished before the parent's check is simply seen as terminal there.
 */
export interface ChildRunSummary {
  id: string;
  agentInstanceId: string;
  agentName: string;
  state: string;
  summary: string | null;
  result: unknown;
  taskId: string | null;
}

export async function listChildRuns(tx: Tx, tenantId: string, parentRunId: string): Promise<ChildRunSummary[]> {
  return tx
    .select({ id: agentRuns.id, agentInstanceId: agentRuns.agentInstanceId, agentName: agentInstances.name, state: agentRuns.state, summary: agentRuns.summary, result: agentRuns.result, taskId: agentRuns.taskId })
    .from(agentRuns)
    .innerJoin(agentInstances, eq(agentInstances.id, agentRuns.agentInstanceId))
    .where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.parentRunId, parentRunId)))
    .orderBy(agentRuns.createdAt);
}

/** Locks the given run row for the rest of the transaction (the parent's check protocol). */
export async function lockRun(tx: Tx, tenantId: string, runId: string): Promise<{ id: string; state: string } | null> {
  const rows = await tx.execute<{ id: string; state: string }>(sql`SELECT id, state::text AS state FROM ${agentRuns} WHERE id = ${runId} AND tenant_id = ${tenantId} FOR UPDATE`);
  return rows.rows[0] ?? null;
}

export function pendingChildren(children: ReadonlyArray<{ state: string }>): number {
  return children.filter((c) => !(TERMINAL_RUN_STATES as readonly string[]).includes(c.state)).length;
}

/**
 * Called when `childRunId` reached a terminal state, inside that same transaction. Returns the parent id when the
 * parent was waiting and is now queued again (its resume job is enqueued with a short delay so the commit lands first).
 */
export async function wakeParentRun(tx: Tx, jobs: JobBackend, input: { tenantId: string; childRunId: string }): Promise<{ parentRunId: string | null; woke: boolean }> {
  const [child] = await tx.select({ parentRunId: agentRuns.parentRunId, state: agentRuns.state }).from(agentRuns).where(and(eq(agentRuns.id, input.childRunId), eq(agentRuns.tenantId, input.tenantId)));
  if (!child?.parentRunId) return { parentRunId: null, woke: false };
  const parent = await lockRun(tx, input.tenantId, child.parentRunId);
  if (!parent) return { parentRunId: child.parentRunId, woke: false };
  await appendRunEvent(tx, { tenantId: input.tenantId, runId: parent.id, kind: "note", summary: `delegated run ${input.childRunId.slice(0, 8)} finished (${child.state})`, payload: { childRunId: input.childRunId, childState: child.state } });
  if (parent.state !== "waiting_for_input") return { parentRunId: parent.id, woke: false };
  await transitionRun(tx, { tenantId: input.tenantId, runId: parent.id, to: "queued", summary: "re-queued: delegated run finished", payload: { childRunId: input.childRunId } });
  await jobs.enqueue("agent.resume", { tenantId: input.tenantId, runId: parent.id, reason: "child_finished" }, { singletonKey: `resume:${parent.id}`, startAfterSeconds: 3 });
  return { parentRunId: parent.id, woke: true };
}

/** Terminal children of a parent, for tests and the collect step. */
export async function childRunStates(tx: Tx, tenantId: string, parentRunId: string, states?: readonly string[]): Promise<Array<{ id: string; state: string }>> {
  const base = and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.parentRunId, parentRunId));
  const where = states && states.length > 0 ? and(base, inArray(agentRuns.state, states as never)) : base;
  return tx.select({ id: agentRuns.id, state: agentRuns.state }).from(agentRuns).where(where);
}
