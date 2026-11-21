import { z } from "zod";
import { formatList } from "./snapshot";
import { wrapUntrusted } from "./runtime";

/**
 * Venture Lab (ADR-025): the agency explores many service and venture ideas at once instead of one at a time.
 * An orchestrator run generates candidate ideas from the agency's own knowledge and client portfolio pattern,
 * selects the strongest, delegates one analysis per idea to Venture Analyst child runs (`agent_runs.parent_run_id`),
 * and synthesises a scorecard. Humans decide; every analysed idea becomes an Opportunity awaiting approval.
 * Agency-only: the flow refuses any tenant whose kind is not `agency`, and it never reads client vaults.
 */

export const OFFER_TYPES = ["service_line", "productized_service", "software", "content", "training", "partnership", "other"] as const;

/** Read-only context assembled by the worker in agency scope. Client names never appear; only industry patterns. */
export interface VentureLabContext {
  agency: { name: string; industry: string | null; locale: string };
  /** The theme for this lab run: task or schedule instruction, or the default focus. */
  focus: string;
  /** Client portfolio pattern: industry, kind and status per tenant, no names and no client content. */
  portfolio: Array<{ industry: string | null; kind: string; status: string }>;
  /** Published agency knowledge records (own knowledge and explicitly released generic insights). */
  knowledge: Array<{ path: string; title: string; kind: string; excerpt: string }>;
  /** Existing opportunities of the agency tenant, so the lab does not propose the same idea twice. */
  priorIdeas: Array<{ title: string; state: string }>;
  /** Agency's own verified or hypothesis facts, through the retrieval audit. */
  facts: Array<{ statement: string; verification: string }>;
  /** How many ideas the lab analyses in parallel (default 6). */
  maxVentures: number;
}

export const VentureIdeaSchema = z.object({
  title: z.string().min(5).max(80),
  one_liner: z.string().min(10).max(200),
  customer_segment: z.string().min(3).max(120),
  problem: z.string().min(10).max(400),
  offer_type: z.enum(OFFER_TYPES),
  why_now: z.string().min(5).max(300),
  /** Fit with the agency's capabilities and knowledge, 1 (poor) to 10 (we could start tomorrow). */
  fit_score: z.int().min(1).max(10),
  evidence_gap: z.string().min(5).max(300).describe("What we do not know yet; the analyst must address it"),
  knowledge_refs: z.array(z.string().max(200)).max(5).describe("Paths of agency knowledge records the idea builds on")
});
export type VentureIdea = z.infer<typeof VentureIdeaSchema>;

export const VentureIdeasDraftSchema = z.object({
  summary: z.string().min(5).max(200).describe("Neutral summary without client names"),
  lens: z.string().min(5).max(400).describe("How the ideas were generated: which patterns, which knowledge, which constraints"),
  ideas: z.array(VentureIdeaSchema).min(6).max(30)
});
export type VentureIdeasDraft = z.infer<typeof VentureIdeasDraftSchema>;

/** What the orchestrator hands to each analyst through the child task's metadata. */
export const VentureBriefSchema = VentureIdeaSchema.extend({
  index: z.int().min(1),
  focus: z.string().max(2000),
  lab_run_id: z.string()
});
export type VentureBrief = z.infer<typeof VentureBriefSchema>;

export const VentureAnalysisSchema = z.object({
  summary: z.string().min(5).max(200),
  title: z.string().min(5).max(80),
  hypothesis: z.string().min(10).max(400).describe("One falsifiable statement: who pays for what, and why"),
  target_customer: z.string().min(5).max(200),
  problem_evidence: z.enum(["agency_knowledge", "portfolio_pattern", "assumption"]).describe("Where the evidence for the problem comes from; assumption when nothing in the context supports it"),
  offer: z.string().min(10).max(600),
  pricing_model: z.string().min(5).max(300),
  unit_economics: z.object({
    price_point_eur: z.number().min(0).optional(),
    cost_to_deliver_eur: z.number().min(0).optional(),
    margin_note: z.string().min(5).max(300),
    is_estimate: z.literal(true)
  }),
  go_to_market: z.array(z.string().min(5).max(200)).min(1).max(5),
  first_experiments: z
    .array(
      z.object({
        name: z.string().min(5).max(120),
        metric: z.string().min(3).max(120),
        success_threshold: z.string().min(1).max(120),
        duration_days: z.int().min(1).max(90)
      })
    )
    .min(1)
    .max(4),
  risks: z.array(z.string().min(5).max(200)).min(1).max(5),
  required_capabilities: z.array(z.string().min(3).max(120)).max(6),
  uses_existing_assets: z.array(z.string().min(3).max(120)).max(6).describe("Agency knowledge, templates or agents the venture reuses"),
  scores: z.object({ impact: z.int().min(1).max(10), feasibility: z.int().min(1).max(10), risk: z.int().min(1).max(10), time_to_value: z.int().min(1).max(10) }),
  recommendation: z.enum(["pursue", "experiment", "park", "drop"]),
  confidence: z.number().min(0).max(1)
});
export type VentureAnalysis = z.infer<typeof VentureAnalysisSchema>;

