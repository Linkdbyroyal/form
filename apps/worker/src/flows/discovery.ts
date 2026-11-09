import { schema } from "@sbos/db";
import { createFact, requestFactVerification } from "@sbos/core";
import { DiscoveryDraftSchema, buildDiscoveryPrompt, detectSystemContradictions, discoveryFixture, type DiscoveryContext, type DiscoveryDraft } from "@sbos/agents";
import type { BaseCheckpoint, Flow, FlowRuntime, StepOutcome } from "./types";
import { persistQuestionDrafts, publishQuestions, questionsMarkdown, requestPublication, writeVaultNote } from "./shared";

interface DiscoveryCheckpoint extends BaseCheckpoint {
  step: "generate" | "persist" | "request_publication" | "publish" | "done";
  context?: DiscoveryContext;
  draft?: DiscoveryDraft;
  roundId?: string;
  roundNumber?: number;
  questionIds?: string[];
  actionId?: string;
  approvalId?: string;
}

const next = (checkpoint: DiscoveryCheckpoint): StepOutcome<DiscoveryCheckpoint> => ({ kind: "next", checkpoint });

export const discoveryFlow: Flow<DiscoveryCheckpoint> = {
  key: "discovery-interview",
  initial: () => ({ step: "generate" }),
  steps: {
    async generate(rt, cp) {
      const s = await rt.snapshot();
      const context: DiscoveryContext = {
        tenantId: s.tenantId,
        company: s.company,
        departments: s.departments,
        systems: s.systems,
        priorQuestions: s.questions.map((q) => ({ department: q.department, question_text: q.question_text, state: q.state })),
        answers: s.answers.map((a) => ({ question_text: a.question_text, answer_text: a.answer_text, department: a.department, answered_by_role: a.answered_by_role, fact_id: a.fact_id })),
        facts: s.facts,
        roundNumber: Math.max(0, ...s.questions.map(() => 0)) + 1
      };
      await rt.event("tool_call", `read ${s.departments.length} departments, ${s.systems.length} systems, ${s.questions.length} prior questions, ${s.answers.length} answers, ${s.facts.length} facts (retrieval audited)`, { tools: ["systems.read", "questions.read", "vault.read"] });
      const out = await rt.generate({ schema: DiscoveryDraftSchema, prompt: buildDiscoveryPrompt(context), fixture: () => discoveryFixture(context), summary: "questions drafted" });
      return next({ ...cp, step: "persist", context, draft: out.object });
    },
    async persist(rt, cp) {
      const draft = cp.draft!;
      const context = cp.context!;
      const persisted = await persistQuestionDrafts(rt, draft.questions, draft.round_rationale);
      // Contradictions between answers and the systems register become verification requests (never verdicts).
      const contradictions = detectSystemContradictions({ answers: context.answers, systems: context.systems });
      for (const c of contradictions) {
        await rt.tx(async (tx) => {
          rt.gateway.authorize("approvals.request");
          const [src] = await tx.insert(schema.sources).values({ tenantId: rt.tenant.id, system: "systems_register", locator: `system:${c.systemName}`, retrievedAt: new Date(), createdByActorType: "agent", createdByActorId: rt.instance.serviceIdentity }).returning({ id: schema.sources.id });
          const registerFactId = await createFact(tx, rt.ctx, { tenantId: rt.tenant.id, statement: `Systems register lists ${c.systemName} as a system in use (claim status: stated by the client)`, subjectType: "system", subjectKey: c.systemName, sourceIds: [src!.id], originSystem: "agent", verification: "hypothesis", confidence: 0.4, runId: rt.run.id });
          const requestId = await requestFactVerification(tx, rt.ctx, { tenantId: rt.tenant.id, factId: c.answerFactId, conflictingFactIds: [registerFactId], reason: `Answer says ${c.systemName} is not used ("${c.snippet}") while the systems register lists it. A reviewer must decide which is true.`, runId: rt.run.id });
          await rt.event("help_request", `contradiction flagged for reviewer: ${c.systemName}`, { requestId, systemName: c.systemName }, "confidential");
        });
      }
      await writeVaultNote(rt, {
        path: `13_interviews_and_open_questions/round-${String(persisted.roundNumber).padStart(3, "0")}.md`,
        title: `Discovery round ${persisted.roundNumber}`,
        frontmatter: { round: persisted.roundNumber, status: "draft", source_ids: [rt.run.id], confidence: 0.5, verification: "unconfirmed", contradictions: contradictions.length },
        body: questionsMarkdown(`Discovery round ${persisted.roundNumber}`, draft.round_rationale, draft.questions, rt),
        changeNote: "Discovery agent draft"
      });
      return next({ ...cp, step: "request_publication", roundId: persisted.roundId, roundNumber: persisted.roundNumber, questionIds: persisted.questionIds });
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
  finalize: async (_rt, cp) => ({ summary: cp.draft?.summary ?? "Discovery round completed", outputs: (cp.questionIds ?? []).map((id) => ({ contract: "QuestionRequest", ref_id: id })) })
};

export type { FlowRuntime };
