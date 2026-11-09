import { defineKpi, observeKpi, publishDashboard } from "@sbos/core";
import { CeoIntelligenceDraftSchema, buildCeoIntelligencePrompt, ceoIntelligenceFixture, type CeoIntelligenceDraft, type TenantSnapshot } from "@sbos/agents";
import type { BaseCheckpoint, Flow, StepOutcome } from "./types";
import { writeVaultNote } from "./shared";

interface Cp extends BaseCheckpoint {
  step: "generate" | "persist" | "done";
  snapshot?: TenantSnapshot;
  draft?: CeoIntelligenceDraft;
  kpiIds?: Record<string, string>;
  dashboardId?: string;
}
const next = (checkpoint: Cp): StepOutcome<Cp> => ({ kind: "next", checkpoint });

export const ceoIntelligenceFlow: Flow<Cp> = {
  key: "ceo-intelligence",
  initial: () => ({ step: "generate" }),
  steps: {
    async generate(rt, cp) {
      const s = await rt.snapshot();
      await rt.event("tool_call", `read snapshot: ${s.systems.length} systems, ${s.answers.length} answers, ${s.findings.length} findings, ${s.kpis.length} KPIs (retrieval audited)`, { tools: ["systems.read", "questions.read", "vault.read"] });
      const out = await rt.generate({ schema: CeoIntelligenceDraftSchema, prompt: buildCeoIntelligencePrompt(s), fixture: () => ceoIntelligenceFixture(s), summary: "KPI definitions and dashboard specification drafted" });
      return next({ ...cp, step: "persist", snapshot: s, draft: out.object });
    },
    async persist(rt, cp) {
      const { draft, snapshot: s } = cp as Required<Pick<Cp, "draft" | "snapshot">> & Cp;
      const registered = new Set(s.systems.map((x) => x.name.toLowerCase()));
      const result = await rt.tx(async (tx) => {
        rt.gateway.authorize("kpis.define");
        const kpiIds: Record<string, string> = {};
        for (const k of draft.kpis) {
          const internal = k.source_system === "second-brain";
          if (!internal && !registered.has(k.source_system.toLowerCase())) {
            await rt.event("note", `KPI ${k.key} skipped: source system "${k.source_system}" is not in the register`, {}, "internal");
            continue;
          }
          const id = await defineKpi(tx, rt.ctx, { tenantId: rt.tenant.id, key: k.key, name: k.name, businessQuestion: k.business_question, formula: k.formula, unit: k.unit, sourceSystem: k.source_system, sourceField: k.source_field, ownerRole: k.owner_role, refresh: k.refresh, direction: k.direction, warningThreshold: k.warning_threshold ?? null, criticalThreshold: k.critical_threshold ?? null, reliability: k.reliability, status: internal ? "active" : "missing_source" });
          kpiIds[k.key] = id;
          const now = new Date();
          if (internal && k.key === "open_discovery_questions") {
            const openCount = s.questions.filter((q) => q.state === "open").length;
            await observeKpi(tx, rt.ctx, { tenantId: rt.tenant.id, kpiId: id, periodStart: now, periodEnd: now, status: "ok", value: openCount, lineage: { query_or_formula: "count(questions where state = open)", source_record_ids: s.questions.filter((q) => q.state === "open").map((q) => q.id) }, runId: rt.run.id });
          } else {
            await observeKpi(tx, rt.ctx, { tenantId: rt.tenant.id, kpiId: id, periodStart: now, periodEnd: now, status: "missing_data", lineage: { query_or_formula: k.formula, source_record_ids: [] }, runId: rt.run.id });
          }
        }
        const spec = {
          dashboard_id: crypto.randomUUID(),
          tenant_id: rt.tenant.id,
          audience_role: "ceo",
          title: `CEO Dashboard: ${rt.tenant.name}`,
          locale: s.company.locale === "nl" || s.company.locale === "pap" ? s.company.locale : "en",
          widgets: draft.widgets.map((w) => ({ widget_id: crypto.randomUUID(), type: w.type, kpi_ids: w.kpi_keys.map((key) => kpiIds[key]).filter((x): x is string => !!x), priority: w.priority, reason: w.reason, size: w.size })),
          generated_by: rt.instance.id,
          version: 1,
          review_status: "unreviewed"
        };
        const dash = await publishDashboard(tx, rt.ctx, { tenantId: rt.tenant.id, specification: spec, agentInstanceId: rt.instance.id, runId: rt.run.id });
        return { kpiIds, dashboardId: dash.dashboardId, version: dash.version };
      });
      await rt.event("output_written", `${Object.keys(result.kpiIds).length} KPI(s) defined, dashboard v${result.version} published (spec validated)`, { dashboardId: result.dashboardId }, "internal");
      await writeVaultNote(rt, {
        path: "12_kpis_and_reports/kpi-registry.md",
        title: "KPI Registry",
        frontmatter: { kpis: Object.keys(result.kpiIds), dashboard_id: result.dashboardId, verification: "hypothesis" },
        body: ["# KPI Registry", "", "Decision needs discovered:", ...draft.decision_needs.map((d) => `- ${d}`), "", "| Key | Name | Question | Formula | Source | Field | Owner | Refresh |", "|---|---|---|---|---|---|---|---|", ...draft.kpis.filter((k) => result.kpiIds[k.key]).map((k) => `| ${k.key} | ${k.name} | ${k.business_question} | ${k.formula} | ${k.source_system} | ${k.source_field} | ${k.owner_role} | ${k.refresh} |`), "", "No source is connected yet: every external KPI shows **Missing data** on the dashboard until a consented connection delivers observations."].join("\n"),
        changeNote: "CEO Intelligence agent"
      });
      return next({ ...cp, step: "done", kpiIds: result.kpiIds, dashboardId: result.dashboardId });
    }
  },
  finalize: async (_rt, cp) => ({ summary: cp.draft?.summary ?? "CEO intelligence completed", outputs: [...Object.values(cp.kpiIds ?? {}).map((id) => ({ contract: "KpiDefinition", ref_id: id })), ...(cp.dashboardId ? [{ contract: "DashboardSpecification", ref_id: cp.dashboardId }] : [])] })
};
