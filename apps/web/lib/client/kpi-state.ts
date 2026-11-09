/**
 * Pure helpers for the CEO Dashboard and the Business X-Ray (M3-03, M3-10). No I/O.
 *
 * - `deriveKpiState` turns the latest observation of a KPI into a render state. A number is shown only
 *   for an `ok` observation; `missing`, `stale` and `error` are states, never numbers (spec 4B).
 * - `maturityScore` is the transparent scorecard rule for one department. It returns the inputs it
 *   used next to the score so the page never shows a number without its inputs.
 */

export type KpiRenderState = "ok" | "missing" | "stale" | "error";
export type ThresholdLevel = "normal" | "warning" | "critical";
export type KpiDirection = "higher_is_better" | "lower_is_better";

export interface KpiLatestInput {
  /** Latest observation status, or null when the KPI has no observation yet. */
  status: string | null;
  value: string | number | null;
  direction: string;
  warningThreshold: string | number | null;
  criticalThreshold: string | number | null;
}

export interface KpiDerivedState {
  state: KpiRenderState;
  /** Numeric value when state is ok, otherwise null. */
  value: number | null;
  /** Threshold evaluation when state is ok and thresholds exist; "normal" when no threshold is crossed. */
  level: ThresholdLevel | null;
  label: string;
}

function toNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Threshold colouring by direction: for lower_is_better a value at or above a threshold crosses it; for higher_is_better at or below. */
export function thresholdLevel(value: number, direction: string, warning: string | number | null, critical: string | number | null): ThresholdLevel {
  const w = toNumber(warning);
  const c = toNumber(critical);
  const lowerIsBetter = direction === "lower_is_better";
  const crosses = (t: number) => (lowerIsBetter ? value >= t : value <= t);
  if (c !== null && crosses(c)) return "critical";
  if (w !== null && crosses(w)) return "warning";
  return "normal";
}

export function deriveKpiState(input: KpiLatestInput): KpiDerivedState {
  if (input.status === null || input.status === undefined) return { state: "missing", value: null, level: null, label: "Missing data" };
  switch (input.status) {
    case "ok": {
      const value = toNumber(input.value);
      if (value === null) return { state: "error", value: null, level: null, label: "Error" };
      return { state: "ok", value, level: thresholdLevel(value, input.direction, input.warningThreshold, input.criticalThreshold), label: "OK" };
    }
    case "stale_data":
      return { state: "stale", value: null, level: null, label: "Stale data" };
    case "missing_data":
      return { state: "missing", value: null, level: null, label: "Missing data" };
    default:
      return { state: "error", value: null, level: null, label: "Error" };
  }
}

/** Formats a KPI value with its unit; integers without decimals, others with at most two. */
export function formatKpiValue(value: number, unit: string): string {
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
  return unit && unit !== "count" ? `${text} ${unit}` : text;
}

// Maturity scorecard ----------------------------------------------------------------------------

export type Uncertainty = "low" | "medium" | "high";

export interface MaturityInput {
  answeredQuestions: number;
  totalQuestions: number;
  verifiedFacts: number;
  totalFacts: number;
  systems: number;
  /** Systems whose claim status is verified_exists or connected. */
  verifiedSystems: number;
  openCriticalFindings: number;
  openHighFindings: number;
}

export interface MaturityResult {
  /** 0 to 100, or null when nothing at all is known about the department. */
  score: number | null;
  uncertainty: Uncertainty;
  /** Number of answers plus verified facts: the evidence the score rests on. */
  evidenceCount: number;
  components: { answers: number; evidence: number; systems: number; penalty: number };
  inputs: Array<{ label: string; value: string }>;
}

/**
 * Transparent scorecard rule (documented on the X-Ray page):
 *   answers   = answered / total questions x 40
 *   evidence  = verified / total facts x 30
 *   systems   = verified or connected / registered systems x 30
 *   penalty   = 15 per open critical finding + 8 per open high finding, capped at 30
 *   score     = clamp(answers + evidence + systems - penalty, 0, 100), rounded
 * A component whose denominator is zero contributes 0. Uncertainty depends on the evidence count
 * (answers + verified facts): below 3 is high, below 8 is medium, otherwise low.
 */
export function maturityScore(input: MaturityInput): MaturityResult {
  const ratio = (n: number, d: number) => (d > 0 ? Math.min(1, Math.max(0, n / d)) : 0);
  const answers = ratio(input.answeredQuestions, input.totalQuestions) * 40;
  const evidence = ratio(input.verifiedFacts, input.totalFacts) * 30;
  const systems = ratio(input.verifiedSystems, input.systems) * 30;
  const penalty = Math.min(30, input.openCriticalFindings * 15 + input.openHighFindings * 8);
  const known = input.totalQuestions + input.totalFacts + input.systems + input.openCriticalFindings + input.openHighFindings > 0;
  const raw = answers + evidence + systems - penalty;
  const score = known ? Math.round(Math.min(100, Math.max(0, raw))) : null;
  const evidenceCount = input.answeredQuestions + input.verifiedFacts;
  const uncertainty: Uncertainty = evidenceCount < 3 ? "high" : evidenceCount < 8 ? "medium" : "low";
  return {
    score,
    uncertainty,
    evidenceCount,
    components: { answers: round1(answers), evidence: round1(evidence), systems: round1(systems), penalty },
    inputs: [
      { label: "Answered questions", value: `${input.answeredQuestions} of ${input.totalQuestions}` },
      { label: "Verified facts", value: `${input.verifiedFacts} of ${input.totalFacts}` },
      { label: "Verified or connected systems", value: `${input.verifiedSystems} of ${input.systems}` },
      { label: "Open critical findings", value: String(input.openCriticalFindings) },
      { label: "Open high findings", value: String(input.openHighFindings) }
    ]
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
