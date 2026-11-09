"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { schema, type TenantContext } from "@sbos/db";
import { activateActionTask, createActionTask, createRun, createTask, decideApproval, setActionTaskState, setOpportunityState } from "@sbos/core";
import { getDb } from "../db";
import { getJobs } from "../jobs";
import { errorMessage, withNotice } from "../format";
import { getPrincipal, requireTenantContext, type ResolvedTenant } from "../request-context";

/**
 * Management Action Center and CEO Dashboard write actions (M3-08, M3-04). Each action resolves the tenant
 * context from the session, checks the UI-level role rule, and calls the @sbos/core service inside
 * `withContext()`. The database enforces the hard rules: RLS, `enforce_opportunity_approval`,
 * `enforce_action_task_approval` and the approval trigger (no self-approval, no double decision).
 * A refusal from Postgres is shown through `?error=` on the redirect.
 */
const { opportunities, actionTasks, agentInstances, approvals } = schema;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}

function uuid(form: FormData, name: string): string {
  const v = text(form, name);
  if (!UUID_RE.test(v)) throw new Error(`${name} must be a UUID`);
  return v;
}

interface Resolved {
  slug: string;
  access: ResolvedTenant;
  ctx: TenantContext;
  /** public.users id of the signed-in user (owner comparisons, approval decided_by). */
  publicUserId: string;
}

async function resolveWrite(form: FormData): Promise<Resolved> {
  const slug = text(form, "slug");
  if (!SLUG_RE.test(slug)) throw new Error("invalid workspace");
  const access = await requireTenantContext(slug);
  if (!access) throw new Error("workspace not found");
  if (access.viaGrant) throw new Error("a break-glass grant is read-only; decisions are taken by the client's own roles");
  const principal = await getPrincipal();
  if (!principal) throw new Error("not signed in");
  return { slug, access, ctx: access.ctx, publicUserId: principal.data.publicUserId };
}

function safeReturn(form: FormData, fallback: string): string {
  const requested = text(form, "returnTo");
  return requested.startsWith("/") && !requested.startsWith("//") ? requested : fallback;
}

function finish(slug: string | null, returnTo: string, outcome: { ok?: string; error?: string }): never {
  revalidatePath(returnTo.split("?")[0] ?? returnTo);
  if (slug) for (const p of ["/actions", "/dashboard", "/x-ray", "/approvals", "/briefing"]) revalidatePath(`/c/${slug}${p}`);
  redirect(withNotice(returnTo, outcome));
}

function isRedirect(err: unknown): boolean {
  return typeof err === "object" && err !== null && "digest" in err && typeof (err as { digest?: unknown }).digest === "string" && (err as { digest: string }).digest.startsWith("NEXT_REDIRECT");
}

function requireClientAdmin(ctx: TenantContext, what: string): void {
  if (!ctx.roles.includes("client_admin")) throw new Error(`${what} requires the client_admin role; your roles: ${ctx.roles.join(", ")}`);
}

// Opportunities --------------------------------------------------------------------------------------

