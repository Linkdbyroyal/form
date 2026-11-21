import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@sbos/db";
import { RunFailure, createRun, createTask, listChildRuns, lockRun, pendingChildren, queueNotification, transitionRun } from "@sbos/core";
import { VentureAnalysisSchema, VentureIdeasDraftSchema, VentureScorecardSchema, buildVentureIdeasPrompt, buildVentureScorecardPrompt, selectVentures, ventureIdeasFixture, ventureScorecardFixture, type VentureAnalysis, type VentureBrief, type VentureIdeasDraft, type VentureLabContext, type VentureScorecard } from "@sbos/agents";
import type { BaseCheckpoint, Flow, StepOutcome } from "./types";
import { writeVaultNote } from "./shared";
import { readLabFocus, readVentureLabContext, slugify } from "./venture-shared";

const { agentInstances, agentDefinitions, opportunities, memberships } = schema;

/** How many ideas a lab run analyses in parallel; overridable per instance through `agent_instances.config.max_ventures`. */
export const DEFAULT_MAX_VENTURES = 6;

interface Cp extends BaseCheckpoint {
  step: "ideate" | "dispatch" | "collect" | "synthesize" | "done";
  focus?: string;
  context?: VentureLabContext;
  draft?: VentureIdeasDraft;
  briefs?: VentureBrief[];
  childRunIds?: string[];
  analyses?: Array<{ opportunityId: string; runId: string; analysis: VentureAnalysis }>;
  scorecard?: VentureScorecard;
  docPath?: string;
}
const next = (checkpoint: Cp): StepOutcome<Cp> => ({ kind: "next", checkpoint });

/**
 * Venture Lab orchestrator (ADR-025). ideate: read agency knowledge and portfolio pattern, generate ideas, select the
 * strongest. dispatch: one task and one child run per idea on the Venture Analyst instances (parent_run_id set).
 * collect: lock own row, count children still alive; suspend in waiting_for_input until the last child wakes us.
 * synthesize: read the analysts' opportunities, write the scorecard note, notify the owner. Nothing starts without
 * a human decision: every venture is an opportunity awaiting approval.
 */
