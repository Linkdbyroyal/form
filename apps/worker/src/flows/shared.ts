import { and, eq } from "drizzle-orm";
import { schema } from "@sbos/db";
import { RunFailure, agentWriteDocument, markActionExecuted, queueNotification, registerAction, requestApproval, setTaskState } from "@sbos/core";
import { QuestionRequestSchema } from "@sbos/contracts";
import type { FlowRuntime } from "./types";

const { questions, interviewRounds, approvedActions, approvals, memberships, agentRuns } = schema;

export interface QuestionDraft {
  department: string;
  recipient_role: "client_admin" | "department_manager";
  question_text: string;
  reason: string;
  evidence_gap: string;
  priority: "critical" | "high" | "medium" | "low";
  answer_type: string;
  options?: string[];
  confidence: number;
}

/** Validates drafts against the QuestionRequest contract and stores them as draft questions in a new interview round. */
export async function persistQuestionDrafts(rt: FlowRuntime, drafts: QuestionDraft[], rationale: string): Promise<{ roundId: string; roundNumber: number; questionIds: string[] }> {
  return rt.tx(async (tx) => {
    rt.gateway.authorize("questions.create");
    const [last] = await tx.select({ n: interviewRounds.roundNumber }).from(interviewRounds).orderBy(schema.interviewRounds.roundNumber).limit(1000);
    const all = await tx.select({ n: interviewRounds.roundNumber }).from(interviewRounds);
    const roundNumber = (all.reduce((m, r) => Math.max(m, r.n), 0) || 0) + 1;
    void last;
    const [round] = await tx.insert(interviewRounds).values({ tenantId: rt.tenant.id, runId: rt.run.id, roundNumber, rationale }).returning({ id: interviewRounds.id });
    const now = new Date().toISOString();
    const ids: string[] = [];
    for (const q of drafts) {
      const contract = QuestionRequestSchema.parse({ question_id: crypto.randomUUID(), tenant_id: rt.tenant.id, department: q.department, recipient_role: q.recipient_role, question_text: q.question_text, reason: q.reason, evidence_gap: q.evidence_gap, priority: q.priority, answer_type: q.answer_type, options: q.options, status: "draft", confidence: q.confidence, round_id: round!.id, depends_on: [], asked_by_agent_id: rt.instance.id, created_at: now });
      const [row] = await tx
        .insert(questions)
        .values({ id: contract.question_id, tenantId: rt.tenant.id, roundId: round!.id, runId: rt.run.id, department: q.department, recipientRole: q.recipient_role, questionText: q.question_text, reason: q.reason, evidenceGap: q.evidence_gap, priority: q.priority, answerType: q.answer_type, options: q.options ?? [], state: "draft", confidence: String(q.confidence), askedByAgentInstanceId: rt.instance.id })
        .returning({ id: questions.id });
      ids.push(row!.id);
    }
    await rt.event("question_created", `${ids.length} question(s) drafted in round ${roundNumber}`, { roundId: round!.id }, "confidential");
    return { roundId: round!.id, roundNumber, questionIds: ids };
  });
}

/** Writes a vault note through the tenant write-mode policy (draft or proposal). */
export async function writeVaultNote(rt: FlowRuntime, input: { path: string; title: string; frontmatter: Record<string, unknown>; body: string; changeNote: string }): Promise<{ documentId?: string; proposalId?: string }> {
  return rt.tx(async (tx) => {
    rt.gateway.authorize("vault.write_draft");
    const r = await agentWriteDocument(tx, rt.ctx, { tenantId: rt.tenant.id, path: input.path, title: input.title, frontmatter: { ...input.frontmatter, run_id: rt.run.id, agent: rt.definition.key, skill_version: rt.skill.version, simulated: rt.simulated }, bodyMarkdown: input.body, runId: rt.run.id, changeNote: input.changeNote });
    await rt.event("output_written", r.mode === "auto_draft" ? `vault document written (v${r.version}) at ${input.path}` : `vault change proposal created for ${input.path}`, { documentId: r.documentId ?? null, proposalId: r.proposalId ?? null, path: input.path });
    return { documentId: r.documentId, proposalId: r.proposalId };
  });
}

/**
 * Publishing questions to client staff is communication to the client (T3): register an action, request approval
 * from the client admin, notify, and suspend the run. The resume job continues with `publishQuestions`.
 */
