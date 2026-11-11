"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { agencyContext, operatorContext, schema, writeAudit, type AgencyContext, type Tx } from "@sbos/db";
import { createRun, createTask, decideApproval, giveFeedback, queueRunInstruction, setTaskState, transitionRun, type JobBackend } from "@sbos/core";
import { getDb } from "../db";
import { getJobs } from "../jobs";
import { errorMessage, withNotice } from "../format";
import { requireOperatorContext } from "../request-context";
import { STOPPABLE_RUN_STATES, operatorMayDecide, type RunState } from "./queries";

/**
 * Operator write actions (M1-08, M1-09). Reads in Mission Control use the operator role, which cannot
 * write tenant tables. A write therefore runs as the signed-in operator in AGENCY scope inside one tenant
 * (`agencyContext({ tenantId, ... })`): `sbos_app` role, `app.actor_scope = 'agency'`, `app.tenant_id` set,
 * so RLS still pins the transaction to that one tenant. Every action writes an audit row in the same
 * transaction, then redirects back with `?ok=` or `?error=` so the page can show the outcome without client JS.
 */
const { agentInstances, agentRuns, schedules, incidents, approvals, agentTasks } = schema;

const TASK_PRIORITIES = ["critical", "high", "medium", "low"] as const;
type TaskPriority = (typeof TASK_PRIORITIES)[number];
const FEEDBACK_KINDS = ["correction", "approval", "rejection", "clarification", "instruction"] as const;
type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

function field(form: FormData, name: string, options: { required?: boolean; max?: number } = {}): string {
  const raw = form.get(name);
  const value = typeof raw === "string" ? raw.trim() : "";
  if (options.required && value.length === 0) throw new Error(`${name} is required`);
  if (options.max && value.length > options.max) throw new Error(`${name} is longer than ${options.max} characters`);
  return value;
}

