import { and, eq } from "drizzle-orm";
import { schema, writeAudit, type RequestContext, type Tx } from "@sbos/db";
import type { JobBackend } from "./job-backend";
import { appendRunEvent, transitionRun } from "./runs";

const { approvals, approvedActions } = schema;

export type RiskLevel = (typeof schema.riskLevel.enumValues)[number];

export interface RequestApprovalInput {
  tenantId: string;
  runId?: string | null;
  taskId?: string | null;
  subjectType: string;
  subjectId?: string | null;
  requestedBy: { actorType: "user" | "agent" | "system"; actorId: string };
  approverRole: string;
  risk: RiskLevel;
  summary: string;
  rationale: string;
  evidenceIds?: string[];
  expiresInHours?: number;
}

/** Creates a pending approval. If a run is attached and the approval is blocking, the run suspends. */
export async function requestApproval(tx: Tx, ctx: RequestContext, input: RequestApprovalInput): Promise<{ approvalId: string }> {
  const [row] = await tx
    .insert(approvals)
    .values({
      tenantId: input.tenantId,
      runId: input.runId ?? null,
      taskId: input.taskId ?? null,
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      requestedByActorType: input.requestedBy.actorType,
      requestedByActorId: input.requestedBy.actorId,
      approverRole: input.approverRole,
      risk: input.risk,
      summary: input.summary,
      rationale: input.rationale,
      evidenceIds: input.evidenceIds ?? [],
      blocking: true,
      expiresAt: new Date(Date.now() + (input.expiresInHours ?? 72) * 3_600_000)
    })
    .returning({ id: approvals.id });
  if (!row) throw new Error("approval insert returned nothing");
  await writeAudit(tx, ctx, { action: "approval.requested", entityType: "approval", entityId: row.id, after: { subjectType: input.subjectType, risk: input.risk } });
  if (input.runId) {
    await appendRunEvent(tx, { tenantId: input.tenantId, runId: input.runId, kind: "approval_requested", summary: `approval requested (${input.risk} risk) from ${input.approverRole}`, payload: { approvalId: row.id } });
    await transitionRun(tx, { tenantId: input.tenantId, runId: input.runId, to: "waiting_for_approval", summary: "waiting for approval", payload: { approvalId: row.id } });
  }
  return { approvalId: row.id };
}

export interface DecideApprovalInput {
  tenantId: string;
  approvalId: string;
  decision: "approved" | "rejected";
  decidedBy: { userId?: string | null; actorId: string };
  note?: string;
}

/** Decides a pending approval and re-queues the suspended run. The DB trigger blocks double decisions and self-approval. */
export async function decideApproval(tx: Tx, ctx: RequestContext, jobs: JobBackend, input: DecideApprovalInput): Promise<void> {
  const [existing] = await tx.select().from(approvals).where(and(eq(approvals.id, input.approvalId), eq(approvals.tenantId, input.tenantId)));
  if (!existing) throw new Error("approval not found");
  if (existing.state !== "pending") throw new Error(`approval already ${existing.state}`);
  await tx
    .update(approvals)
    .set({ state: input.decision, decidedByUserId: input.decidedBy.userId ?? null, decidedByActorId: input.decidedBy.actorId, decidedAt: new Date(), decisionNote: input.note ?? null })
    .where(eq(approvals.id, input.approvalId));
  await writeAudit(tx, ctx, { action: `approval.${input.decision}`, entityType: "approval", entityId: input.approvalId, before: { state: "pending" }, after: { state: input.decision } });
  if (existing.runId) {
    await appendRunEvent(tx, { tenantId: input.tenantId, runId: existing.runId, kind: "approval_decided", summary: `approval ${input.decision}`, payload: { approvalId: input.approvalId, decision: input.decision } });
    if (input.decision === "approved") {
      await transitionRun(tx, { tenantId: input.tenantId, runId: existing.runId, to: "queued", summary: "re-queued after approval" });
      await jobs.enqueue("agent.resume", { tenantId: input.tenantId, runId: existing.runId, reason: "approval_decided" }, { singletonKey: `resume:${existing.runId}` });
    } else {
      await transitionRun(tx, { tenantId: input.tenantId, runId: existing.runId, to: "cancelled", summary: "cancelled: approval rejected" });
    }
  }
}

/** Registers an action that needs approval before it may execute. Execution is gated by the DB trigger. */
export async function registerAction(tx: Tx, input: { tenantId: string; runId?: string | null; actionType: string; risk: RiskLevel; payload: Record<string, unknown>; approvalId?: string | null }): Promise<string> {
  const [row] = await tx
    .insert(approvedActions)
    .values({ tenantId: input.tenantId, runId: input.runId ?? null, actionType: input.actionType, risk: input.risk, payload: input.payload, approvalId: input.approvalId ?? null })
    .returning({ id: approvedActions.id });
  if (!row) throw new Error("action insert returned nothing");
  return row.id;
}

/** Marks an action executed. Throws (from the trigger) when the linked approval is not approved. */
export async function markActionExecuted(tx: Tx, input: { tenantId: string; actionId: string; result: Record<string, unknown> }): Promise<void> {
  await tx.update(approvedActions).set({ executedAt: new Date(), result: input.result }).where(and(eq(approvedActions.id, input.actionId), eq(approvedActions.tenantId, input.tenantId)));
}
