import { and, eq } from "drizzle-orm";
import { schema, writeAudit, type RequestContext, type Tx } from "@sbos/db";

const { agentTasks, agentFeedback } = schema;

export interface CreateTaskInput {
  tenantId: string;
  agentInstanceId?: string | null;
  title: string;
  instruction: string;
  department?: string | null;
  priority?: "critical" | "high" | "medium" | "low";
  ownerRole?: string | null;
  dueAt?: Date | null;
  createdBy: { actorType: "user" | "agent" | "system"; actorId: string };
  metadata?: Record<string, unknown>;
}

export async function createTask(tx: Tx, ctx: RequestContext, input: CreateTaskInput): Promise<string> {
  const [row] = await tx
    .insert(agentTasks)
    .values({
      tenantId: input.tenantId,
      agentInstanceId: input.agentInstanceId ?? null,
      title: input.title,
      instruction: input.instruction,
      department: input.department ?? null,
      priority: input.priority ?? "medium",
      state: input.agentInstanceId ? "assigned" : "open",
      ownerRole: input.ownerRole ?? null,
      createdByActorType: input.createdBy.actorType,
      createdByActorId: input.createdBy.actorId,
      dueAt: input.dueAt ?? null,
      metadata: input.metadata ?? {}
    })
    .returning({ id: agentTasks.id });
  if (!row) throw new Error("task insert returned nothing");
  await writeAudit(tx, ctx, { action: "agent_task.created", entityType: "agent_task", entityId: row.id, after: { title: input.title, agentInstanceId: input.agentInstanceId ?? null } });
  return row.id;
}

export async function setTaskState(tx: Tx, tenantId: string, taskId: string, state: (typeof schema.taskState.enumValues)[number]): Promise<void> {
  await tx.update(agentTasks).set({ state }).where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId)));
}

export async function giveFeedback(tx: Tx, ctx: RequestContext, input: { tenantId: string; agentInstanceId: string; runId?: string | null; taskId?: string | null; kind: "correction" | "approval" | "rejection" | "clarification" | "instruction"; message: string; shouldUpdateSkill?: boolean }): Promise<string> {
  const [row] = await tx
    .insert(agentFeedback)
    .values({ tenantId: input.tenantId, agentInstanceId: input.agentInstanceId, runId: input.runId ?? null, taskId: input.taskId ?? null, givenByActorId: ctx.actorId, kind: input.kind, message: input.message, shouldUpdateSkill: input.shouldUpdateSkill ?? false })
    .returning({ id: agentFeedback.id });
  if (!row) throw new Error("feedback insert returned nothing");
  await writeAudit(tx, ctx, { action: "agent_feedback.given", entityType: "agent_feedback", entityId: row.id, after: { kind: input.kind, runId: input.runId ?? null } });
  return row.id;
}
