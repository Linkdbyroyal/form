import { and, eq } from "drizzle-orm";
import { schema } from "@sbos/db";
import { setActionTaskState } from "@sbos/core";
import { VerificationDraftSchema, buildVerificationPrompt, verificationFixture, type TenantSnapshot, type VerificationDraft } from "@sbos/agents";
import type { BaseCheckpoint, Flow, StepOutcome } from "./types";
import { persistQuestionDrafts, publishQuestions, requestPublication } from "./shared";

interface Cp extends BaseCheckpoint {
  step: "generate" | "persist" | "request_publication" | "publish" | "done";
  snapshot?: TenantSnapshot;
  draft?: VerificationDraft;
  taskId?: string;
  roundId?: string;
  roundNumber?: number;
  questionIds?: string[];
  actionId?: string;
  approvalId?: string;
}
const next = (checkpoint: Cp): StepOutcome<Cp> => ({ kind: "next", checkpoint });

/** Performance agent: verifies an action task named in the schedule instruction ("Verify whether action task <uuid> ..."). */
export const actionVerificationFlow: Flow<Cp> = {
  key: "action-verification",
  initial: () => ({ step: "generate" }),
  steps: {
    async generate(rt, cp) {
      const instruction = await rt.tx(async (tx) => {
        if (rt.run.taskId) {
          const [t] = await tx.select({ instruction: schema.agentTasks.instruction }).from(schema.agentTasks).where(eq(schema.agentTasks.id, rt.run.taskId));
          return t?.instruction ?? "";
        }
        return "";
      });
      const taskId = /action task ([0-9a-f-]{36})/i.exec(instruction)?.[1] ?? null;
      const s = await rt.snapshot();
      if (!taskId) {
        // Without a specific task, verify every assigned task that is due.
        const due = s.actionTasks.filter((t) => ["assigned", "in_progress", "verifying"].includes(t.state));
        if (due.length === 0) {
          await rt.event("note", "no action tasks to verify");
          return next({ ...cp, step: "done", snapshot: s });
        }
        return next({ ...cp, step: "generate", snapshot: s, taskId: due[0]!.id });
      }
      const task = await rt.tx(async (tx) => (await tx.select().from(schema.actionTasks).where(and(eq(schema.actionTasks.id, taskId), eq(schema.actionTasks.tenantId, rt.tenant.id))))[0]);
      if (!task) {
        await rt.event("note", `action task ${taskId} not found`);
        return next({ ...cp, step: "done", snapshot: s });
      }
      const out = await rt.generate({ schema: VerificationDraftSchema, prompt: buildVerificationPrompt(s, { id: task.id, title: task.title, proposedAction: task.proposedAction, ownerRole: task.ownerRole, state: task.state }), fixture: () => verificationFixture(s, { title: task.title }), summary: "verification drafted" });
      return next({ ...cp, step: "persist", snapshot: s, draft: out.object, taskId: task.id });
    },
    async persist(rt, cp) {
      const { draft, taskId } = cp as Required<Pick<Cp, "draft" | "taskId">> & Cp;
      const task = await rt.tx(async (tx) => (await tx.select().from(schema.actionTasks).where(eq(schema.actionTasks.id, taskId)))[0]!);
      if (draft.outcome === "verified") {
        await rt.tx((tx) => setActionTaskState(tx, rt.ctx, { tenantId: rt.tenant.id, taskId, state: "closed", note: draft.evidence_summary }));
        await rt.event("output_written", "action task verified and closed", { taskId }, "internal");
        return next({ ...cp, step: "done" });
      }
      if (draft.outcome === "not_verified") {
        await rt.tx((tx) => setActionTaskState(tx, rt.ctx, { tenantId: rt.tenant.id, taskId, state: "escalated", note: draft.evidence_summary }));
        await rt.event("help_request", "action task not verified; escalated to the client admin", { taskId }, "internal");
        return next({ ...cp, step: "done" });
      }
      await rt.tx((tx) => setActionTaskState(tx, rt.ctx, { tenantId: rt.tenant.id, taskId, state: "verifying", note: draft.evidence_summary }));
      const persisted = await persistQuestionDrafts(rt, [{ department: "management", recipient_role: task.ownerRole === "client_admin" ? "client_admin" : "department_manager", question_text: draft.question_for_owner ?? `Has "${task.title}" been carried out?`, reason: "Verification needs the owner's confirmation; no evidence in the data yet.", evidence_gap: `No observation shows the effect of action task ${taskId}.`, priority: "high", answer_type: "text", confidence: 0.6 }], `verification of action task ${taskId}`);
      return next({ ...cp, step: "request_publication", ...persisted });
    },
    async request_publication(rt, cp) {
      const { actionId, approvalId } = await requestPublication(rt, { questionIds: cp.questionIds!, roundId: cp.roundId!, roundNumber: cp.roundNumber! });
      return { kind: "suspend", checkpoint: { ...cp, step: "publish", actionId, approvalId }, reason: "waiting for publication approval" };
    },
    async publish(rt, cp) {
      await publishQuestions(rt, { actionId: cp.actionId!, approvalId: cp.approvalId!, roundId: cp.roundId!, questionIds: cp.questionIds! });
      return next({ ...cp, step: "done" });
    }
  },
  finalize: async (_rt, cp) => ({ summary: cp.draft?.summary ?? "Nothing to verify", outputs: cp.taskId ? [{ contract: "ActionTask", ref_id: cp.taskId }] : [] })
};