/** Approve or reject the approval of a proposed opportunity, then move the opportunity to approved or rejected. */
export async function decideOpportunityAction(form: FormData): Promise<void> {
  const slugGuess = text(form, "slug");
  const returnTo = safeReturn(form, SLUG_RE.test(slugGuess) ? `/c/${slugGuess}/actions` : "/");
  let outcome: { ok?: string; error?: string };
  try {
    const { slug, ctx, publicUserId } = await resolveWrite(form);
    requireClientAdmin(ctx, "deciding an opportunity");
    const opportunityId = uuid(form, "opportunityId");
    const decision = text(form, "decision");
    if (decision !== "approved" && decision !== "rejected") throw new Error("decision must be approved or rejected");
    const note = text(form, "note").slice(0, 1000) || undefined;
    const jobs = await getJobs();
    await getDb().withContext(ctx, async (tx) => {
      const [opp] = await tx.select({ id: opportunities.id, state: opportunities.state, approvalId: opportunities.approvalId, requiresApproval: opportunities.requiresApproval }).from(opportunities).where(eq(opportunities.id, opportunityId));
      if (!opp) throw new Error("opportunity not found in this workspace");
      if (opp.state !== "proposed") throw new Error(`opportunity is ${opp.state}; only a proposed opportunity can be decided`);
      if (!opp.approvalId) throw new Error("opportunity has no approval request attached");
      const [appr] = await tx.select({ state: approvals.state, approverRole: approvals.approverRole }).from(approvals).where(eq(approvals.id, opp.approvalId));
      if (!appr) throw new Error("approval not found");
      if (appr.state === "pending") {
        if (!ctx.roles.includes(appr.approverRole)) throw new Error(`this approval requires the ${appr.approverRole} role`);
        await decideApproval(tx, ctx, jobs, { tenantId: ctx.tenantId, approvalId: opp.approvalId, decision, decidedBy: { userId: publicUserId, actorId: ctx.actorId }, note });
      } else if (appr.state !== decision) {
        throw new Error(`approval is already ${appr.state}`);
      }
      // The DB trigger refuses `approved` unless the linked approval is approved.
      await setOpportunityState(tx, ctx, { tenantId: ctx.tenantId, opportunityId, state: decision });
    });
    outcome = { ok: decision === "approved" ? "Opportunity approved. You can now create an action task for it below; the task reuses this approval." : "Opportunity rejected. No task can be created from it." };
    return finish(slug, returnTo, outcome);
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(null, returnTo, outcome);
}

// Action tasks ---------------------------------------------------------------------------------------

export async function createActionTaskAction(form: FormData): Promise<void> {
  const slugGuess = text(form, "slug");
  const returnTo = safeReturn(form, SLUG_RE.test(slugGuess) ? `/c/${slugGuess}/actions` : "/");
  let outcome: { ok?: string; error?: string };
  try {
    const { slug, ctx } = await resolveWrite(form);
    requireClientAdmin(ctx, "creating an action task");
    const opportunityId = uuid(form, "opportunityId");
    const title = text(form, "title").slice(0, 200);
    const issue = text(form, "issue").slice(0, 2000);
    const proposedAction = text(form, "proposedAction").slice(0, 4000);
    const ownerRole = text(form, "ownerRole").slice(0, 64);
    if (!title || !issue || !proposedAction || !ownerRole) throw new Error("title, issue, proposed action and owner role are required");
    const ownerUserRaw = text(form, "ownerUserId");
    const ownerUserId = ownerUserRaw ? uuid(form, "ownerUserId") : null;
    const dueRaw = text(form, "dueAt");
    const dueAt = dueRaw ? new Date(`${dueRaw}T17:00:00Z`) : null;
    if (dueAt && Number.isNaN(dueAt.getTime())) throw new Error("due date is invalid");
    const verifyAfterDays = Math.min(90, Math.max(1, Number(text(form, "verifyAfterDays") || "7") || 7));
    const jobs = await getJobs();
    const result = await getDb().withContext(ctx, async (tx) => {
      const [opp] = await tx.select({ id: opportunities.id, state: opportunities.state, approvalId: opportunities.approvalId, sourceIds: opportunities.sourceIds }).from(opportunities).where(eq(opportunities.id, opportunityId));
      if (!opp) throw new Error("opportunity not found in this workspace");
      if (opp.state !== "approved" && opp.state !== "in_progress") throw new Error(`opportunity is ${opp.state}; tasks are created from an approved opportunity only`);
      if (ownerUserId) {
        const [m] = await tx.select({ id: schema.memberships.id }).from(schema.memberships).where(and(eq(schema.memberships.userId, ownerUserId), eq(schema.memberships.tenantId, ctx.tenantId)));
        if (!m) throw new Error("owner must be a member of this workspace");
      }
      const [perf] = await tx.select({ id: agentInstances.id, state: agentInstances.state }).from(agentInstances).where(sql`${agentInstances.serviceIdentity} like 'agent:performance-agent:%'`).limit(1);
      const { taskId } = await createActionTask(tx, ctx, { tenantId: ctx.tenantId, title, issue, proposedAction, opportunityId, ownerRole, dueAt, sourceIds: opp.sourceIds, approvalId: opp.approvalId });
      const act = await activateActionTask(tx, ctx, jobs, { tenantId: ctx.tenantId, taskId, ownerUserId, verifyAfterDays, verificationAgentInstanceId: perf?.id ?? null });
      if (opp.state === "approved") await setOpportunityState(tx, ctx, { tenantId: ctx.tenantId, opportunityId, state: "in_progress" });
      return { taskId, scheduleId: act.scheduleId, perf: perf ?? null };
    });
    outcome = { ok: result.scheduleId ? `Task ${result.taskId.slice(0, 8)} assigned; the Performance agent verifies it in ${verifyAfterDays} day(s) (schedule ${result.scheduleId.slice(0, 8)}).` : `Task ${result.taskId.slice(0, 8)} assigned. No Performance agent instance exists in this workspace, so no verification schedule was created.` };
    return finish(slug, returnTo, outcome);
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(null, returnTo, outcome);
}

const OWNER_STATES = ["in_progress"] as const;
const ADMIN_STATES = ["closed", "escalated"] as const;

export async function setActionTaskStateAction(form: FormData): Promise<void> {
  const slugGuess = text(form, "slug");
  const returnTo = safeReturn(form, SLUG_RE.test(slugGuess) ? `/c/${slugGuess}/actions` : "/");
  let outcome: { ok?: string; error?: string };
  try {
    const { slug, ctx, publicUserId } = await resolveWrite(form);
    const taskId = uuid(form, "taskId");
    const state = text(form, "state");
    const note = text(form, "note").slice(0, 2000) || undefined;
    const isOwnerState = (OWNER_STATES as readonly string[]).includes(state);
    const isAdminState = (ADMIN_STATES as readonly string[]).includes(state);
    if (!isOwnerState && !isAdminState) throw new Error("state must be in_progress, closed or escalated");
    await getDb().withContext(ctx, async (tx) => {
      const [task] = await tx.select({ state: actionTasks.state, ownerUserId: actionTasks.ownerUserId, ownerRole: actionTasks.ownerRole }).from(actionTasks).where(eq(actionTasks.id, taskId));
      if (!task) throw new Error("action task not found in this workspace");
      const isAdmin = ctx.roles.includes("client_admin");
      const isOwner = task.ownerUserId === publicUserId || (task.ownerUserId === null && task.ownerRole !== null && ctx.roles.includes(task.ownerRole));
      if (isAdminState && !isAdmin) throw new Error(`${state} requires the client_admin role; your roles: ${ctx.roles.join(", ")}`);
      if (isOwnerState && !isOwner && !isAdmin) throw new Error("only the task owner (or client_admin) can start the task");
      if (isOwnerState && !["assigned", "approved", "verifying", "escalated"].includes(task.state)) throw new Error(`task is ${task.state}; it cannot be started from that state`);
      if (state === "closed" && !note) throw new Error("closing a task needs a verification note (what evidence shows it was done)");
      if (task.state === "closed") throw new Error("task is already closed");
      await setActionTaskState(tx, ctx, { tenantId: ctx.tenantId, taskId, state: state as (typeof schema.actionTaskState.enumValues)[number], note });
    });
    outcome = { ok: state === "in_progress" ? "Task marked in progress." : state === "closed" ? "Task closed with its verification note." : "Task escalated to the client admin." };
    return finish(slug, returnTo, outcome);
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(null, returnTo, outcome);
}

// CEO Dashboard: regenerate -------------------------------------------------------------------------

/** Queues a CEO Intelligence run (task + run) in tenant context; the worker publishes a new dashboard version. */
export async function regenerateDashboardAction(form: FormData): Promise<void> {
  const slugGuess = text(form, "slug");
  const returnTo = safeReturn(form, SLUG_RE.test(slugGuess) ? `/c/${slugGuess}/dashboard` : "/");
  let outcome: { ok?: string; error?: string };
  try {
    const { slug, ctx } = await resolveWrite(form);
    requireClientAdmin(ctx, "regenerating the dashboard");
    const jobs = await getJobs();
    const r = await getDb().withContext(ctx, async (tx) => {
      const [inst] = await tx.select({ id: agentInstances.id, state: agentInstances.state, name: agentInstances.name }).from(agentInstances).where(sql`${agentInstances.serviceIdentity} like 'agent:ceo-intelligence:%'`).limit(1);
      if (!inst) throw new Error("no CEO Intelligence agent instance is active for this workspace; ask your consultant to activate it");
      if (inst.state === "paused" || inst.state === "disabled") throw new Error(`the CEO Intelligence agent is ${inst.state}`);
      const taskId = await createTask(tx, ctx, { tenantId: ctx.tenantId, agentInstanceId: inst.id, title: "Regenerate CEO dashboard", instruction: "Refresh the KPI registry observations and publish a new CEO dashboard specification.", priority: "high", createdBy: { actorType: "user", actorId: ctx.actorId }, metadata: { source: "client_dashboard" } });
      return createRun(tx, ctx, jobs, { tenantId: ctx.tenantId, agentInstanceId: inst.id, trigger: "command", triggerRef: `client_admin:${ctx.actorId}`, taskId });
    });
    outcome = { ok: `Run ${r.runId.slice(0, 8)} queued for the CEO Intelligence agent. Reload this page in a few seconds; a new version appears when the worker finishes.` };
    return finish(slug, returnTo, outcome);
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(null, returnTo, outcome);
}
