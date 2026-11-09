import { proposeOpportunity, upsertProcess } from "@sbos/core";
import { ProcessRedesignDraftSchema, buildProcessRedesignPrompt, processRedesignFixture, type ProcessRedesignDraft, type TenantSnapshot } from "@sbos/agents";
import type { BaseCheckpoint, Flow, StepOutcome } from "./types";
import { writeVaultNote } from "./shared";

interface Cp extends BaseCheckpoint {
  step: "generate" | "persist" | "done";
  snapshot?: TenantSnapshot;
  draft?: ProcessRedesignDraft;
  opportunityId?: string;
  approvalId?: string;
  asIsId?: string;
  toBeId?: string;
}
const next = (checkpoint: Cp): StepOutcome<Cp> => ({ kind: "next", checkpoint });

function stepsMarkdown(steps: ProcessRedesignDraft["as_is_steps"]): string {
  return ["| # | Kind | Step | Owner | System | Exceptions | Intervention |", "|---|---|---|---|---|---|---|", ...steps.map((s, i) => `| ${i + 1} | ${s.kind} | ${s.name} | ${s.owner_role ?? ""} | ${s.system_name ?? ""} | ${s.exceptions ?? ""} | ${s.intervention ?? ""} |`)].join("\n");
}

export const processRedesignFlow: Flow<Cp> = {
  key: "process-redesign",
  initial: () => ({ step: "generate" }),
  steps: {
    async generate(rt, cp) {
      const s = await rt.snapshot();
      if (s.findings.filter((f) => f.state === "open").length === 0) {
        await rt.event("note", "no open findings; nothing to redesign yet");
        return next({ ...cp, step: "done", snapshot: s });
      }
      await rt.event("tool_call", `read ${s.findings.length} findings, ${s.answers.length} answers (retrieval audited)`, { tools: ["systems.read", "questions.read", "vault.read"] });
      const out = await rt.generate({ schema: ProcessRedesignDraftSchema, prompt: buildProcessRedesignPrompt(s), fixture: () => processRedesignFixture(s), summary: "process redesign drafted" });
      return next({ ...cp, step: "persist", snapshot: s, draft: out.object });
    },
    async persist(rt, cp) {
      const { draft, snapshot: s } = cp as Required<Pick<Cp, "draft" | "snapshot">> & Cp;
      const findingIds = draft.opportunity.based_on_finding_indexes.map((i) => s.findings[i]?.id).filter((x): x is string => !!x);
      const sourceIds = [...new Set(s.answers.map((a) => a.source_id).filter((x): x is string => !!x))].slice(0, 20);
      if (sourceIds.length === 0) {
        await rt.event("note", "no answer sources available; opportunity not proposed", {}, "internal");
        return next({ ...cp, step: "done" });
      }
      const result = await rt.tx(async (tx) => {
        const asIsId = await upsertProcess(tx, rt.ctx, { tenantId: rt.tenant.id, key: draft.process_key, name: draft.process_name, department: draft.department, variant: "as_is", sourceIds, steps: draft.as_is_steps.map((x) => ({ kind: x.kind, name: x.name, ownerRole: x.owner_role, systemName: x.system_name, exceptions: x.exceptions })) });
        const toBeId = await upsertProcess(tx, rt.ctx, { tenantId: rt.tenant.id, key: draft.process_key, name: draft.process_name, department: draft.department, variant: "to_be", sourceIds, steps: draft.to_be_steps.map((x) => ({ kind: x.kind, name: x.name, ownerRole: x.owner_role, systemName: x.system_name, exceptions: x.exceptions, intervention: x.intervention })) });
        rt.gateway.authorize("approvals.request");
        const o = draft.opportunity;
        const { opportunityId, approvalId } = await proposeOpportunity(tx, rt.ctx, {
          tenantId: rt.tenant.id,
          title: o.title,
          description: o.description,
          findingIds,
          intervention: o.intervention,
          businessCase: { effort: o.effort, dependencies: o.dependencies, risks: o.risks, ...(o.estimated_saving_eur_per_year !== undefined ? { estimated_saving: { amount: o.estimated_saving_eur_per_year, currency: "EUR", is_estimate: true } } : {}), expected_kpi_changes: o.expected_kpi_changes.map((k) => ({ kpi_key: k.kpi_key, direction: k.direction, magnitude: k.magnitude })) },
          priorityScore: { impact: o.impact, feasibility: o.feasibility, risk: o.risk, time_to_value: o.time_to_value },
          sourceIds,
          confidence: 0.5,
          toBeProcessId: toBeId,
          agentInstanceId: rt.instance.id,
          runId: rt.run.id
        });
        return { asIsId, toBeId, opportunityId, approvalId };
      });
      await rt.event("approval_requested", `opportunity proposed for client admin decision: ${draft.opportunity.title.slice(0, 80)}`, { opportunityId: result.opportunityId, approvalId: result.approvalId }, "confidential");
      await writeVaultNote(rt, { path: `04_processes_as_is/${draft.process_key}.md`, title: `${draft.process_name} (AS-IS)`, frontmatter: { process_key: draft.process_key, variant: "as_is", department: draft.department, verification: "unconfirmed" }, body: `# ${draft.process_name} (AS-IS)\n\nReconstructed from answers only; every step is a client statement until evidence is attached.\n\n${stepsMarkdown(draft.as_is_steps)}`, changeNote: "process redesign agent" });
      await writeVaultNote(rt, { path: `05_processes_to_be/${draft.process_key}.md`, title: `${draft.process_name} (TO-BE)`, frontmatter: { process_key: draft.process_key, variant: "to_be", department: draft.department, opportunity_id: result.opportunityId, verification: "hypothesis" }, body: `# ${draft.process_name} (TO-BE)\n\nProposal awaiting approval. Intervention labels per step.\n\n${stepsMarkdown(draft.to_be_steps)}\n\n## Opportunity\n\n**${draft.opportunity.title}** (${draft.opportunity.intervention}, effort ${draft.opportunity.effort})\n\n${draft.opportunity.description}\n\n- Dependencies: ${draft.opportunity.dependencies.join("; ") || "none listed"}\n- Risks: ${draft.opportunity.risks.join("; ") || "none listed"}\n- Estimated saving: ${draft.opportunity.estimated_saving_eur_per_year !== undefined ? `EUR ${draft.opportunity.estimated_saving_eur_per_year} per year (estimate)` : "not estimated"}`, changeNote: "process redesign agent" });
      return next({ ...cp, step: "done", ...result });
    }
  },
  finalize: async (_rt, cp) => ({ summary: cp.draft?.summary ?? "No open findings to redesign", outputs: cp.opportunityId ? [{ contract: "Opportunity", ref_id: cp.opportunityId }] : [] })
};
