import { z } from "zod";
import { formatList, type TenantSnapshot } from "./snapshot";
import { wrapUntrusted } from "./runtime";

export const WIDGET_TYPES = ["kpi_tile", "trend_line", "bar", "table", "action_list", "briefing", "risk_list", "data_gap_list", "text_note"] as const;

export const CeoIntelligenceDraftSchema = z.object({
  summary: z.string().min(5).max(200),
  decision_needs: z.array(z.string().min(5).max(200)).min(1).max(6).describe("Decisions the CEO actually has to take, inferred from answers and findings"),
  kpis: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9_]{3,50}$/),
        name: z.string().min(3).max(80),
        business_question: z.string().min(5).max(200),
        formula: z.string().min(5).max(300),
        unit: z.string().min(1).max(20),
        source_system: z.string().min(2).max(60).describe("Must be a system from the register"),
        source_field: z.string().min(2).max(120).describe("Expected field or endpoint; marked as to be verified"),
        owner_role: z.enum(["client_admin", "department_manager"]),
        refresh: z.enum(["realtime", "hourly", "daily", "weekly", "monthly", "manual"]),
        direction: z.enum(["higher_is_better", "lower_is_better"]),
        warning_threshold: z.number().optional(),
        critical_threshold: z.number().optional(),
        reliability: z.enum(["high", "medium", "low", "unknown"])
      })
    )
    .min(2)
    .max(8),
  widgets: z
    .array(
      z.object({
        type: z.enum(WIDGET_TYPES),
        kpi_keys: z.array(z.string()).max(6),
        priority: z.int().min(1).max(50),
        reason: z.string().min(5).max(200),
        size: z.enum(["s", "m", "l"])
      })
    )
    .min(2)
    .max(10)
});
export type CeoIntelligenceDraft = z.infer<typeof CeoIntelligenceDraftSchema>;

export function buildCeoIntelligencePrompt(s: TenantSnapshot): string {
  return [
    `Company: ${s.company.name}, industry ${s.company.industry ?? "unknown"}, locale ${s.company.locale}.`,
    "Departments:",
    formatList(s.departments, (d) => `${d.name} (${d.key})`),
    "Systems register (only these may be KPI sources; none is connected yet):",
    wrapUntrusted("systems_register", formatList(s.systems, (x) => `${x.name}: ${x.function}; source of truth for ${x.sourceOfTruthFor.join(", ") || "unknown"} [${x.claimStatus}]`)),
    "Answers:",
    wrapUntrusted("answers", formatList(s.answers, (a) => `(${a.department}, ${a.answered_by_role}) Q: ${a.question_text} A: ${a.answer_text}`)),
    "Findings:",
    wrapUntrusted("findings", formatList(s.findings, (f) => `[${f.severity}, ${f.claim}] ${f.title}`)),
    "Opportunities:",
    wrapUntrusted("opportunities", formatList(s.opportunities, (o) => `[${o.state}, ${o.intervention}] ${o.title}`)),
    "Existing KPIs (reuse keys, do not duplicate):",
    formatList(s.kpis, (k) => `${k.key}: ${k.name} (${k.status})`),
    "",
    "Discover which decisions the CEO must take, then define only the KPIs that inform those decisions. Every KPI needs a formula, a source system from the register and an expected field. Compose a dashboard from the allowed widget types only; always include one data_gap_list widget because no source is connected yet, and an action_list widget for decisions. Do not add standard charts for their own sake.",
    "Produce the JSON object described in your instructions."
  ].join("\n");
}

export function ceoIntelligenceFixture(s: TenantSnapshot): CeoIntelligenceDraft {
  const projectSystem = s.systems.find((x) => x.sourceOfTruthFor.some((t) => /project/i.test(t)))?.name ?? s.systems[0]?.name ?? "unknown";
  const ledgerSystem = s.systems.find((x) => x.sourceOfTruthFor.some((t) => /ledger|payment/i.test(t)))?.name ?? s.systems[1]?.name ?? projectSystem;
  return {
    summary: "Derived decision needs, 4 KPI definitions and a dashboard specification (simulated).",
    decision_needs: ["Which projects are closed but not yet invoiced?", "Where does cash get stuck between delivery and payment?", "Which hand-offs need a standard before automation?"],
    kpis: [
      { key: "quote_to_invoice_days", name: "Quote to invoice lead time", business_question: "How long does it take from accepted quote to invoice?", formula: "avg(invoice_date - quote_accepted_date) over projects invoiced in period", unit: "days", source_system: projectSystem, source_field: "projects.invoice_date, projects.quote_accepted_date (to be verified)", owner_role: "department_manager", refresh: "daily", direction: "lower_is_better", warning_threshold: 10, critical_threshold: 20, reliability: "unknown" },
      { key: "closed_not_invoiced", name: "Closed projects not invoiced", business_question: "How many finished projects still have no invoice?", formula: "count(projects where status = closed and invoice is null)", unit: "count", source_system: projectSystem, source_field: "projects.status, invoices.project (to be verified)", owner_role: "department_manager", refresh: "daily", direction: "lower_is_better", warning_threshold: 3, critical_threshold: 8, reliability: "unknown" },
      { key: "ar_overdue_eur", name: "Overdue receivables", business_question: "How much invoiced revenue is overdue?", formula: "sum(invoice.balance where due_date < today)", unit: "EUR", source_system: ledgerSystem, source_field: "Invoice.Balance, Invoice.DueDate (to be verified)", owner_role: "department_manager", refresh: "daily", direction: "lower_is_better", reliability: "unknown" },
      { key: "open_discovery_questions", name: "Open discovery questions", business_question: "How many questions from the agents are still unanswered?", formula: "count(questions where state = open)", unit: "count", source_system: "second-brain", source_field: "questions.state", owner_role: "client_admin", refresh: "hourly", direction: "lower_is_better", reliability: "high" }
    ],
    widgets: [
      { type: "data_gap_list", kpi_keys: ["quote_to_invoice_days", "closed_not_invoiced", "ar_overdue_eur"], priority: 1, reason: "No source is connected; show what is missing instead of numbers", size: "l" },
      { type: "action_list", kpi_keys: [], priority: 2, reason: "Decisions and delegated tasks the CEO owns", size: "m" },
      { type: "kpi_tile", kpi_keys: ["open_discovery_questions"], priority: 3, reason: "The only KPI with a connected (internal) source today", size: "s" },
      { type: "kpi_tile", kpi_keys: ["closed_not_invoiced"], priority: 4, reason: "Direct driver of cash; shows missing data until the project system is connected", size: "s" },
      { type: "risk_list", kpi_keys: [], priority: 5, reason: "Open high-severity findings", size: "m" },
      { type: "briefing", kpi_keys: [], priority: 6, reason: "Latest executive briefing", size: "l" }
    ]
  };
}
