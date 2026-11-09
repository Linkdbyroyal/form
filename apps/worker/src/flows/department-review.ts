import { createFinding } from "@sbos/core";
import { DepartmentReviewDraftSchema, buildDepartmentReviewPrompt, departmentReviewFixture, type DepartmentReviewDraft, type TenantSnapshot } from "@sbos/agents";
import type { BaseCheckpoint, Flow, StepOutcome } from "./types";
import { persistQuestionDrafts, publishQuestions, questionsMarkdown, requestPublication, writeVaultNote } from "./shared";

interface Cp extends BaseCheckpoint {
  step: "generate" | "persist" | "request_publication" | "publish" | "done";
  snapshot?: TenantSnapshot;
  draft?: DepartmentReviewDraft;
  department?: string;
  findingIds?: string[];
  roundId?: string;
  roundNumber?: number;
  questionIds?: string[];
  actionId?: string;
  approvalId?: string;
}
const next = (checkpoint: Cp): StepOutcome<Cp> => ({ kind: "next", checkpoint });

/** Finance & Operations agents: the department comes from the agent definition. */
export const departmentReviewFlow: Flow<Cp> = {
  key: "department-review",
  initial: () => ({ step: "generate" }),
  steps: {
    async generate(rt, cp) {
      const department = rt.definition.department ?? "operations";
      const s = await rt.snapshot();
      await rt.event("tool_call", `read snapshot for ${department}: ${s.answers.length} answers, ${s.findings.length} findings, ${s.facts.length} facts (retrieval audited)`, { tools: ["systems.read", "questions.read", "vault.read"] });
      const out = await rt.generate({ schema: DepartmentReviewDraftSchema, prompt: buildDepartmentReviewPrompt(s, department), fixture: () => departmentReviewFixture(s, department), summary: `${department} review drafted` });
      return next({ ...cp, step: "persist", snapshot: s, draft: out.object, department });
    },
    async persist(rt, cp) {
      const { draft, snapshot: s, department } = cp as Required<Pick<Cp, "draft" | "snapshot" | "department">> & Cp;
      const findingIds: string[] = [];
      for (const f of draft.findings) {
        const sourceIds = f.based_on_answer_indexes.map((i) => s.answers[i]?.source_id).filter((x): x is string => !!x);
        if (sourceIds.length === 0) {
          await rt.event("note", "finding skipped: no answer source could be linked", { title: f.title.slice(0, 80) }, "confidential");
          continue;
        }
        const id = await rt.tx((tx) =>
          createFinding(tx, rt.ctx, { tenantId: rt.tenant.id, title: f.title, description: f.description, department, severity: f.severity, urgency: f.urgency, impact: { description: f.impact_description, ...(f.estimated_annual_cost_eur !== undefined ? { estimated_annual_cost: { amount: f.estimated_annual_cost_eur, currency: "EUR", is_estimate: true as const } } : {}) }, ownerRole: f.owner_role, claim: f.claim_type === "data_observation" ? "hypothesis" : f.claim_type, sourceIds, confidence: f.confidence, agentInstanceId: rt.instance.id, runId: rt.run.id })
        );
        findingIds.push(id);
      }
      await rt.event("output_written", `${findingIds.length} finding(s) recorded for ${department}`, { findingIds }, "confidential");
      const drafts = draft.questions.map((q) => ({ ...q, department, recipient_role: "department_manager" as const }));
      let persisted: { roundId: string; roundNumber: number; questionIds: string[] } | null = null;
      if (drafts.length > 0) persisted = await persistQuestionDrafts(rt, drafts, `${department} follow-up after review`);
      await writeVaultNote(rt, {
        path: `14_findings_and_evidence/${department}-review-${new Date().toISOString().slice(0, 10)}.md`,
        title: `${department} review`,
        frontmatter: { department, findings: findingIds, verification: "unconfirmed", confidence: 0.45 },
        body: [`# ${department} review`, "", ...draft.findings.map((f) => `## ${f.title}\n\n- Severity: ${f.severity}; urgency ${f.urgency}; claim type **${f.claim_type}**; confidence ${f.confidence}\n- Impact: ${f.impact_description}${f.estimated_annual_cost_eur !== undefined ? ` (estimate: EUR ${f.estimated_annual_cost_eur} per year)` : ""}\n\n${f.description}`), "", persisted ? questionsMarkdown("Follow-up questions", `${department} review`, drafts, rt) : "_No follow-up questions this round._"].join("\n"),
        changeNote: `${department} agent review`
      });
      if (!persisted) return next({ ...cp, step: "done", findingIds });
      return next({ ...cp, step: "request_publication", findingIds, roundId: persisted.roundId, roundNumber: persisted.roundNumber, questionIds: persisted.questionIds });
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
  finalize: async (_rt, cp) => ({ summary: cp.draft?.summary ?? "Department review completed", outputs: [...(cp.findingIds ?? []).map((id) => ({ contract: "Finding", ref_id: id })), ...(cp.questionIds ?? []).map((id) => ({ contract: "QuestionRequest", ref_id: id }))] })
};
