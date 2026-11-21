import { eq } from "drizzle-orm";
import { schema } from "@sbos/db";
import { RunFailure, proposeOpportunity } from "@sbos/core";
import { VentureAnalysisSchema, VentureBriefSchema, buildVentureAnalysisPrompt, ventureAnalysisFixture, type VentureAnalysis, type VentureBrief, type VentureLabContext } from "@sbos/agents";
import type { BaseCheckpoint, Flow, StepOutcome } from "./types";
import { writeVaultNote } from "./shared";
import { readVentureLabContext, slugify } from "./venture-shared";

const { agentTasks, sources } = schema;

interface Cp extends BaseCheckpoint {
  step: "analyse" | "persist" | "done";
  brief?: VentureBrief;
  context?: VentureLabContext;
  analysis?: VentureAnalysis;
  opportunityId?: string;
  approvalId?: string;
  docPath?: string;
}
const next = (checkpoint: Cp): StepOutcome<Cp> => ({ kind: "next", checkpoint });

/** Process intervention label that best describes the venture's shape (the opportunity schema requires one). */
export function interventionFor(offerType: VentureBrief["offer_type"]): "stop" | "simplify" | "standardize" | "integrate" | "automate" | "keep_human" {
  switch (offerType) {
    case "software":
      return "automate";
    case "partnership":
      return "integrate";
    case "service_line":
      return "keep_human";
    default:
      return "standardize";
  }
}

/**
 * Venture Analyst (ADR-025): a delegated child run. The brief arrives in the task's metadata, the context is read in
 * agency scope, the analysis becomes an Opportunity awaiting the owner's approval plus a vault note. The parent run is
 * woken by the executor when this run reaches a terminal state.
 */
export const ventureAnalystFlow: Flow<Cp> = {
  key: "venture-analyst",
  initial: () => ({ step: "analyse" }),
  steps: {
    async analyse(rt, cp) {
      if (!rt.run.taskId) throw new RunFailure("policy", "a Venture Analyst run needs a delegated task that carries the venture brief");
      const brief = await rt.tx(async (tx) => {
        const [task] = await tx.select({ metadata: agentTasks.metadata }).from(agentTasks).where(eq(agentTasks.id, rt.run.taskId!));
        const parsed = VentureBriefSchema.safeParse((task?.metadata as { venture_brief?: unknown } | null)?.venture_brief);
        if (!parsed.success) throw new RunFailure("validation", "the task carries no valid venture brief");
        return parsed.data;
      });
      const context = await readVentureLabContext(rt, brief.focus, 1);
      const out = await rt.generate({ schema: VentureAnalysisSchema, prompt: buildVentureAnalysisPrompt(brief, context), fixture: () => ventureAnalysisFixture(brief, context), summary: `venture ${brief.index} analysed`, maxOutputTokens: 4000 });
      return next({ ...cp, step: "persist", brief, context, analysis: out.object });
    },
    async persist(rt, cp) {
      const { brief, analysis } = cp as Required<Pick<Cp, "brief" | "analysis">> & Cp;
      const result = await rt.tx(async (tx) => {
        const [src] = await tx.insert(sources).values({ tenantId: rt.tenant.id, system: "venture-lab", locator: `run:${brief.lab_run_id}`, retrievedAt: new Date(), classification: "internal", createdByActorType: "agent", createdByActorId: rt.instance.serviceIdentity, metadata: { venture_index: brief.index } }).returning({ id: sources.id });
        rt.gateway.authorize("approvals.request");
        return proposeOpportunity(tx, rt.ctx, {
          tenantId: rt.tenant.id,
          title: analysis.title,
          description: `${analysis.hypothesis} Offer: ${analysis.offer} Recommendation: ${analysis.recommendation}.`.slice(0, 2000),
          findingIds: [],
          intervention: interventionFor(brief.offer_type),
          businessCase: { kind: "venture", lab_run_id: brief.lab_run_id, venture_index: brief.index, offer_type: brief.offer_type, analysis, is_estimate: true },
          priorityScore: analysis.scores,
          sourceIds: [src!.id],
          confidence: analysis.confidence,
          agentInstanceId: rt.instance.id,
          runId: rt.run.id,
          approverRole: "superadmin"
        });
      });
      await rt.event("approval_requested", `venture proposed as opportunity for the owner's decision: ${analysis.title.slice(0, 80)} (${analysis.recommendation})`, { opportunityId: result.opportunityId, approvalId: result.approvalId }, "internal");
      const docPath = `01_strategy_and_goals/venture-${brief.lab_run_id.slice(0, 8)}-${slugify(analysis.title)}.md`;
      const ue = analysis.unit_economics;
      await writeVaultNote(rt, {
        path: docPath,
        title: `Venture: ${analysis.title}`,
        frontmatter: { lab_run_id: brief.lab_run_id, venture_index: brief.index, opportunity_id: result.opportunityId, recommendation: analysis.recommendation, verification: "hypothesis" },
        body: [
          `# ${analysis.title}`,
          "",
          `> Venture ${brief.index} of the lab run ${brief.lab_run_id.slice(0, 8)}. Opportunity ${result.opportunityId.slice(0, 8)} awaits approval; nothing has started. ${rt.simulated ? "Model: simulated (no API key)." : `Model: ${rt.model}.`}`,
          "",
          `**Hypothesis.** ${analysis.hypothesis}`,
          "",
          `**Target customer.** ${analysis.target_customer}`,
          "",
          `**Evidence for the problem.** ${analysis.problem_evidence}`,
          "",
          `**Offer.** ${analysis.offer}`,
          "",
          `**Pricing model.** ${analysis.pricing_model}`,
          "",
          `**Unit economics (estimate).** ${ue.price_point_eur !== undefined ? `Price point EUR ${ue.price_point_eur}. ` : ""}${ue.cost_to_deliver_eur !== undefined ? `Cost to deliver EUR ${ue.cost_to_deliver_eur}. ` : ""}${ue.margin_note}`,
          "",
          "## Go to market",
          ...analysis.go_to_market.map((g) => `- ${g}`),
          "",
          "## First experiments",
          "| Experiment | Metric | Success threshold | Days |",
          "|---|---|---|---|",
          ...analysis.first_experiments.map((e) => `| ${e.name} | ${e.metric} | ${e.success_threshold} | ${e.duration_days} |`),
          "",
          "## Risks",
          ...analysis.risks.map((r) => `- ${r}`),
          "",
          "## Required capabilities",
          ...(analysis.required_capabilities.length > 0 ? analysis.required_capabilities.map((r) => `- ${r}`) : ["- none listed"]),
          "",
          "## Reuses",
          ...(analysis.uses_existing_assets.length > 0 ? analysis.uses_existing_assets.map((r) => `- ${r}`) : ["- nothing listed"]),
          "",
          `## Scores and recommendation`,
          `Impact ${analysis.scores.impact}, feasibility ${analysis.scores.feasibility}, risk ${analysis.scores.risk}, time to value ${analysis.scores.time_to_value}. Recommendation: **${analysis.recommendation}** (confidence ${analysis.confidence}).`
        ].join("\n"),
        changeNote: "Venture Analyst"
      });
      return next({ ...cp, step: "done", opportunityId: result.opportunityId, approvalId: result.approvalId, docPath });
    }
  },
  finalize: async (_rt, cp) => ({ summary: cp.analysis?.summary ?? "Venture analysis completed", outputs: cp.opportunityId ? [{ contract: "Opportunity", ref_id: cp.opportunityId }] : [] })
};