function uuidField(form: FormData, name: string): string {
  const v = field(form, name, { required: true });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new Error(`${name} must be a UUID`);
  return v;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${label} must be one of ${allowed.join(", ")}`);
}

/** Runs `fn` as the operator inside one tenant, in agency scope, with the job backend available. */
async function tenantWrite<T>(tenantId: string, fn: (tx: Tx, ctx: AgencyContext, jobs: JobBackend) => Promise<T>): Promise<T> {
  const op = await requireOperatorContext();
  const ctx = agencyContext({ tenantId, actorType: "user", actorId: op.actorId, roles: op.roles });
  const jobs = await getJobs();
  return getDb().withContext(ctx, (tx) => fn(tx, ctx, jobs));
}

/** Common tail: revalidate the page and redirect with the outcome. Called outside try/catch because redirect() throws. */
function finish(returnTo: string, outcome: { ok?: string; error?: string }): never {
  revalidatePath(returnTo.split("?")[0] ?? returnTo);
  revalidatePath("/mission-control");
  redirect(withNotice(returnTo, outcome));
}

function returnPath(form: FormData, fallback: string): string {
  const v = field(form, "returnTo");
  return v.startsWith("/") && !v.startsWith("//") ? v : fallback;
}

// Agent Detail actions --------------------------------------------------------------------------

export async function assignTaskAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, "/mission-control/agents");
  let outcome: { ok?: string; error?: string };
  try {
    const tenantId = uuidField(form, "tenantId");
    const agentInstanceId = uuidField(form, "agentInstanceId");
    const title = field(form, "title", { required: true, max: 200 });
    const instruction = field(form, "instruction", { required: true, max: 4000 });
    const priority = oneOf<TaskPriority>(field(form, "priority") || "medium", TASK_PRIORITIES, "priority");
    const result = await tenantWrite(tenantId, async (tx, ctx, jobs) => {
      const [instance] = await tx.select({ id: agentInstances.id, state: agentInstances.state }).from(agentInstances).where(eq(agentInstances.id, agentInstanceId));
      if (!instance) throw new Error("agent instance not found in this tenant");
      if (instance.state === "paused" || instance.state === "disabled") throw new Error(`agent is ${instance.state}; resume it before assigning work`);
      const taskId = await createTask(tx, ctx, { tenantId, agentInstanceId, title, instruction, priority, createdBy: { actorType: "user", actorId: ctx.actorId }, metadata: { source: "mission_control" } });
      const { runId } = await createRun(tx, ctx, jobs, { tenantId, agentInstanceId, trigger: "command", triggerRef: `operator:${ctx.actorId}`, taskId });
      await writeAudit(tx, ctx, { action: "operator.task_assigned", entityType: "agent_task", entityId: taskId, after: { agentInstanceId, runId, priority } });
      return { taskId, runId };
    });
    outcome = { ok: `Task created and run ${result.runId.slice(0, 8)} queued (trigger: command).` };
  } catch (err) {
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function giveFeedbackAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, "/mission-control/agents");
  let outcome: { ok?: string; error?: string };
  try {
    const tenantId = uuidField(form, "tenantId");
    const agentInstanceId = uuidField(form, "agentInstanceId");
    const kind = oneOf<FeedbackKind>(field(form, "kind", { required: true }), FEEDBACK_KINDS, "kind");
    const message = field(form, "message", { required: true, max: 2000 });
    const runIdRaw = field(form, "runId");
    const runId = runIdRaw ? uuidField(form, "runId") : null;
    const shouldUpdateSkill = form.get("shouldUpdateSkill") === "on";
    await tenantWrite(tenantId, async (tx, ctx) => {
      // giveFeedback writes the audit row (agent_feedback.given).
      await giveFeedback(tx, ctx, { tenantId, agentInstanceId, runId, kind, message, shouldUpdateSkill });
    });
    outcome = { ok: `Feedback (${kind}) recorded.` };
  } catch (err) {
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function setAgentStateAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, "/mission-control/agents");
  let outcome: { ok?: string; error?: string };
  try {
    const tenantId = uuidField(form, "tenantId");
    const agentInstanceId = uuidField(form, "agentInstanceId");
    const target = oneOf(field(form, "state", { required: true }), ["paused", "idle"] as const, "state");
    await tenantWrite(tenantId, async (tx, ctx) => {
      const [before] = await tx.select({ state: agentInstances.state }).from(agentInstances).where(eq(agentInstances.id, agentInstanceId));
      if (!before) throw new Error("agent instance not found in this tenant");
      if (target === "idle" && before.state !== "paused") throw new Error(`agent is ${before.state}, only a paused agent can be resumed`);
      if (target === "paused" && (before.state === "paused" || before.state === "disabled")) throw new Error(`agent is already ${before.state}`);
      await tx.update(agentInstances).set({ state: target }).where(eq(agentInstances.id, agentInstanceId));
      await writeAudit(tx, ctx, { action: target === "paused" ? "agent_instance.paused" : "agent_instance.resumed", entityType: "agent_instance", entityId: agentInstanceId, before: { state: before.state }, after: { state: target } });
    });
    outcome = { ok: target === "paused" ? "Agent paused. New runs for this agent are refused by the worker until it is resumed." : "Agent resumed." };
  } catch (err) {
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function runNowAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, "/mission-control/agents");
  let outcome: { ok?: string; error?: string };
  try {
    const tenantId = uuidField(form, "tenantId");
    const agentInstanceId = uuidField(form, "agentInstanceId");
    const result = await tenantWrite(tenantId, async (tx, ctx, jobs) => {
      const [instance] = await tx.select({ state: agentInstances.state }).from(agentInstances).where(eq(agentInstances.id, agentInstanceId));
      if (!instance) throw new Error("agent instance not found in this tenant");
      if (instance.state === "paused" || instance.state === "disabled") throw new Error(`agent is ${instance.state}; resume it first`);
      // createRun writes the audit row (agent_run.created) and enqueues the job.
      return createRun(tx, ctx, jobs, { tenantId, agentInstanceId, trigger: "command", triggerRef: `operator:${ctx.actorId}` });
    });
    outcome = { ok: `Run ${result.runId.slice(0, 8)} queued (trigger: command). The worker picks it up within a few seconds.` };
  } catch (err) {
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function stopRunAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, "/mission-control/runs");
  let outcome: { ok?: string; error?: string };
  try {
    const tenantId = uuidField(form, "tenantId");
    const runId = uuidField(form, "runId");
    await tenantWrite(tenantId, async (tx, ctx) => {
      const [run] = await tx.select({ state: agentRuns.state, taskId: agentRuns.taskId }).from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, tenantId)));
      if (!run) throw new Error("run not found in this tenant");
      if (!(STOPPABLE_RUN_STATES as readonly string[]).includes(run.state)) throw new Error(`run is ${run.state} and cannot be stopped`);
      await transitionRun(tx, { tenantId, runId, to: "cancelled", summary: "cancelled by operator", payload: { by: ctx.actorId } });
      if (run.taskId) await setTaskState(tx, tenantId, run.taskId, "cancelled");
      await writeAudit(tx, ctx, { action: "agent_run.cancelled", entityType: "agent_run", entityId: runId, before: { state: run.state }, after: { state: "cancelled" } });
    });
    outcome = { ok: `Run ${runId.slice(0, 8)} cancelled. A worker already executing it stops at its next checkpoint.` };
  } catch (err) {
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

/**
 * Queues an operator instruction for a run that is still alive (ADR-024). The worker reads pending instructions at
 * its next checkpoint and adds them to the model prompt as operator guidance; it never grants new tools or scopes.
 * `queueRunInstruction` writes the note event and the audit row; the database trigger refuses agents and terminal runs.
 */
export async function instructRunAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, "/mission-control/live");
  let outcome: { ok?: string; error?: string };
  try {
    const tenantId = uuidField(form, "tenantId");
    const runId = uuidField(form, "runId");
    const text = field(form, "text", { required: true, max: 2000 });
    await tenantWrite(tenantId, async (tx, ctx) => {
      await queueRunInstruction(tx, ctx, { tenantId, runId, text });
    });
    outcome = { ok: `Instruction queued for run ${runId.slice(0, 8)}. The worker applies it at the run's next checkpoint.` };
  } catch (err) {
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

// Approvals -------------------------------------------------------------------------------------

export async function decideApprovalAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, "/mission-control/approvals");
  let outcome: { ok?: string; error?: string };
  try {
    const tenantId = uuidField(form, "tenantId");
    const approvalId = uuidField(form, "approvalId");
    const decision = oneOf(field(form, "decision", { required: true }), ["approved", "rejected"] as const, "decision");
    const note = field(form, "note", { max: 1000 });
    await tenantWrite(tenantId, async (tx, ctx, jobs) => {
      const [row] = await tx.select({ approverRole: approvals.approverRole, state: approvals.state }).from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.tenantId, tenantId)));
      if (!row) throw new Error("approval not found in this tenant");
      if (!operatorMayDecide(row.approverRole)) throw new Error(`this approval is for role ${row.approverRole}; it is decided in the client workspace`);
      if (!ctx.roles.includes(row.approverRole) && !ctx.roles.includes("superadmin")) throw new Error(`your roles (${ctx.roles.join(", ")}) do not include ${row.approverRole}`);
      // decideApproval writes the audit row and re-queues or cancels the suspended run; the DB trigger blocks self-approval and double decisions.
      await decideApproval(tx, ctx, jobs, { tenantId, approvalId, decision, decidedBy: { actorId: ctx.actorId, userId: null }, note: note || undefined });
    });
    outcome = { ok: `Approval ${approvalId.slice(0, 8)} ${decision}.` };
  } catch (err) {
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

// Schedules -------------------------------------------------------------------------------------

export async function toggleScheduleAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, "/mission-control/schedules");
  let outcome: { ok?: string; error?: string };
  try {
    const tenantId = uuidField(form, "tenantId");
    const scheduleId = uuidField(form, "scheduleId");
    const enabled = field(form, "enabled", { required: true }) === "true";
    await tenantWrite(tenantId, async (tx, ctx) => {
      const [before] = await tx.select({ enabled: schedules.enabled, agentInstanceId: schedules.agentInstanceId }).from(schedules).where(and(eq(schedules.id, scheduleId), eq(schedules.tenantId, tenantId)));
      if (!before) throw new Error("schedule not found in this tenant");
      if (before.enabled === enabled) throw new Error(`schedule is already ${enabled ? "enabled" : "disabled"}`);
      // next_run_at is recomputed by the worker's reconcile loop (within one minute); clear it when disabling so the stall alarm stays quiet.
      await tx.update(schedules).set({ enabled, ...(enabled ? {} : { nextRunAt: null }) }).where(eq(schedules.id, scheduleId));
      if (!enabled) await tx.update(agentInstances).set({ nextScheduledRunAt: null }).where(eq(agentInstances.id, before.agentInstanceId));
      await writeAudit(tx, ctx, { action: enabled ? "schedule.enabled" : "schedule.disabled", entityType: "schedule", entityId: scheduleId, before: { enabled: before.enabled }, after: { enabled } });
    });
    outcome = { ok: enabled ? "Schedule enabled. The worker registers it with pg-boss within one minute." : "Schedule disabled. The worker removes the pg-boss schedule within one minute." };
  } catch (err) {
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

// Incidents (operator role has UPDATE on state, acknowledged_by, resolved_at) -------------------

export async function incidentAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, "/mission-control/errors");
  let outcome: { ok?: string; error?: string };
  try {
    const incidentId = uuidField(form, "incidentId");
    const action = oneOf(field(form, "action", { required: true }), ["acknowledge", "resolve"] as const, "action");
    const op = await requireOperatorContext();
    const ctx = operatorContext({ actorType: "user", actorId: op.actorId, roles: op.roles });
    await getDb().withContext(ctx, async (tx) => {
      const [before] = await tx.select({ state: incidents.state }).from(incidents).where(eq(incidents.id, incidentId));
      if (!before) throw new Error("incident not found");
      if (before.state === "resolved") throw new Error("incident is already resolved");
      if (action === "acknowledge" && before.state === "acknowledged") throw new Error("incident is already acknowledged");
      const patch = action === "acknowledge" ? { state: "acknowledged" as const, acknowledgedBy: op.actorId } : { state: "resolved" as const, acknowledgedBy: op.actorId, resolvedAt: new Date() };
      await tx.update(incidents).set(patch).where(eq(incidents.id, incidentId));
      await writeAudit(tx, ctx, { action: `incident.${action === "acknowledge" ? "acknowledged" : "resolved"}`, entityType: "incident", entityId: incidentId, before: { state: before.state }, after: { state: patch.state } });
    });
    outcome = { ok: `Incident ${incidentId.slice(0, 8)} ${action === "acknowledge" ? "acknowledged" : "resolved"}.` };
  } catch (err) {
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

/** Cancels every open run of one agent instance (used by the Pause form's optional checkbox). */
export async function cancelOpenRunsAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, "/mission-control/agents");
  let outcome: { ok?: string; error?: string };
  try {
    const tenantId = uuidField(form, "tenantId");
    const agentInstanceId = uuidField(form, "agentInstanceId");
    const count = await tenantWrite(tenantId, async (tx, ctx) => {
      const open = await tx
        .select({ id: agentRuns.id, state: agentRuns.state, taskId: agentRuns.taskId })
        .from(agentRuns)
        .where(and(eq(agentRuns.agentInstanceId, agentInstanceId), inArray(agentRuns.state, [...STOPPABLE_RUN_STATES] as RunState[])));
      for (const r of open) {
        await transitionRun(tx, { tenantId, runId: r.id, to: "cancelled", summary: "cancelled by operator (bulk)", payload: { by: ctx.actorId } });
        if (r.taskId) await tx.update(agentTasks).set({ state: "cancelled" }).where(eq(agentTasks.id, r.taskId));
        await writeAudit(tx, ctx, { action: "agent_run.cancelled", entityType: "agent_run", entityId: r.id, before: { state: r.state }, after: { state: "cancelled" } });
      }
      return open.length;
    });
    outcome = { ok: `${count} open run(s) cancelled.` };
  } catch (err) {
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}