export const VentureScorecardSchema = z.object({
  headline: z.string().min(10).max(200),
  ranking: z
    .array(
      z.object({
        title: z.string().min(5).max(80),
        verdict: z.string().min(5).max(200),
        recommendation: z.enum(["pursue", "experiment", "park", "drop"])
      })
    )
    .min(1)
    .max(12),
  recommended_next_step: z.string().min(10).max(400),
  decision_request: z.string().min(10).max(400).describe("The one question the owner has to answer"),
  caveats: z.array(z.string().min(5).max(200)).max(5)
});
export type VentureScorecard = z.infer<typeof VentureScorecardSchema>;

export const DEFAULT_LAB_FOCUS = "Service lines, productised offers and ventures the agency could launch for small and medium businesses in the next twelve months.";

export function selectVentures(ideas: VentureIdea[], max: number): VentureIdea[] {
  // Highest fit first; ties keep the model's order. One idea per title.
  const seen = new Set<string>();
  return [...ideas]
    .map((idea, i) => ({ idea, i }))
    .sort((a, b) => b.idea.fit_score - a.idea.fit_score || a.i - b.i)
    .map((x) => x.idea)
    .filter((idea) => {
      const key = idea.title.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, max));
}

function portfolioSummary(portfolio: VentureLabContext["portfolio"]): string {
  const byIndustry = new Map<string, number>();
  for (const p of portfolio) byIndustry.set(p.industry ?? "unknown", (byIndustry.get(p.industry ?? "unknown") ?? 0) + 1);
  return formatList([...byIndustry.entries()].sort((a, b) => b[1] - a[1]), ([industry, n]) => `${industry}: ${n} client tenant(s)`);
}

export function buildVentureIdeasPrompt(c: VentureLabContext): string {
  return [
    `Agency: ${c.agency.name}, industry ${c.agency.industry ?? "consultancy"}, locale ${c.agency.locale}.`,
    `Lab focus: ${c.focus}`,
    "Client portfolio pattern (industries only; no client names or content are available to you):",
    portfolioSummary(c.portfolio),
    "Published agency knowledge (titles and excerpts):",
    wrapUntrusted("agency_knowledge", formatList(c.knowledge, (k) => `${k.path} [${k.kind}] ${k.title}: ${k.excerpt}`)),
    "Agency facts:",
    wrapUntrusted("agency_facts", formatList(c.facts, (f) => `[${f.verification}] ${f.statement}`)),
    "Ideas already on the table (never propose these again, build on them or skip them):",
    wrapUntrusted("prior_ideas", formatList(c.priorIdeas, (p) => `[${p.state}] ${p.title}`)),
    "",
    `Generate between 8 and 20 distinct venture ideas for the agency itself: service lines, productised services, software, content, training or partnerships. Each idea names the customer segment, the problem, why now, a fit score from 1 to 10 against the agency's current capabilities and knowledge, the evidence gap an analyst must close, and the knowledge paths it builds on. Spread the ideas across offer types; do not produce ten variants of one idea. The strongest ${c.maxVentures} will each be analysed by a separate analyst run overnight.`,
    "Produce the JSON object described in your instructions."
  ].join("\n");
}

