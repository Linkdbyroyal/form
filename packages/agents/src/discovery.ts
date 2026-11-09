import { z } from "zod";
import { QuestionRequestSchema, type QuestionRequest } from "@sbos/contracts";
import type { AgentRuntime } from "./runtime";
import { wrapUntrusted } from "./runtime";

/** LLM-facing draft schema: narrower than the contract; mapped and validated against the contract afterwards. */
export const DiscoveryDraftSchema = z.object({
  round_rationale: z.string().min(10).max(600).describe("Why this round asks these questions, without client specifics"),
  summary: z.string().min(5).max(200).describe("Neutral run summary with no client specifics"),
  questions: z
    .array(
      z.object({
        department: z.string().min(1),
        recipient_role: z.enum(["client_admin", "department_manager"]),
        question_text: z.string().min(10).max(500),
        reason: z.string().min(5).max(400),
        evidence_gap: z.string().min(5).max(300),
        priority: z.enum(["critical", "high", "medium", "low"]),
        answer_type: z.enum(["text", "number", "boolean", "single_choice", "multi_choice", "date", "file", "system_reference"]),
        options: z.array(z.string()).max(10).optional(),
        confidence: z.number().min(0).max(1)
      })
    )
    .min(1)
    .max(5)
});
export type DiscoveryDraft = z.infer<typeof DiscoveryDraftSchema>;

export interface DiscoveryContext {
  tenantId: string;
  company: { name: string; industry: string | null; locale: string; kind: string };
  departments: Array<{ key: string; name: string; headRole: string | null }>;
  systems: Array<{ name: string; vendor: string | null; function: string; claimStatus: string; apiCapabilities: string[]; sourceOfTruthFor: string[] }>;
  priorQuestions: Array<{ department: string; question_text: string; state: string }>;
  /** Answers given so far (round 2 onward builds on them). */
  answers: Array<{ question_text: string; answer_text: string; department: string; answered_by_role: string; fact_id: string | null }>;
  /** Non-deprecated facts from the Knowledge Vault, read through the tool gateway with retrieval audit. */
  facts: Array<{ id: string; statement: string; verification: string; subject_key: string | null }>;
  roundNumber: number;
}

export function buildDiscoveryPrompt(ctx: DiscoveryContext): string {
  const departments = ctx.departments.map((d) => `- ${d.name} (key ${d.key}, head role ${d.headRole ?? "unknown"})`).join("\n");
  const systems = ctx.systems
    .map((s) => `- ${s.name} by ${s.vendor ?? "unknown vendor"}: ${s.function}. claim_status=${s.claimStatus}; capabilities=${s.apiCapabilities.join(",") || "none"}; source of truth for ${s.sourceOfTruthFor.join(", ") || "nothing recorded"}`)
    .join("\n");
  const prior = ctx.priorQuestions.length === 0 ? "(none yet)" : ctx.priorQuestions.map((q) => `- [${q.state}] (${q.department}) ${q.question_text}`).join("\n");
  const answers = ctx.answers.length === 0 ? "(none yet)" : ctx.answers.map((a) => `- (${a.department}, ${a.answered_by_role}) Q: ${a.question_text} A: ${a.answer_text}`).join("\n");
  const facts = ctx.facts.length === 0 ? "(none yet)" : ctx.facts.map((f) => `- [${f.verification}] ${f.statement}`).join("\n");
  const roundGuidance =
    ctx.roundNumber === 1
      ? "This is round 1: interview the CEO (client_admin) about business model, revenue mechanics, critical processes, bottlenecks and ownership."
      : `This is round ${ctx.roundNumber}: ask department heads (department_manager) about software actually used, manual data transfers, frequency, error types and hand-offs. Build on prior answers.`;

  return [
    `Company profile: ${ctx.company.name}, industry ${ctx.company.industry ?? "unknown"}, locale ${ctx.company.locale}.`,
    roundGuidance,
    "",
    "Departments:",
    departments || "(no departments recorded)",
    "",
    "Systems register (client statements, not verified integrations):",
    wrapUntrusted("systems_register", systems || "(no systems recorded)"),
    "",
    "Questions already asked (never repeat these):",
    wrapUntrusted("prior_questions", prior),
    "",
    "Answers received so far (client statements, unconfirmed unless marked verified in the facts list):",
    wrapUntrusted("answers", answers),
    "",
    "Knowledge Vault facts (with verification status):",
    wrapUntrusted("facts", facts),
    "",
    "Produce the JSON object described in your instructions. Between 3 and 5 questions unless fewer gaps remain."
  ].join("\n");
}