export async function requestPublication(rt: FlowRuntime, input: { questionIds: string[]; roundId: string; roundNumber: number }): Promise<{ actionId: string; approvalId: string }> {
  return rt.tx(async (tx) => {
    rt.gateway.authorize("approvals.request");
    const actionId = await registerAction(tx, { tenantId: rt.tenant.id, runId: rt.run.id, actionType: "publish_questions", risk: "medium", payload: { questionIds: input.questionIds, roundId: input.roundId } });
    const { approvalId } = await requestApproval(tx, rt.ctx, {
      tenantId: rt.tenant.id,
      runId: rt.run.id,
      taskId: rt.run.taskId,
      subjectType: "approved_action",
      subjectId: actionId,
      requestedBy: { actorType: "agent", actorId: rt.instance.serviceIdentity },
      approverRole: "client_admin",
      risk: "medium",
      summary: `Publish ${input.questionIds.length} question(s) (round ${input.roundNumber}) from ${rt.definition.name}`,
      rationale: "Questions are sent to client staff; the client admin decides what reaches the organisation."
    });
    await tx.update(approvedActions).set({ approvalId }).where(eq(approvedActions.id, actionId));
    if (rt.run.taskId) await setTaskState(tx, rt.tenant.id, rt.run.taskId, "waiting_approval");
    const admins = await tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.tenantId, rt.tenant.id), eq(memberships.roleKey, "client_admin")));
    for (const a of admins) {
      await queueNotification(tx, rt.jobs, { tenantId: rt.tenant.id, channel: "email", template: "approval.requested", subject: `Approval requested: publish questions (${rt.definition.name})`, payload: { approvalId, tenantSlug: rt.tenant.slug, runId: rt.run.id }, recipientRole: "client_admin", recipientUserId: a.userId });
    }
    await queueNotification(tx, rt.jobs, { tenantId: rt.tenant.id, channel: "pumble", template: "approval.requested", subject: `Approval pending for ${rt.tenant.slug}: ${rt.definition.name} questions`, payload: { approvalId, tenantSlug: rt.tenant.slug, runId: rt.run.id } });
    return { actionId, approvalId };
  });
}

/** After approval: executes the gated action (DB trigger is the real gate) and opens the questions in the inbox. */
export async function publishQuestions(rt: FlowRuntime, input: { actionId: string; approvalId: string; roundId: string; questionIds: string[] }): Promise<void> {
  await rt.tx(async (tx) => {
    const [approval] = await tx.select().from(approvals).where(eq(approvals.id, input.approvalId));
    if (!approval || approval.state !== "approved") throw new RunFailure("policy", `approval ${input.approvalId} is ${approval?.state ?? "missing"}`);
    await markActionExecuted(tx, { tenantId: rt.tenant.id, actionId: input.actionId, result: { published: input.questionIds.length } });
    await tx.update(questions).set({ state: "open" }).where(and(eq(questions.roundId, input.roundId), eq(questions.state, "draft")));
    await rt.event("output_written", `${input.questionIds.length} question(s) published to the Interview Inbox`, { roundId: input.roundId });
    const recipients = await tx.select({ userId: memberships.userId, role: memberships.roleKey }).from(memberships).where(and(eq(memberships.tenantId, rt.tenant.id), eq(memberships.roleKey, "client_admin")));
    for (const r of recipients) {
      await queueNotification(tx, rt.jobs, { tenantId: rt.tenant.id, channel: "email", template: "questions.published", subject: "New questions are waiting for you", payload: { roundId: input.roundId, tenantSlug: rt.tenant.slug }, recipientRole: r.role, recipientUserId: r.userId });
    }
  });
}

export function questionsMarkdown(title: string, rationale: string, drafts: QuestionDraft[], rt: FlowRuntime): string {
  return [
    `# ${title}`,
    "",
    `> Status: draft questions awaiting publication approval. Source: agent run ${rt.run.id}. ${rt.simulated ? "Model: simulated (no API key)." : `Model: ${rt.model}.`}`,
    "",
    "## Rationale",
    rationale,
    "",
    "## Questions",
    ...drafts.map((q, i) => `${i + 1}. **[${q.priority}] ${q.department} to ${q.recipient_role}**: ${q.question_text}\n   - Why: ${q.reason}\n   - Evidence gap: ${q.evidence_gap}\n   - Answer type: ${q.answer_type}; confidence ${q.confidence}`)
  ].join("\n");
}

void agentRuns;