export function buildVentureAnalysisPrompt(brief: VentureBrief, c: VentureLabContext): string {
  return [
    `Agency: ${c.agency.name}, industry ${c.agency.industry ?? "consultancy"}, locale ${c.agency.locale}.`,
    `Lab focus: ${brief.focus}`,
    `You analyse venture idea ${brief.index}: "${brief.title}".`,
    wrapUntrusted("venture_brief", [`One-liner: ${brief.one_liner}`, `Customer segment: ${brief.customer_segment}`, `Problem: ${brief.problem}`, `Offer type: ${brief.offer_type}`, `Why now: ${brief.why_now}`, `Fit score given by the orchestrator: ${brief.fit_score}/10`, `Evidence gap to close: ${brief.evidence_gap}`].join("\n")),
    "Client portfolio pattern (industries only):",
    portfolioSummary(c.portfolio),
    "Published agency knowledge you may reuse:",
    wrapUntrusted("agency_knowledge", formatList(c.knowledge, (k) => `${k.path} [${k.kind}] ${k.title}: ${k.excerpt}`)),
    "",
    "Test the idea as a founder would test six ventures in one night: state one falsifiable hypothesis, the target customer, where the evidence for the problem comes from (agency_knowledge, portfolio_pattern or assumption), the offer, the pricing model, unit economics as labelled estimates (omit numbers you cannot defend), go-to-market steps, one to four cheap first experiments with a metric and a success threshold, risks, required capabilities, the existing agency assets it reuses, scores from 1 to 10 for impact, feasibility, risk and time to value, and a recommendation: pursue, experiment, park or drop. Never invent client data, revenue figures or references.",
    "Produce the JSON object described in your instructions."
  ].join("\n");
}

export function buildVentureScorecardPrompt(analyses: VentureAnalysis[], c: VentureLabContext): string {
  return [
    `Agency: ${c.agency.name}. Lab focus: ${c.focus}`,
    `${analyses.length} venture analyses finished overnight. Each line: title | recommendation | impact/feasibility/risk/time_to_value | confidence | hypothesis.`,
    wrapUntrusted("analyses", formatList(analyses, (a) => `${a.title} | ${a.recommendation} | ${a.scores.impact}/${a.scores.feasibility}/${a.scores.risk}/${a.scores.time_to_value} | ${a.confidence} | ${a.hypothesis}`)),
    "",
    "Write the scorecard for the owner: a headline, a ranking with a one-line verdict and recommendation per venture (best first), the recommended next step for the coming week, the single decision the owner has to take, and caveats about evidence quality. Do not add ventures that were not analysed.",
    "Produce the JSON object described in your instructions."
  ].join("\n");
}

// Fixtures (simulated runtime) ----------------------------------------------------------------------------------

