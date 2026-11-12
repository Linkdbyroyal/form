import { desc, eq, sql } from "drizzle-orm";
import { schema, type OperatorContext } from "@sbos/db";
import { listRunInstructions } from "@sbos/core";
import { operatorMayDecide } from "../mission-control/queries";
import { operatorRead } from "./queries";
import { EVENTS_CAP, buildSteps, type LiveRunDetail, type LiveRunState } from "./helpers";

/**
 * Run detail for the Live inspector drawer (ADR-024, slice 2). Runs in OPERATOR context like the snapshot: only the
 * columns granted to `sbos_operator` are selected. `agent_runs.checkpoint`, `result` and `run_events.payload` are
 * content and never read; the steps come from checkpoint event summaries ("step <name>") and the error code from the
 * `error` metadata column. Instructions are read through `listRunInstructions` from @sbos/core (operator SELECT,
 * migration 0011). Plain JSON (dates as ISO strings) so the route handler returns it as is.
 */
const { tenants, agentInstances, agentDefinitions, agentRuns, runEvents, approvals, incidents, agentTasks } = schema;

const num = (expr: ReturnType<typeof sql>) => sql<number>`${expr}`.mapWith(Number);
const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

export async function getLiveRunDetail(ctx: OperatorContext, runId: string): Promise<LiveRunDetail | null> {
  return operatorRead(ctx, async (tx) => {
    const [run] = await tx
      .select({
        id: agentRuns.id,
        tenantId: agentRuns.tenantId,
        tenantSlug: tenants.slug,
        tenantName: tenants.name,
        agentInstanceId: agentRuns.agentInstanceId,
        agentName: agentInstances.name,
        definitionKey: agentDefinitions.key,
        trigger: agentRuns.trigger,
        triggerRef: agentRuns.triggerRef,
        state: agentRuns.state,
        attempt: agentRuns.attempt,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
        finishedAt: agentRuns.finishedAt,
        tokensInput: agentRuns.tokensInput,
        tokensOutput: agentRuns.tokensOutput,
        costUsd: num(sql`${agentRuns.costUsd}`),
        toolCalls: num(sql`(select count(*) from run_events e where e.run_id = ${agentRuns.id} and e.kind = 'tool_call')`),
        modelCalls: num(sql`(select count(*) from run_events e where e.run_id = ${agentRuns.id} and e.kind = 'model_call')`),
        eventsTotal: num(sql`(select count(*) from run_events e where e.run_id = ${agentRuns.id})`),
        simulated: agentRuns.simulated,
        summary: agentRuns.summary,
        errorCode: sql<string | null>`coalesce(${agentRuns.error}->>'code', ${agentRuns.error}->>'class')`,
        parentRunId: agentRuns.parentRunId,
        taskId: agentRuns.taskId
      })
      .from(agentRuns)
      .innerJoin(tenants, eq(tenants.id, agentRuns.tenantId))
      .innerJoin(agentInstances, eq(agentInstances.id, agentRuns.agentInstanceId))
      .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentInstances.definitionId))
      .where(eq(agentRuns.id, runId));
    if (!run) return null;

    const [checkpointRows, eventRows, instructionRows, approvalRows, incidentRows, taskRows, childRows] = await Promise.all([
      tx.select({ summary: runEvents.summary }).from(runEvents).where(sql`${runEvents.runId} = ${runId} and ${runEvents.kind} = 'checkpoint'`).orderBy(runEvents.seq),
      // `payload` is deliberately absent: the operator role has no grant on it.
      tx
        .select({
          id: runEvents.id,
          seq: runEvents.seq,
          kind: runEvents.kind,
          classification: runEvents.classification,
          summary: runEvents.summary,
          tokensInput: runEvents.tokensInput,
          tokensOutput: runEvents.tokensOutput,
          costUsd: num(sql`${runEvents.costUsd}`),
          durationMs: runEvents.durationMs,
          occurredAt: runEvents.occurredAt
        })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .orderBy(desc(runEvents.seq))
        .limit(EVENTS_CAP),
      listRunInstructions(tx, { tenantId: run.tenantId, runId }),
      tx
        .select({ id: approvals.id, state: approvals.state, risk: approvals.risk, approverRole: approvals.approverRole, summary: approvals.summary, createdAt: approvals.createdAt })
        .from(approvals)
        .where(eq(approvals.runId, runId))
        .orderBy(desc(approvals.createdAt)),
      tx
        .select({ id: incidents.id, kind: incidents.kind, severity: incidents.severity, title: incidents.title, state: incidents.state, createdAt: incidents.createdAt })
        .from(incidents)
        .where(eq(incidents.runId, runId))
        .orderBy(desc(incidents.createdAt)),
      run.taskId ? tx.select({ id: agentTasks.id, title: agentTasks.title, priority: agentTasks.priority, state: agentTasks.state }).from(agentTasks).where(eq(agentTasks.id, run.taskId)) : Promise.resolve([]),
      tx
        .select({ id: agentRuns.id, agentName: agentInstances.name, state: agentRuns.state })
        .from(agentRuns)
        .innerJoin(agentInstances, eq(agentInstances.id, agentRuns.agentInstanceId))
        .where(eq(agentRuns.parentRunId, runId))
        .orderBy(agentRuns.createdAt)
        .limit(50)
    ]);

    const state = run.state as LiveRunState;
    return {
      run: {
        id: run.id,
        tenantId: run.tenantId,
        tenantSlug: run.tenantSlug,
        tenantName: run.tenantName,
        agentInstanceId: run.agentInstanceId,
        agentName: run.agentName,
        definitionKey: run.definitionKey,
        trigger: run.trigger,
        triggerRef: run.triggerRef,
        state,
        attempt: run.attempt,
        createdAt: iso(run.createdAt)!,
        startedAt: iso(run.startedAt),
        finishedAt: iso(run.finishedAt),
        tokensInput: run.tokensInput,
        tokensOutput: run.tokensOutput,
        costUsd: run.costUsd,
        toolCalls: run.toolCalls,
        modelCalls: run.modelCalls,
        simulated: run.simulated,
        summary: run.summary,
        errorCode: run.errorCode ?? null,
        parentRunId: run.parentRunId
      },
      steps: buildSteps(checkpointRows.map((c) => c.summary), state),
      events: eventRows.map((e) => ({ ...e, occurredAt: iso(e.occurredAt)! })),
      eventsTotal: run.eventsTotal,
      instructions: instructionRows.map((i) => ({ id: i.id, text: i.text, createdByActorId: i.createdByActorId, createdAt: iso(i.createdAt)!, consumedAt: iso(i.consumedAt), consumedAtStep: i.consumedAtStep })),
      approvals: approvalRows.map((a) => ({ ...a, createdAt: iso(a.createdAt)!, operatorMayDecide: operatorMayDecide(a.approverRole) })),
      incidents: incidentRows.map((i) => ({ ...i, createdAt: iso(i.createdAt)! })),
      task: taskRows[0] ?? null,
      childRuns: childRows.map((c) => ({ id: c.id, agentName: c.agentName, state: c.state as LiveRunState }))
    };
  });
}