/** Deterministic fixture used by the simulated runtime: one question per stated system plus a CEO question, max 5. */
export function discoveryFixture(ctx: DiscoveryContext): DiscoveryDraft {
  const asked = new Set(ctx.priorQuestions.map((q) => q.question_text));
  const questions: DiscoveryDraft["questions"] = [];
  if (ctx.roundNumber === 1) {
    questions.push({
      department: "management",
      recipient_role: "client_admin",
      question_text: "Which three processes, if they fail for a day, cost you the most money or reputation?",
      reason: "Identifies the critical processes to analyse first.",
      evidence_gap: "No ranking of critical processes recorded.",
      priority: "critical",
      answer_type: "text",
      confidence: 0.6
    });
  }
  if (ctx.roundNumber >= 2) {
    for (const a of ctx.answers) {
      if (questions.length >= 5) break;
      const text = `You answered "${a.answer_text.slice(0, 80)}" about ${a.department}. Who performs the related manual steps, how many hours per week does it take, and which errors have occurred in the last three months?`;
      if (asked.has(text)) continue;
      questions.push({
        department: a.department,
        recipient_role: "department_manager",
        question_text: text,
        reason: "Quantifies the manual work and error rate behind a stated answer so the finding can be sized.",
        evidence_gap: `No effort or error data recorded for the ${a.department} answer.`,
        priority: "high",
        answer_type: "text",
        confidence: 0.55
      });
    }
  }
  for (const s of ctx.systems) {
    if (questions.length >= 5) break;
    const text = `Is data from ${s.name} transferred manually into another system? If so, by whom, how often, and which errors occur?`;
    if (asked.has(text)) continue;
    questions.push({
      department: ctx.departments.find((d) => d.key !== "management")?.key ?? "operations",
      recipient_role: "department_manager",
      question_text: text,
      reason: `The register lists ${s.name} as stated but not verified; manual transfers are a common error source.`,
      evidence_gap: `No evidence on hand-offs out of ${s.name}.`,
      priority: "high",
      answer_type: "text",
      confidence: 0.5
    });
  }
  if (questions.length === 0) {
    questions.push({
      department: "management",
      recipient_role: "client_admin",
      question_text: "Which decision are you currently postponing because information is missing?",
      reason: "Finds the next evidence gap when all system questions are answered.",
      evidence_gap: "No open decision recorded.",
      priority: "medium",
      answer_type: "text",
      confidence: 0.4
    });
  }
  return {
    round_rationale: `Round ${ctx.roundNumber}: cover stated systems and critical processes with the fewest questions. Simulated output.`,
    summary: `Generated ${questions.length} questions for ${new Set(questions.map((q) => q.department)).size} department(s) (simulated).`,
    questions
  };
}

export interface DiscoveryRunOutput {
  draft: DiscoveryDraft;
  contracts: QuestionRequest[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  simulated: boolean;
  durationMs: number;
}

/** Runs the model step and validates every question against the shared QuestionRequest contract. */
export async function runDiscoveryModelStep(runtime: AgentRuntime, skillMd: string, ctx: DiscoveryContext, meta: { agentInstanceId: string; roundId: string }): Promise<DiscoveryRunOutput> {
  const result = await runtime.generateStructured({ instructions: skillMd, prompt: buildDiscoveryPrompt(ctx), schema: DiscoveryDraftSchema, maxOutputTokens: 3000 });
  const now = new Date().toISOString();
  const contracts = result.object.questions.map((q) =>
    QuestionRequestSchema.parse({
      question_id: crypto.randomUUID(),
      tenant_id: ctx.tenantId,
      department: q.department,
      recipient_role: q.recipient_role,
      question_text: q.question_text,
      reason: q.reason,
      evidence_gap: q.evidence_gap,
      priority: q.priority,
      answer_type: q.answer_type,
      options: q.options,
      status: "draft",
      confidence: q.confidence,
      round_id: meta.roundId,
      depends_on: [],
      asked_by_agent_id: meta.agentInstanceId,
      created_at: now
    })
  );
  return { draft: result.object, contracts, usage: result.usage, model: result.model, simulated: result.simulated, durationMs: result.durationMs };
}


export interface SystemContradiction {
  answerFactId: string;
  systemName: string;
  snippet: string;
}

const NEGATIONS = ["not used", "no longer", "isn't used", "is not used", "don't use", "do not use", "stopped using", "retired", "never used", "niet meer", "gebruiken we niet", "no, "];

/**
 * Deterministic contradiction check: an answer that negates the use of a system the register lists as used.
 * This is a hypothesis generator, not a verdict: the result becomes a FactVerificationRequest for a reviewer.
 */
export function detectSystemContradictions(ctx: Pick<DiscoveryContext, "answers" | "systems">): SystemContradiction[] {
  const out: SystemContradiction[] = [];
  for (const a of ctx.answers) {
    if (!a.fact_id) continue;
    const text = a.answer_text.toLowerCase();
    for (const s of ctx.systems) {
      const name = s.name.toLowerCase();
      const idx = text.indexOf(name);
      if (idx < 0) continue;
      // The negation must sit right before the name ("no, QuickBooks ...") or right after it ("QuickBooks is not used").
      const before = text.slice(Math.max(0, idx - 30), idx);
      const after = text.slice(idx + name.length, idx + name.length + 30);
      if (NEGATIONS.some((n) => before.includes(n) || after.includes(n))) {
        out.push({ answerFactId: a.fact_id, systemName: s.name, snippet: a.answer_text.slice(Math.max(0, idx - 40), idx + name.length + 40) });
      }
    }
  }
  return out;
}
