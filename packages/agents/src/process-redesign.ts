import { z } from "zod";
import { formatList, type TenantSnapshot } from "./snapshot";
import { wrapUntrusted } from "./runtime";

const StepSchema = z.object({
  kind: z.enum(["trigger", "input", "activity", "handoff", "decision", "control", "output"]),
  name: z.string().min(3).max(160),
  owner_role: z.string().max(60).optional(),
  system_name: z.string().max(80).optional(),
  exceptions: z.string().max(300).optional(),
  intervention: z.enum(["stop", "simplify", "standardize", "integrate", "automate", "keep_human"]).optional().describe("TO-BE steps only")
});

export const ProcessRedesignDraftSchema = z.object({
  summary: z.string().min(5).max(200),
  process_key: z.string().regex(/^[a-z0-9-]{3,60}$/),
  process_name: z.string().min(3).max(120),
  department: z.string().min(2).max(60),
  as_is_steps: z.array(StepSchema).min(3).max(12),
  to_be_steps: z.array(StepSchema).min(3).max(12),
  opportunity: z.object({
    title: z.string().min(5).max(160),
    description: z.string().min(20).max(1500),
    intervention: z.enum(["stop", "simplify", "standardize", "integrate", "automate", "keep_human"]),
    effort: z.enum(["xs", "s", "m", "l", "xl"]),
    dependencies: z.array(z.string().max(120)).max(8),
    risks: z.array(z.string().max(200)).max(8),
    estimated_saving_eur_per_year: z.number().min(0).optional().describe("Labelled as an estimate; omit when not defensible"),
    expected_kpi_changes: z.array(z.object({ kpi_key: z.string().max(60), direction: z.enum(["up", "down"]), magnitude: z.string().max(80) })).max(5),
    impact: z.int().min(1).max(5),
    feasibility: z.int().min(1).max(5),
    risk: z.int().min(1).max(5),
    time_to_value: z.int().min(1).max(5),
    based_on_finding_indexes: z.array(z.int().min(0))
  }),
  reusable_insight: z
    .object({
      title: z.string().min(5).max(160),
      generic_statement: z.string().min(20).max(800).describe("Industry-neutral wording: no names, amounts, contract details or identifiable combinations"),
      rationale: z.string().min(10).max(600),
      identifiability_risk: z.enum(["low", "medium", "high"])
    })
    .optional()
    .describe("A Potential Reusable Insight for the agency reviewer. It is only a nomination; publication requires a human rights check.")
});
export type ProcessRedesignDraft = z.infer<typeof ProcessRedesignDraftSchema>;

export function buildProcessRedesignPrompt(s: TenantSnapshot): string {
  return [
    `Company: ${s.company.name}, industry ${s.company.industry ?? "unknown"}.`,
    "Open findings (index: severity, claim, department, title):",
    wrapUntrusted("findings", formatList(s.findings.filter((f) => f.state === "open"), (f) => `${s.findings.indexOf(f)}: [${f.severity}, ${f.claim}, ${f.department}] ${f.title}`)),
    "Answers (department, role, Q, A):",
    wrapUntrusted("answers", formatList(s.answers, (a) => `(${a.department}, ${a.answered_by_role}) Q: ${a.question_text} A: ${a.answer_text}`)),
    "Systems register:",
    wrapUntrusted("systems_register", formatList(s.systems, (x) => `${x.name}: ${x.function} [${x.claimStatus}]`)),
    "",
    "Pick the single process with the highest impact among the findings. Describe AS-IS from the answers only (no invented steps), then a TO-BE with fewer hand-offs where every changed step carries an intervention label. Propose ONE opportunity with a business case; every money figure is an estimate and may be omitted. Automation is only proposed after the process is simplified.",
    "Optionally nominate one reusable_insight: the generic pattern behind the redesign, worded so that no company, person, amount or contract detail can be recognised. It is a nomination for a human reviewer, never a publication.",
    "Produce the JSON object described in your instructions."
  ].join("\n");
}

export function processRedesignFixture(s: TenantSnapshot): ProcessRedesignDraft {
  const finIdx = s.findings.map((f, i) => ({ f, i })).filter((x) => x.f.state === "open").map((x) => x.i);
  return {
    summary: "Redesigned one process from findings and answers (simulated).",
    process_key: "project-closure-to-invoice",
    process_name: "Project closure to invoice readiness",
    department: "finance",
    as_is_steps: [
      { kind: "trigger", name: "Event delivered and equipment returned", owner_role: "department_manager", system_name: s.systems[0]?.name },
      { kind: "handoff", name: "Warehouse tells finance by chat that the project is complete", owner_role: "department_manager", exceptions: "Message forgotten or sent days later" },
      { kind: "activity", name: "Finance checks project status manually", owner_role: "department_manager", system_name: s.systems[0]?.name },
      { kind: "activity", name: "Invoice created in the accounting system by retyping lines", owner_role: "department_manager", exceptions: "Typing errors, missing extra costs" },
      { kind: "output", name: "Invoice sent", owner_role: "department_manager" }
    ],
    to_be_steps: [
      { kind: "trigger", name: "All returns registered on the project", system_name: s.systems[0]?.name, intervention: "integrate" },
      { kind: "control", name: "Automatic closure check: returns, extra costs, damages", intervention: "automate" },
      { kind: "decision", name: "Exceptions routed to finance for review", owner_role: "department_manager", intervention: "keep_human" },
      { kind: "activity", name: "Invoice lines prepared from the project record", intervention: "automate" },
      { kind: "output", name: "Invoice reviewed and sent within 2 working days", owner_role: "department_manager", intervention: "standardize" }
    ],
    opportunity: {
      title: "Project closure to invoice readiness check",
      description: "Replace the chat-based hand-off with a closure check that triggers invoice preparation once all returns are registered. Finance keeps the final review. Requires read access to project and return data; the exact fields must be verified per system.",
      intervention: "automate",
      effort: "m",
      dependencies: ["read-only connection to the project system", "agreed definition of a closed project"],
      risks: ["returns registered late make the trigger fire late", "extra costs not captured in the project record"],
      estimated_saving_eur_per_year: undefined,
      expected_kpi_changes: [{ kpi_key: "quote_to_invoice_days", direction: "down", magnitude: "illustrative: several days" }],
      impact: 4,
      feasibility: 3,
      risk: 2,
      time_to_value: 4,
      based_on_finding_indexes: finIdx.slice(0, 2)
    },
    reusable_insight: {
      title: "Closure gate before invoicing",
      generic_statement: "Companies that invoice from a project or job system benefit from an explicit closure check (returns, extra costs, damages) that triggers invoice preparation, with a human review of exceptions.",
      rationale: "The pattern depends on no company-specific data; only the systems and the closure definition are parameters.",
      identifiability_risk: "low"
    }
  };
}
