import { z } from "zod";
import { formatList, type TenantSnapshot } from "./snapshot";
import { wrapUntrusted } from "./runtime";

export const VerificationDraftSchema = z.object({
  summary: z.string().min(5).max(200),
  outcome: z.enum(["verified", "not_verified", "needs_owner_input"]),
  evidence_summary: z.string().min(5).max(600).describe("Which snapshot items support the outcome; say explicitly when no evidence exists"),
  question_for_owner: z.string().min(10).max(400).optional(),
  next_step: z.string().min(5).max(300)
});
export type VerificationDraft = z.infer<typeof VerificationDraftSchema>;

export function buildVerificationPrompt(s: TenantSnapshot, task: { id: string; title: string; proposedAction: string; ownerRole: string | null; state: string }): string {
  return [
    `Verify action task ${task.id}: "${task.title}". Proposed action: ${task.proposedAction}. Owner role: ${task.ownerRole ?? "unassigned"}. State: ${task.state}.`,
    "KPIs (key, latest status, value):",
    formatList(s.kpis, (k) => `${k.key}: ${k.latest_status ?? "no observation"} ${k.latest_value ?? ""}`),
    "Recent answers:",
    wrapUntrusted("answers", formatList(s.answers.slice(0, 10), (a) => `(${a.department}) Q: ${a.question_text} A: ${a.answer_text}`)),
    "",
    "Rules: only mark verified when the snapshot contains evidence that the action happened and changed something. Without evidence choose needs_owner_input and formulate one concrete question for the owner. Never assume completion.",
    "Produce the JSON object described in your instructions."
  ].join("\n");
}

export function verificationFixture(_s: TenantSnapshot, task: { title: string }): VerificationDraft {
  return {
    summary: "Verification found no evidence yet; asked the owner (simulated).",
    outcome: "needs_owner_input",
    evidence_summary: "No KPI observation or answer references the action; completion cannot be confirmed from the snapshot.",
    question_for_owner: `Has "${task.title}" been carried out? If yes, since when and what changed; if no, what is blocking it?`,
    next_step: "Re-verify after the owner answers or after the next KPI observation."
  };
}
