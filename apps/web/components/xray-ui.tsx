import type { ReactNode } from "react";
import { Badge, type Tone } from "./ui";
import type { KpiDerivedState, Uncertainty } from "@/lib/client/kpi-state";

/**
 * Presentational badges for the Milestone 3 client pages (dashboard, X-Ray, action center, briefing).
 * Pure server components; every state word comes from a database enum or a contract enum.
 */
const SEVERITY: Record<string, Tone> = { critical: "danger", high: "warning", medium: "cyan", low: "neutral", info: "neutral" };
const CLAIM: Record<string, Tone> = { client_statement: "indigo", data_observation: "success", hypothesis: "warning" };
const FINDING_STATE: Record<string, Tone> = { open: "warning", validated: "success", dismissed: "neutral", resolved: "success" };
const OPPORTUNITY_STATE: Record<string, Tone> = { proposed: "warning", approved: "success", rejected: "danger", in_progress: "cyan", delivered: "success", verified: "success" };
const TASK_STATE: Record<string, Tone> = { proposed: "neutral", awaiting_approval: "warning", approved: "success", assigned: "cyan", in_progress: "cyan", verifying: "indigo", closed: "success", escalated: "danger", rejected: "danger" };
const INTERVENTION: Record<string, Tone> = { stop: "danger", simplify: "cyan", standardize: "indigo", integrate: "cyan", automate: "success", keep_human: "neutral" };
const UNCERTAINTY: Record<Uncertainty, Tone> = { low: "success", medium: "warning", high: "danger" };
const KPI_STATE: Record<KpiDerivedState["state"], Tone> = { ok: "success", missing: "warning", stale: "warning", error: "danger" };
const LEVEL: Record<NonNullable<KpiDerivedState["level"]>, Tone> = { normal: "success", warning: "warning", critical: "danger" };
const RELIABILITY: Record<string, Tone> = { high: "success", medium: "cyan", low: "warning", unknown: "neutral" };
const CLAIM_STATUS: Record<string, Tone> = { stated: "warning", verified_exists: "cyan", connected: "success" };

const words = (v: string) => v.replaceAll("_", " ");

export function SeverityBadge({ value }: { value: string }) {
  return <Badge tone={SEVERITY[value] ?? "neutral"}>{value}</Badge>;
}
export function ClaimBadge({ value }: { value: string }) {
  return <Badge tone={CLAIM[value] ?? "neutral"}>{words(value)}</Badge>;
}
export function FindingStateBadge({ value }: { value: string }) {
  return <Badge tone={FINDING_STATE[value] ?? "neutral"}>{value}</Badge>;
}
export function OpportunityStateBadge({ value }: { value: string }) {
  return <Badge tone={OPPORTUNITY_STATE[value] ?? "neutral"}>{words(value)}</Badge>;
}
export function ActionTaskStateBadge({ value }: { value: string }) {
  return <Badge tone={TASK_STATE[value] ?? "neutral"}>{words(value)}</Badge>;
}
export function InterventionBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-xs text-faint">unchanged</span>;
  return <Badge tone={INTERVENTION[value] ?? "neutral"}>{words(value)}</Badge>;
}
export function UncertaintyBadge({ value }: { value: Uncertainty }) {
  return <Badge tone={UNCERTAINTY[value]}>uncertainty {value}</Badge>;
}
export function ReliabilityBadge({ value }: { value: string }) {
  return <Badge tone={RELIABILITY[value] ?? "neutral"}>reliability {value}</Badge>;
}
export function SystemClaimBadge({ value }: { value: string }) {
  return <Badge tone={CLAIM_STATUS[value] ?? "neutral"}>{words(value)}</Badge>;
}
export function ReviewStatusBadge({ value }: { value: string }) {
  return <Badge tone={value === "approved" ? "success" : value === "rejected" ? "danger" : "neutral"}>{value === "unreviewed" ? "unreviewed specification" : words(value)}</Badge>;
}

/** KPI observation state. For `ok` the threshold level decides the colour (normal, warning, critical). */
export function KpiStateBadge({ derived }: { derived: KpiDerivedState }) {
  if (derived.state === "ok") {
    const level = derived.level ?? "normal";
    return <Badge tone={LEVEL[level]}>{level === "normal" ? "ok" : level}</Badge>;
  }
  return <Badge tone={KPI_STATE[derived.state]}>{derived.label}</Badge>;
}

/** Marks a money or magnitude figure that the contract labels as an estimate (never an actual). */
export function EstimateLabel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      {children}
      <Badge tone="warning">estimate</Badge>
    </span>
  );
}

/** Fixed order and labels of the eight briefing sections (ExecutiveBriefing contract). */
export const BRIEFING_SECTIONS: ReadonlyArray<{ key: "what_changed" | "what_matters_today" | "decisions_needed" | "tasks_delegated" | "risks" | "opportunities" | "data_gaps" | "impact_of_prior_improvements"; label: string }> = [
  { key: "what_changed", label: "What changed" },
  { key: "what_matters_today", label: "What matters today" },
  { key: "decisions_needed", label: "Decisions needed" },
  { key: "tasks_delegated", label: "Tasks delegated" },
  { key: "risks", label: "Risks" },
  { key: "opportunities", label: "Opportunities" },
  { key: "data_gaps", label: "Data gaps" },
  { key: "impact_of_prior_improvements", label: "Impact of prior improvements" }
];
