import { z } from "zod";
import { formatList, type TenantSnapshot } from "./snapshot";
import { wrapUntrusted } from "./runtime";

const Item = z.object({ text: z.string().min(3).max(300), refs: z.array(z.string().max(60)).max(6).describe("ids or keys from the snapshot this item is based on"), confidence: z.number().min(0).max(1) });

export const BriefingDraftSchema = z.object({
  summary: z.string().min(5).max(200),
  what_changed: z.array(Item).max(7),
  what_matters_today: z.array(Item).max(7),
  decisions_needed: z.array(Item).max(7),
  tasks_delegated: z.array(Item).max(7),
  risks: z.array(Item).max(7),
  opportunities: z.array(Item).max(7),
  data_gaps: z.array(Item).max(7),
  impact_of_prior_improvements: z.array(Item).max(7),
  top_priorities: z.array(z.string().min(3).max(160)).min(1).max(7)
});
export type BriefingDraft = z.infer<typeof BriefingDraftSchema>;

export function buildBriefingPrompt(s: TenantSnapshot, date: string): string {
  return [
    `Daily executive briefing for ${s.company.name} on ${date}.`,
    "KPIs (key, latest status, value):",
    formatList(s.kpis, (k) => `${k.key}: ${k.latest_status ?? "no observation"} ${k.latest_value ?? ""} (${k.unit}, source ${k.source_system})`),
    "Findings:",
    wrapUntrusted("findings", formatList(s.findings, (f) => `${f.id}: [${f.severity}, ${f.claim}, ${f.state}] ${f.title}`)),
    "Opportunities:",
    wrapUntrusted("opportunities", formatList(s.opportunities, (o) => `${o.id}: [${o.state}] ${o.title}`)),
    "Action tasks:",
    wrapUntrusted("action_tasks", formatList(s.actionTasks, (t) => `${t.id}: [${t.state}] ${t.title} (owner ${t.owner_role ?? "unassigned"}, due ${t.due_at ?? "n/a"})`)),
    `Open questions: ${s.questions.filter((q) => q.state === "open").length}. Open incidents: ${s.openIncidents}.`,
    "",
    "Fill exactly the eight sections. Every item cites refs from the lists above. Where a KPI has no observation, say so under data_gaps; never state a number that is not in the snapshot. Between 5 and 7 top priorities.",
    "Produce the JSON object described in your instructions."
  ].join("\n");
}

export function briefingFixture(s: TenantSnapshot): BriefingDraft {
  const item = (text: string, refs: string[] = [], confidence = 0.6) => ({ text, refs, confidence });
  const openQ = s.questions.filter((q) => q.state === "open").length;
  const missing = s.kpis.filter((k) => k.latest_status !== "ok");
  return {
    summary: "Daily briefing compiled from the tenant snapshot (simulated).",
    what_changed: [item(`${s.findings.length} finding(s) and ${s.opportunities.length} opportunit(y/ies) are on record; ${s.actionTasks.length} action task(s) exist.`, s.findings.slice(0, 3).map((f) => f.id))],
    what_matters_today: [item(`${openQ} discovery question(s) wait for an answer from the organisation.`, [], 0.9)],
    decisions_needed: s.opportunities.filter((o) => o.state === "proposed").slice(0, 3).map((o) => item(`Decide on: ${o.title}`, [o.id], 0.7)),
    tasks_delegated: s.actionTasks.filter((t) => ["assigned", "in_progress"].includes(t.state)).slice(0, 3).map((t) => item(`${t.title} (owner ${t.owner_role ?? "unassigned"})`, [t.id], 0.8)),
    risks: s.findings.filter((f) => ["critical", "high"].includes(f.severity)).slice(0, 3).map((f) => item(`${f.title} (${f.claim})`, [f.id], 0.5)),
    opportunities: s.opportunities.slice(0, 3).map((o) => item(o.title, [o.id], 0.5)),
    data_gaps: missing.length ? missing.slice(0, 5).map((k) => item(`${k.name}: no data (${k.latest_status ?? "no observation"}), source ${k.source_system} not connected`, [k.key], 0.95)) : [item("All KPIs have fresh observations.", [], 0.5)],
    impact_of_prior_improvements: [item("No improvement has been delivered yet; the baseline is not measured.", [], 0.9)],
    top_priorities: ["Answer the open discovery questions", "Decide on the proposed opportunity", "Confirm which systems may be connected read-only", "Agree the definition of a closed project", "Review the high-severity findings"]
  };
}