export const ventureLabFlow: Flow<Cp> = {
  key: "venture-lab",
  initial: () => ({ step: "ideate" }),
  steps: {
    async ideate(rt, cp) {
      const configured = Number((rt.instance.config as Record<string, unknown> | null)?.max_ventures);
      const maxVentures = Number.isFinite(configured) && configured >= 1 && configured <= 12 ? Math.floor(configured) : DEFAULT_MAX_VENTURES;
      const focus = await readLabFocus(rt);
      const context = await readVentureLabContext(rt, focus, maxVentures);
      const out = await rt.generate({ schema: VentureIdeasDraftSchema, prompt: buildVentureIdeasPrompt(context), fixture: () => ventureIdeasFixture(context), summary: "venture ideas generated", maxOutputTokens: 6000 });
      const selected = selectVentures(out.object.ideas, maxVentures);
      const briefs: VentureBrief[] = selected.map((idea, i) => ({ ...idea, index: i + 1, focus, lab_run_id: rt.run.id }));
      await rt.event("note", `${out.object.ideas.length} idea(s) generated, ${briefs.length} selected for analysis`, { selected: briefs.map((b) => b.title) }, "internal");
      return next({ ...cp, step: "dispatch", focus, context, draft: out.object, briefs });
    },
    async dispatch(rt, cp) {
      const briefs = cp.briefs ?? [];
      const childRunIds = await rt.tx(async (tx) => {
        rt.gateway.authorize("runs.delegate");
        const analysts = await tx
          .select({ id: agentInstances.id, state: agentInstances.state, name: agentInstances.name })
          .from(agentInstances)
          .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentInstances.definitionId))
          .where(and(eq(agentInstances.tenantId, rt.tenant.id), eq(agentDefinitions.key, "venture-analyst"), inArray(agentInstances.state, ["idle", "active", "running", "blocked", "error"])))
          .orderBy(agentInstances.name);
        if (analysts.length === 0) throw new RunFailure("policy", "no Venture Analyst instance is available in this tenant (all paused or disabled, or none activated)");
        const ids: string[] = [];
        for (const brief of briefs) {
          const analyst = analysts[(brief.index - 1) % analysts.length]!;
          const taskId = await createTask(tx, rt.ctx, {
            tenantId: rt.tenant.id,
            agentInstanceId: analyst.id,
            title: `Venture ${brief.index}: ${brief.title}`,
            instruction: `Analyse venture idea "${brief.title}" for the agency. ${brief.one_liner}`,
            department: rt.definition.department,
            priority: "medium",
            createdBy: { actorType: "agent", actorId: rt.instance.serviceIdentity },
            metadata: { venture_brief: brief, parent_run_id: rt.run.id, lab: "venture-lab" }
          });
          const { runId } = await createRun(tx, rt.ctx, rt.jobs, { tenantId: rt.tenant.id, agentInstanceId: analyst.id, trigger: "event", triggerRef: `delegation:${rt.run.id}`, taskId, parentRunId: rt.run.id });
          ids.push(runId);
        }
        return ids;
      });
      await rt.event("note", `delegated ${childRunIds.length} venture analysis run(s) to the Venture Analysts`, { childRunIds }, "internal");
      return next({ ...cp, step: "collect", childRunIds });
    },
    async collect(rt, cp) {
      // Lock our own row first: a child that finishes concurrently waits on this lock inside wakeParentRun, then sees
      // us waiting and re-queues us; a child that finished before the lock is counted as terminal here.
      const pending = await rt.tx(async (tx) => {
        await lockRun(tx, rt.tenant.id, rt.run.id);
        const children = await listChildRuns(tx, rt.tenant.id, rt.run.id);
        const n = pendingChildren(children);
        if (n > 0) await transitionRun(tx, { tenantId: rt.tenant.id, runId: rt.run.id, to: "waiting_for_input", summary: `waiting for ${n} delegated run(s)`, payload: { pending: n } });
        return n;
      });
      if (pending > 0) return { kind: "suspend", checkpoint: { ...cp, step: "collect" }, reason: `waiting for ${pending} delegated run(s)` };
      return next({ ...cp, step: "synthesize" });
    },
    async synthesize(rt, cp) {
      const context = cp.context!;
      const children = await rt.tx((tx) => listChildRuns(tx, rt.tenant.id, rt.run.id));
      const refs = children.flatMap((c) => {
        const outputs = (c.result as { outputs?: Array<{ contract: string; ref_id: string }> } | null)?.outputs ?? [];
        return outputs.filter((o) => o.contract === "Opportunity").map((o) => ({ runId: c.id, opportunityId: o.ref_id }));
      });
      const rows = refs.length > 0 ? await rt.tx((tx) => tx.select({ id: opportunities.id, businessCase: opportunities.businessCase }).from(opportunities).where(inArray(opportunities.id, refs.map((r) => r.opportunityId)))) : [];
      const analyses: NonNullable<Cp["analyses"]> = [];
      for (const r of refs) {
        const row = rows.find((x) => x.id === r.opportunityId);
        const parsed = VentureAnalysisSchema.safeParse((row?.businessCase as { analysis?: unknown } | null)?.analysis);
        if (parsed.success) analyses.push({ opportunityId: r.opportunityId, runId: r.runId, analysis: parsed.data });
      }
      const failed = children.filter((c) => c.state !== "succeeded");
      await rt.event("tool_call", `collected ${analyses.length} analysis result(s) from ${children.length} delegated run(s); ${failed.length} did not succeed`, { tools: ["vault.read"] });
      const date = new Date().toISOString().slice(0, 10);
      const docPath = `01_strategy_and_goals/venture-lab-${date}-${rt.run.id.slice(0, 8)}.md`;
      if (analyses.length === 0) {
        await writeVaultNote(rt, { path: docPath, title: `Venture Lab ${date}: no analyses finished`, frontmatter: { lab_run_id: rt.run.id, analysed: 0, verification: "unconfirmed" }, body: `# Venture Lab ${date}\n\nNo venture analysis finished. ${failed.length} delegated run(s) ended in ${[...new Set(failed.map((f) => f.state))].join(", ") || "an unknown state"}. See the Run Inspector for the delegated runs.`, changeNote: "Venture Lab orchestrator" });
        return next({ ...cp, step: "done", analyses, docPath });
      }
      const out = await rt.generate({ schema: VentureScorecardSchema, prompt: buildVentureScorecardPrompt(analyses.map((a) => a.analysis), context), fixture: () => ventureScorecardFixture(analyses.map((a) => a.analysis), context), summary: "scorecard written" });
      const card = out.object;
      const byTitle = new Map(analyses.map((a) => [a.analysis.title.toLowerCase(), a]));
      const body = [
        `# Venture Lab ${date}`,
        "",
        `> Lab focus: ${cp.focus ?? ""}`,
        `> ${analyses.length} of ${children.length} delegated analyses finished. Every venture below is an opportunity awaiting approval in Mission Control; nothing has started. ${rt.simulated ? "Model: simulated (no API key)." : `Model: ${rt.model}.`}`,
        "",
        `## ${card.headline}`,
        "",
        "| # | Venture | Recommendation | Verdict | Impact | Feasibility | Risk | Time to value | Confidence | Opportunity |",
        "|---|---|---|---|---|---|---|---|---|---|",
        ...card.ranking.map((r, i) => {
          const a = byTitle.get(r.title.toLowerCase());
          const s = a?.analysis.scores;
          return `| ${i + 1} | ${r.title} | ${r.recommendation} | ${r.verdict} | ${s?.impact ?? ""} | ${s?.feasibility ?? ""} | ${s?.risk ?? ""} | ${s?.time_to_value ?? ""} | ${a?.analysis.confidence ?? ""} | ${a ? a.opportunityId.slice(0, 8) : "n/a"} |`;
        }),
        "",
        "## Recommended next step",
        card.recommended_next_step,
        "",
        "## Decision requested",
        card.decision_request,
        "",
        "## Caveats",
        ...card.caveats.map((c) => `- ${c}`),
        "",
        "## Ideas generated, not analysed",
        ...(cp.draft?.ideas ?? []).filter((i) => !(cp.briefs ?? []).some((b) => b.title === i.title)).map((i) => `- ${i.title} (${i.offer_type}, fit ${i.fit_score}/10): ${i.one_liner}`),
        "",
        "## Analyses",
        ...analyses.flatMap((a) => [`### ${a.analysis.title}`, "", `Hypothesis: ${a.analysis.hypothesis}`, "", `Evidence: ${a.analysis.problem_evidence}. Recommendation: ${a.analysis.recommendation} (confidence ${a.analysis.confidence}).`, "", `First experiment: ${a.analysis.first_experiments[0]?.name ?? "none"} (${a.analysis.first_experiments[0]?.metric ?? ""}, threshold ${a.analysis.first_experiments[0]?.success_threshold ?? ""}).`, "", `Note: 01_strategy_and_goals/venture-${rt.run.id.slice(0, 8)}-${slugify(a.analysis.title)}.md`, ""])
      ].join("\n");
      await writeVaultNote(rt, { path: docPath, title: `Venture Lab ${date}: ${card.headline.slice(0, 80)}`, frontmatter: { lab_run_id: rt.run.id, analysed: analyses.length, delegated: children.length, opportunity_ids: analyses.map((a) => a.opportunityId), verification: "hypothesis" }, body, changeNote: "Venture Lab orchestrator" });
      await rt.tx(async (tx) => {
        const owners = await tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.tenantId, rt.tenant.id), eq(memberships.roleKey, "superadmin")));
        for (const o of owners) {
          await queueNotification(tx, rt.jobs, { tenantId: rt.tenant.id, channel: "email", template: "venture_lab.scorecard", subject: `Venture Lab scorecard ready: ${analyses.length} venture(s) analysed, your decision is requested`, payload: { runId: rt.run.id, tenantSlug: rt.tenant.slug, analysed: analyses.length }, recipientRole: "superadmin", recipientUserId: o.userId });
        }
        await queueNotification(tx, rt.jobs, { tenantId: rt.tenant.id, channel: "pumble", template: "venture_lab.scorecard", subject: `Venture Lab scorecard ready (${analyses.length} venture(s) analysed overnight)`, payload: { runId: rt.run.id, tenantSlug: rt.tenant.slug, analysed: analyses.length } });
      });
      await rt.event("note", "owner notified: scorecard ready, decision requested", {}, "internal");
      return next({ ...cp, step: "done", analyses, scorecard: card, docPath });
    }
  },
  finalize: async (_rt, cp) => ({
    summary: cp.scorecard?.headline ?? (cp.analyses && cp.analyses.length === 0 ? "Venture Lab finished without analyses" : "Venture Lab completed"),
    outputs: (cp.analyses ?? []).map((a) => ({ contract: "Opportunity", ref_id: a.opportunityId }))
  })
};