const FIXTURE_IDEAS: VentureIdea[] = [
  { title: "Second Brain Readiness Scan", one_liner: "A fixed-price two-week scan that maps systems, hand-offs and decision needs before any automation is sold.", customer_segment: "SME owners with 10 to 80 staff and three or more software systems", problem: "Owners buy automation before they know which process is broken; projects stall on missing data.", offer_type: "productized_service", why_now: "The discovery and X-ray agents already produce the scan artefacts; packaging is the missing piece.", fit_score: 9, evidence_gap: "Willingness to pay a fixed price for diagnosis without a build commitment.", knowledge_refs: ["04_discovery_questions_and_assessments/intake-round-1-universal.md"] },
  { title: "Closure-to-Invoice Gate for rental companies", one_liner: "Install the project closure to invoice readiness check as a subscription for equipment and event rental firms.", customer_segment: "Rental and event production companies on a project system", problem: "Finished projects wait days before an invoice goes out; nobody owns the closure check.", offer_type: "service_line", why_now: "A published process pattern and a live project-system connector exist.", fit_score: 8, evidence_gap: "How many rental firms in the region run a project system with an API.", knowledge_refs: ["06_process_patterns_and_sops/project-closure-invoice-readiness.md"] },
  { title: "Fractional AI Operations Lead", one_liner: "One day a week of an operator who runs the client's agents, approvals and KPIs from Mission Control.", customer_segment: "Companies that adopted the platform but have no internal owner", problem: "Agents stall on unanswered questions and unapproved actions when nobody watches the queue.", offer_type: "service_line", why_now: "Live Mission Control makes one operator effective across several clients.", fit_score: 8, evidence_gap: "Acceptable monthly fee versus a part-time hire.", knowledge_refs: [] },
  { title: "Hospitality back-office blueprint", one_liner: "An industry blueprint with interview sets, KPI definitions and process patterns for small hotels.", customer_segment: "Independent hotels and guesthouses with 20 to 150 rooms", problem: "Every hotel engagement starts from scratch; the same night audit and purchasing questions recur.", offer_type: "content", why_now: "A second hospitality tenant would pay back the blueprint immediately.", fit_score: 7, evidence_gap: "Enough generic hospitality knowledge exists to publish without client content.", knowledge_refs: [] },
  { title: "Agent operations training for managers", one_liner: "A half-day course on supervising AI agents: approvals, instructions, evidence and when to say no.", customer_segment: "Department managers in client companies and prospects", problem: "Managers approve or reject agent proposals without a shared method.", offer_type: "training", why_now: "Approval and instruction flows are live and demonstrable.", fit_score: 7, evidence_gap: "Whether managers will attend without an active engagement.", knowledge_refs: [] },
  { title: "Integration health check", one_liner: "A read-only check of a company's connectors, data freshness and failed syncs, delivered as a report.", customer_segment: "Companies with three or more connected tools and no IT lead", problem: "Broken integrations are discovered by the customer, not by the company.", offer_type: "productized_service", why_now: "Sync runs, lineage and staleness detection already exist in the platform.", fit_score: 7, evidence_gap: "Which systems prospects actually run beyond the four supported connectors.", knowledge_refs: [] },
  { title: "Executive intelligence report subscription", one_liner: "A monthly sourced briefing for the owner, assembled by the briefing agent and reviewed by a consultant.", customer_segment: "Owner-managers who do not read dashboards", problem: "Dashboards go unread; owners want the five things that changed.", offer_type: "productized_service", why_now: "The executive briefing agent produces the eight fixed sections today.", fit_score: 6, evidence_gap: "Whether a reviewed monthly report earns a recurring fee on its own.", knowledge_refs: [] },
  { title: "Accountant partner programme", one_liner: "Accounting firms refer clients for a process scan and share in the first-year fee.", customer_segment: "Regional accounting and bookkeeping firms", problem: "Accountants see invoicing problems first but have no partner to fix the process.", offer_type: "partnership", why_now: "Finance findings and the closure gate speak the accountant's language.", fit_score: 6, evidence_gap: "Referral terms accountants accept; conflict with their own advisory services.", knowledge_refs: [] },
  { title: "Consent and governance toolkit", one_liner: "Templates and a review checklist for companies that let AI agents touch client data.", customer_segment: "SMEs adopting AI tools under customer or regulatory scrutiny", problem: "No small company has a consent record or a retention rule for agent access.", offer_type: "content", why_now: "The platform's consent, retention and security review flows document the method.", fit_score: 5, evidence_gap: "Whether buyers see governance as a product or expect it bundled.", knowledge_refs: [] },
  { title: "Knowledge Vault setup service", one_liner: "Done-for-you migration of a company's scattered documents into a structured vault with facts and sources.", customer_segment: "Companies with knowledge in e-mail, chat and personal drives", problem: "Agents cannot work from evidence when the evidence is nowhere.", offer_type: "service_line", why_now: "Vault import, taxonomy and fact promotion are implemented.", fit_score: 6, evidence_gap: "Effort per company; which document types dominate.", knowledge_refs: [] }
];

export function ventureIdeasFixture(c: VentureLabContext): VentureIdeasDraft {
  const prior = new Set(c.priorIdeas.map((p) => p.title.trim().toLowerCase()));
  const ideas = FIXTURE_IDEAS.filter((i) => !prior.has(i.title.toLowerCase())).map((i) => ({ ...i, knowledge_refs: i.knowledge_refs.filter((p) => c.knowledge.some((k) => k.path === p)) }));
  return {
    summary: `${ideas.length} venture ideas generated for the agency (simulated).`,
    lens: `Patterns from ${c.portfolio.length} client tenant(s) across ${new Set(c.portfolio.map((p) => p.industry ?? "unknown")).size} industries, ${c.knowledge.length} published knowledge record(s) and the lab focus.`,
    ideas: ideas.length >= 6 ? ideas : FIXTURE_IDEAS
  };
}

