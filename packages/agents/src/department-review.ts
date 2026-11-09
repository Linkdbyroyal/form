import { z } from "zod";
import { formatList, type TenantSnapshot } from "./snapshot";
import { wrapUntrusted } from "./runtime";

/** Finance and Operations agents share this flow: review the department, ask up to 2 follow-up questions, state findings with a claim type. */
export const DepartmentReviewDraftSchema = z.object({
  summary: z.string().min(5).max(200).describe("Neutral run summary without client specifics"),
  questions: z
    .array(
      z.object({
        question_text: z.string().min(10).max(500),
        reason: z.string().min(5).max(400),
        evidence_gap: z.string().min(5).max(300),
        priority: z.enum(["critical", "high", "medium", "low"]),
        answer_type: z.enum(["text", "number", "boolean", "single_choice", "multi_choice", "date", "file", "system_reference"]),
        options: z.array(z.string()).max(10).optional(),
        confidence: z.number().min(0).max(1)
      })
    )
    .max(2),
  findings: z
    .array(
      z.object({
        title: z.string().min(5).max(160),
        description: z.string().min(10).max(1200),
        severity: z.enum(["critical", "high", "medium", "low", "info"]),
        urgency: z.enum(["immediate", "short_term", "medium_term", "long_term"]),
        impact_description: z.string().min(5).max(400),
        estimated_annual_cost_eur: z.number().min(0).optional().describe("Only when an estimate is defensible; it is always labelled as an estimate"),
        claim_type: z.enum(["client_statement", "data_observation", "hypothesis"]).describe("Without connected data this must be client_statement or hypothesis"),
        owner_role: z.enum(["client_admin", "department_manager"]),
        based_on_answer_indexes: z.array(z.int().min(0)).describe("Indexes into the answers list used as sources"),
        confidence: z.number().min(0).max(1)
      })
    )
    .max(3)
});
export type DepartmentReviewDraft = z.infer<typeof DepartmentReviewDraftSchema>;

export function buildDepartmentReviewPrompt(s: TenantSnapshot, department: string): string {
  const deptAnswers = s.answers.filter((a) => a.department === department);
  return [
    `Company: ${s.company.name}, industry ${s.company.industry ?? "unknown"}. You review the department "${department}".`,
    "Systems register (client statements, not verified integrations):",
    wrapUntrusted("systems_register", formatList(s.systems, (x) => `${x.name}: ${x.function} [${x.claimStatus}]`)),
    "Answers so far (index: department, role, Q, A):",
    wrapUntrusted("answers", formatList(s.answers, (a) => `${s.answers.indexOf(a)}: (${a.department}, ${a.answered_by_role}) Q: ${a.question_text} A: ${a.answer_text}`)),
    `Answers from this department: ${deptAnswers.length}.`,
    "Questions already asked (never repeat):",
    wrapUntrusted("prior_questions", formatList(s.questions, (q) => `[${q.state}] (${q.department}) ${q.question_text}`)),
    "Existing findings (do not duplicate):",
    wrapUntrusted("findings", formatList(s.findings, (f) => `[${f.severity}, ${f.claim}] ${f.title}`)),
    "",
    "Rules: no connected data exists yet, so every finding is a client_statement or a hypothesis, never a data_observation. Ask at most 2 questions that close the biggest evidence gap. Never invent amounts; include estimated_annual_cost_eur only when the answers contain enough to estimate, and keep it conservative.",
    "Produce the JSON object described in your instructions."
  ].join("\n");
}

export function departmentReviewFixture(s: TenantSnapshot, department: string): DepartmentReviewDraft {
  const asked = new Set(s.questions.map((q) => q.question_text));
  const indexed = s.answers.map((a, i) => ({ a, i }));
  const own = indexed.filter((x) => x.a.department === department || x.a.department === "management");
  // Early rounds often have answers only from the CEO or another department; use them as sources rather than inventing.
  const deptAnswers = own.length > 0 ? own : indexed;
  const q1 = department === "finance" ? "How many days pass on average between project completion and the invoice being sent, and who triggers the invoice?" : "Which planning conflicts (crew, equipment or vehicles) occurred in the last month, and how were they detected?";
  const q2 = department === "finance" ? "Which invoices from the last quarter were paid late, and what was the main reason given by the customer?" : "How many returns required a manual correction in the inventory system last month?";
  const questions = [q1, q2].filter((t) => !asked.has(t)).map((t) => ({
    question_text: t,
    reason: "Quantifies a hand-off the answers describe qualitatively so the finding can be sized.",
    evidence_gap: `No measured lead time or error count recorded for ${department}.`,
    priority: "high" as const,
    answer_type: "text" as const,
    confidence: 0.55
  }));
  const findings = deptAnswers.length > 0 && !s.findings.some((f) => f.department === department)
    ? [
        {
          title: department === "finance" ? "Invoicing depends on manual project closure" : "Returns are confirmed manually before planning data is reliable",
          description: `Answers from ${department} describe a manual hand-off between systems listed in the register. Until data is connected this is a hypothesis built on client statements.`,
          severity: "high" as const,
          urgency: "short_term" as const,
          impact_description: "Delayed invoices or planning errors; magnitude unknown until measured.",
          claim_type: "client_statement" as const,
          owner_role: "department_manager" as const,
          based_on_answer_indexes: deptAnswers.slice(0, 2).map((x) => x.i),
          confidence: 0.45
        }
      ]
    : [];
  return { summary: `Reviewed ${department}: ${questions.length} question(s), ${findings.length} finding(s) (simulated).`, questions, findings };
}
