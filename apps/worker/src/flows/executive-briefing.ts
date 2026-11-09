import { storeBriefing } from "@sbos/core";
import { BriefingDraftSchema, briefingFixture, buildBriefingPrompt, type BriefingDraft, type TenantSnapshot } from "@sbos/agents";
import type { BaseCheckpoint, Flow, StepOutcome } from "./types";
import { writeVaultNote } from "./shared";

interface Cp extends BaseCheckpoint {
  step: "generate" | "persist" | "done";
  snapshot?: TenantSnapshot;
  draft?: BriefingDraft;
  briefingId?: string;
  date?: string;
}
const next = (checkpoint: Cp): StepOutcome<Cp> => ({ kind: "next", checkpoint });
const SECTIONS = ["what_changed", "what_matters_today", "decisions_needed", "tasks_delegated", "risks", "opportunities", "data_gaps", "impact_of_prior_improvements"] as const;

export const executiveBriefingFlow: Flow<Cp> = {
  key: "executive-briefing",
  initial: () => ({ step: "generate", date: new Date().toISOString().slice(0, 10) }),
  steps: {
    async generate(rt, cp) {
      const s = await rt.snapshot();
      await rt.event("tool_call", `read snapshot for briefing: ${s.kpis.length} KPIs, ${s.findings.length} findings, ${s.actionTasks.length} tasks (retrieval audited)`, { tools: ["systems.read", "questions.read", "vault.read"] });
      const out = await rt.generate({ schema: BriefingDraftSchema, prompt: buildBriefingPrompt(s, cp.date!), fixture: () => briefingFixture(s), summary: "briefing drafted" });
      return next({ ...cp, step: "persist", snapshot: s, draft: out.object });
    },
    async persist(rt, cp) {
      const { draft } = cp as Required<Pick<Cp, "draft">> & Cp;
      const sectionItems = (items: BriefingDraft["risks"]) => items.map((i) => ({ text: i.text, source_ids: i.refs.filter((r) => /^[0-9a-f-]{36}$/i.test(r)), confidence: i.confidence }));
      const briefing = {
        tenant_id: rt.tenant.id,
        source_ids: [rt.run.id],
        confidence: 0.6,
        generated_at: new Date().toISOString(),
        review_status: "unreviewed",
        permissions_context: { tenant_id: rt.tenant.id, actor_type: "agent", actor_id: rt.instance.serviceIdentity, roles: ["agent_service"], scopes: rt.gateway.list(), cross_tenant_content_authorized: false },
        agent_id: rt.instance.id,
        run_id: rt.run.id,
        briefing_id: crypto.randomUUID(),
        briefing_date: cp.date,
        sections: Object.fromEntries(SECTIONS.map((k) => [k, sectionItems(draft[k])])),
        top_priorities: draft.top_priorities
      };
      const note = await writeVaultNote(rt, {
        path: `12_kpis_and_reports/briefing-${cp.date}.md`,
        title: `Executive briefing ${cp.date}`,
        frontmatter: { briefing_date: cp.date, verification: "hypothesis", sections: SECTIONS.length },
        body: [`# Executive briefing ${cp.date}`, "", "## Top priorities", ...draft.top_priorities.map((p, i) => `${i + 1}. ${p}`), "", ...SECTIONS.flatMap((k) => [`## ${k.replace(/_/g, " ")}`, ...(draft[k].length ? draft[k].map((i) => `- ${i.text} (confidence ${i.confidence}${i.refs.length ? `; refs ${i.refs.join(", ")}` : ""})`) : ["- nothing to report"]), ""])].join("\n"),
        changeNote: "Executive briefing agent"
      });
      const stored = await rt.tx((tx) => storeBriefing(tx, rt.ctx, { tenantId: rt.tenant.id, briefing, vaultDocumentId: note.documentId ?? null, agentInstanceId: rt.instance.id, runId: rt.run.id, simulated: rt.simulated }));
      await rt.event("output_written", `executive briefing stored for ${cp.date} (${draft.top_priorities.length} priorities)`, { briefingId: stored.briefingId });
      return next({ ...cp, step: "done", briefingId: stored.briefingId });
    }
  },
  finalize: async (_rt, cp) => ({ summary: cp.draft?.summary ?? "Briefing completed", outputs: cp.briefingId ? [{ contract: "ExecutiveBriefing", ref_id: cp.briefingId }] : [] })
};
