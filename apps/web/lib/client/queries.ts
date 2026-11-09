import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type TenantContext } from "@sbos/db";
import { getDb } from "../db";

/**
 * Client Workspace reads. Every function runs in TENANT context (`sbos_app` role, `app.tenant_id` set),
 * so Row-Level Security limits each query to the caller's tenant and content columns are visible:
 * this is the client's own data. The caller obtains `ctx` from `requireTenantContext(slug)`.
 */
const { tenants, approvals, approvedActions, agentRuns, agentInstances, agentDefinitions, agentTasks, questions, interviewRounds } = schema;

const num = (expr: ReturnType<typeof sql>) => sql<number>`${expr}`.mapWith(Number);

export interface TenantHeader {
  id: string;
  slug: string;
  name: string;
  kind: string;
}

export async function getTenantHeader(ctx: TenantContext): Promise<TenantHeader | null> {
  return getDb().withContext(ctx, async (tx) => {
    const [t] = await tx.select({ id: tenants.id, slug: tenants.slug, name: tenants.name, kind: tenants.kind }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    return t ?? null;
  });
}

export interface ClientApprovalRow {
  id: string;
  runId: string | null;
  taskId: string | null;
  subjectType: string;
  subjectId: string | null;
  requestedByActorType: string;
  requestedByActorId: string;
  approverRole: string;
  risk: string;
  summary: string;
  rationale: string;
  blocking: boolean;
  state: string;
  decidedByActorId: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

const approvalColumns = {
  id: approvals.id,
  runId: approvals.runId,
  taskId: approvals.taskId,
  subjectType: approvals.subjectType,
  subjectId: approvals.subjectId,
  requestedByActorType: approvals.requestedByActorType,
  requestedByActorId: approvals.requestedByActorId,
  approverRole: approvals.approverRole,
  risk: approvals.risk,
  summary: approvals.summary,
  rationale: approvals.rationale,
  blocking: approvals.blocking,
  state: approvals.state,
  decidedByActorId: approvals.decidedByActorId,
  decidedAt: approvals.decidedAt,
  decisionNote: approvals.decisionNote,
  expiresAt: approvals.expiresAt,
  createdAt: approvals.createdAt
};

export async function listClientApprovals(ctx: TenantContext): Promise<{ pending: ClientApprovalRow[]; decided: ClientApprovalRow[] }> {
  return getDb().withContext(ctx, async (tx) => {
    const pending = await tx.select(approvalColumns).from(approvals).where(eq(approvals.state, "pending")).orderBy(approvals.createdAt);
    const decided = await tx.select(approvalColumns).from(approvals).where(sql`${approvals.state} <> 'pending'`).orderBy(desc(approvals.decidedAt), desc(approvals.updatedAt)).limit(20);
    return { pending, decided };
  });
}

export interface ClientQuestion {
  id: string;
  roundId: string | null;
  runId: string | null;
  department: string;
  recipientRole: string;
  questionText: string;
  reason: string;
  evidenceGap: string;
  priority: string;
  answerType: string;
  options: string[];
  state: string;
  confidence: number;
  createdAt: Date;
}

const questionColumns = {
  id: questions.id,
  roundId: questions.roundId,
  runId: questions.runId,
  department: questions.department,
  recipientRole: questions.recipientRole,
  questionText: questions.questionText,
  reason: questions.reason,
  evidenceGap: questions.evidenceGap,
  priority: questions.priority,
  answerType: questions.answerType,
  options: questions.options,
  state: questions.state,
  confidence: num(sql`${questions.confidence}`),
  createdAt: questions.createdAt
};

export interface ClientApprovalDetail {
  approval: ClientApprovalRow;
  run: { id: string; state: string; trigger: string; summary: string | null; simulated: boolean; agentName: string; startedAt: Date | null; finishedAt: Date | null } | null;
  action: { id: string; actionType: string; risk: string; executedAt: Date | null; payload: unknown } | null;
  questions: ClientQuestion[];
}

export async function getClientApproval(ctx: TenantContext, approvalId: string): Promise<ClientApprovalDetail | null> {
  return getDb().withContext(ctx, async (tx) => {
    const [approval] = await tx.select(approvalColumns).from(approvals).where(eq(approvals.id, approvalId));
    if (!approval) return null;
    const [run] = approval.runId
      ? await tx
          .select({ id: agentRuns.id, state: agentRuns.state, trigger: agentRuns.trigger, summary: agentRuns.summary, simulated: agentRuns.simulated, agentName: agentInstances.name, startedAt: agentRuns.startedAt, finishedAt: agentRuns.finishedAt })
          .from(agentRuns)
          .innerJoin(agentInstances, eq(agentInstances.id, agentRuns.agentInstanceId))
          .where(eq(agentRuns.id, approval.runId))
      : [];
    const [action] =
      approval.subjectType === "approved_action" && approval.subjectId
        ? await tx.select({ id: approvedActions.id, actionType: approvedActions.actionType, risk: approvedActions.risk, executedAt: approvedActions.executedAt, payload: approvedActions.payload }).from(approvedActions).where(eq(approvedActions.id, approval.subjectId))
        : [];
    // The subject of a Discovery approval is the publication of the questions drafted by the same run.
    const qs = approval.runId ? await tx.select(questionColumns).from(questions).where(eq(questions.runId, approval.runId)).orderBy(questions.priority, questions.createdAt) : [];
    return { approval, run: run ?? null, action: action ?? null, questions: qs };
  });
}

export interface InboxRound {
  round: { id: string; roundNumber: number; department: string | null; rationale: string; createdAt: Date } | null;
  questions: ClientQuestion[];
}

/** Open and draft questions grouped by interview round, newest round first. */
export async function listInboxRounds(ctx: TenantContext): Promise<{ rounds: InboxRound[]; counts: { open: number; draft: number; answered: number } }> {
  return getDb().withContext(ctx, async (tx) => {
    const rows = await tx.select(questionColumns).from(questions).where(inArray(questions.state, ["open", "draft"])).orderBy(desc(questions.createdAt));
    const countRows = await tx.select({ state: questions.state, n: num(sql`count(*)`) }).from(questions).groupBy(questions.state);
    const counts = { open: 0, draft: 0, answered: 0 };
    for (const c of countRows) {
      if (c.state === "open") counts.open = c.n;
      else if (c.state === "draft") counts.draft = c.n;
      else if (c.state === "answered") counts.answered = c.n;
    }
    const roundIds = [...new Set(rows.map((r) => r.roundId).filter((x): x is string => x !== null))];
    const roundRows = roundIds.length
      ? await tx
          .select({ id: interviewRounds.id, roundNumber: interviewRounds.roundNumber, department: interviewRounds.department, rationale: interviewRounds.rationale, createdAt: interviewRounds.createdAt })
          .from(interviewRounds)
          .where(inArray(interviewRounds.id, roundIds))
          .orderBy(desc(interviewRounds.roundNumber))
      : [];
    const byRound = new Map<string | null, ClientQuestion[]>();
    for (const q of rows) {
      const list = byRound.get(q.roundId) ?? [];
      list.push(q);
      byRound.set(q.roundId, list);
    }
    const rounds: InboxRound[] = roundRows.map((r) => ({ round: r, questions: byRound.get(r.id) ?? [] }));
    const orphan = byRound.get(null);
    if (orphan && orphan.length > 0) rounds.push({ round: null, questions: orphan });
    return { rounds, counts };
  });
}

export interface ClientAgentCenter {
  instances: Array<{ id: string; name: string; state: string; definitionName: string; mission: string; model: string | null; defaultModel: string; lastRunAt: Date | null; nextScheduledRunAt: Date | null }>;
  runs: Array<{ id: string; agentName: string; trigger: string; state: string; summary: string | null; simulated: boolean; startedAt: Date | null; finishedAt: Date | null; createdAt: Date }>;
  pendingApprovals: number;
  openQuestions: number;
  openTasks: Array<{ id: string; title: string; priority: string; state: string; createdAt: Date }>;
}

export async function getClientAgentCenter(ctx: TenantContext): Promise<ClientAgentCenter> {
  return getDb().withContext(ctx, async (tx) => {
    const instances = await tx
      .select({ id: agentInstances.id, name: agentInstances.name, state: agentInstances.state, definitionName: agentDefinitions.name, mission: agentDefinitions.mission, model: agentInstances.model, defaultModel: agentDefinitions.defaultModel, lastRunAt: agentInstances.lastRunAt, nextScheduledRunAt: agentInstances.nextScheduledRunAt })
      .from(agentInstances)
      .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentInstances.definitionId))
      .orderBy(agentInstances.name);
    const runs = await tx
      .select({ id: agentRuns.id, agentName: agentInstances.name, trigger: agentRuns.trigger, state: agentRuns.state, summary: agentRuns.summary, simulated: agentRuns.simulated, startedAt: agentRuns.startedAt, finishedAt: agentRuns.finishedAt, createdAt: agentRuns.createdAt })
      .from(agentRuns)
      .innerJoin(agentInstances, eq(agentInstances.id, agentRuns.agentInstanceId))
      .orderBy(desc(agentRuns.createdAt))
      .limit(20);
    const [pending] = await tx.select({ n: num(sql`count(*)`) }).from(approvals).where(eq(approvals.state, "pending"));
    const [open] = await tx.select({ n: num(sql`count(*)`) }).from(questions).where(eq(questions.state, "open"));
    const openTasks = await tx
      .select({ id: agentTasks.id, title: agentTasks.title, priority: agentTasks.priority, state: agentTasks.state, createdAt: agentTasks.createdAt })
      .from(agentTasks)
      .where(and(inArray(agentTasks.state, ["open", "assigned", "in_progress", "waiting_input", "waiting_approval"])))
      .orderBy(desc(agentTasks.createdAt))
      .limit(20);
    return { instances, runs, pendingApprovals: pending?.n ?? 0, openQuestions: open?.n ?? 0, openTasks };
  });
}