export function ventureAnalysisFixture(brief: VentureBrief, c: VentureLabContext): VentureAnalysis {
  const evidence: VentureAnalysis["problem_evidence"] = brief.knowledge_refs.length > 0 ? "agency_knowledge" : c.portfolio.length > 0 ? "portfolio_pattern" : "assumption";
  const feasibility = Math.min(10, brief.fit_score);
  const impact = Math.max(3, Math.min(9, 11 - brief.index));
  const risk = evidence === "assumption" ? 6 : 4;
  const timeToValue = brief.offer_type === "software" ? 4 : brief.offer_type === "partnership" ? 5 : 7;
  const recommendation: VentureAnalysis["recommendation"] = feasibility >= 8 && impact >= 7 ? "pursue" : feasibility >= 6 ? "experiment" : impact >= 7 ? "park" : "drop";
  return {
    summary: `Analysed "${brief.title}": ${recommendation} (simulated).`,
    title: brief.title,
    hypothesis: `${brief.customer_segment} will pay for ${brief.one_liner.toLowerCase().replace(/\.$/, "")} because ${brief.problem.toLowerCase().replace(/\.$/, "")}.`,
    target_customer: brief.customer_segment,
    problem_evidence: evidence,
    offer: brief.one_liner,
    pricing_model: brief.offer_type === "service_line" ? "Monthly retainer with a three-month minimum" : brief.offer_type === "training" ? "Per seat, minimum six seats" : brief.offer_type === "partnership" ? "Revenue share on the first-year fee" : "Fixed price per engagement",
    unit_economics: { margin_note: "Delivery relies on existing agents and templates; the consultant's review hours are the main cost. Figures are estimates to be validated in the first experiment.", is_estimate: true },
    go_to_market: ["Offer it to two existing client tenants first", "One case description in the agency's own voice, no client names", "Direct outreach to ten prospects in the strongest portfolio industry"],
    first_experiments: [
      { name: "Two paid pilots in four weeks", metric: "signed pilots", success_threshold: "2 of 10 approached", duration_days: 28 },
      { name: "Delivery effort measurement", metric: "consultant hours per engagement", success_threshold: "below 12 hours", duration_days: 42 }
    ],
    risks: ["Evidence for the problem is thin until the first pilot", brief.evidence_gap],
    required_capabilities: ["Consultant time for review and delivery", "A one-page offer and price list"],
    uses_existing_assets: brief.knowledge_refs.length > 0 ? brief.knowledge_refs : ["Agent catalogue", "Mission Control"],
    scores: { impact, feasibility, risk, time_to_value: timeToValue },
    recommendation,
    confidence: evidence === "assumption" ? 0.35 : 0.55
  };
}

export function ventureScorecardFixture(analyses: VentureAnalysis[], c: VentureLabContext): VentureScorecard {
  const order: Record<VentureAnalysis["recommendation"], number> = { pursue: 0, experiment: 1, park: 2, drop: 3 };
  const ranked = [...analyses].sort((a, b) => order[a.recommendation] - order[b.recommendation] || compositeScore(b.scores) - compositeScore(a.scores));
  const top = ranked[0];
  return {
    headline: top ? `${ranked.filter((a) => a.recommendation === "pursue").length} venture(s) worth pursuing; start with "${top.title}" (simulated).` : "No venture analysis finished (simulated).",
    ranking: ranked.slice(0, 12).map((a) => ({ title: a.title, verdict: `${a.recommendation}: impact ${a.scores.impact}, feasibility ${a.scores.feasibility}, risk ${a.scores.risk}, time to value ${a.scores.time_to_value}`, recommendation: a.recommendation })),
    recommended_next_step: top ? `Run the first experiment of "${top.title}" (${top.first_experiments[0]?.name ?? "pilot"}) this week and park the rest until it reports.` : "Re-run the lab with a narrower focus.",
    decision_request: `Which of the ${analyses.length} analysed ventures gets the next ${c.maxVentures > 3 ? "four" : "two"} weeks of consultant time? Approve one, reject the others.`,
    caveats: ["Every analysis is a hypothesis built on agency knowledge and portfolio patterns, not on customer interviews.", "Unit economics are estimates without numbers until a pilot is priced."]
  };
}

/** Same composite the opportunity service uses: impact x feasibility x time_to_value / risk. */
export function compositeScore(s: VentureAnalysis["scores"]): number {
  return Math.round(((s.impact * s.feasibility * s.time_to_value) / Math.max(1, s.risk)) * 100) / 100;
}
