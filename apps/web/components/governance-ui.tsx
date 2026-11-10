import Link from "next/link";
import { Badge, Card, Status } from "./ui";
import { deletionKindLabel, deletionStateTone, GOVERNANCE_BASE, securityRiskTone, TECH_WATCH_BASE, upgradeKindTone, upgradeStatusTone, watchModeTone, watchRunTone } from "@/lib/mission-control/governance-helpers";

/**
 * Presentational pieces for the Technology Intelligence Center and the data governance pages (Milestone 6).
 * Pure server components; the tones come from the pure helpers so they are unit-tested without React.
 */

export function UpgradeStatusBadge({ value }: { value: string }) {
  return <Badge tone={upgradeStatusTone(value)}>{value.replaceAll("_", " ")}</Badge>;
}
export function UpgradeKindBadge({ value }: { value: string | null }) {
  return value ? <Badge tone={upgradeKindTone(value)}>{value.replaceAll("_", " ")}</Badge> : <span className="text-xs text-faint">not assessed</span>;
}
export function SecurityRiskBadge({ value }: { value: string | null }) {
  return value ? <Badge tone={securityRiskTone(value)}>{value}</Badge> : <span className="text-xs text-faint">n/a</span>;
}
export function WatchRunBadge({ status }: { status: string }) {
  return <Badge tone={watchRunTone(status)}>{status}</Badge>;
}
export function WatchModeBadge({ mode }: { mode: string }) {
  return <Badge tone={watchModeTone(mode)}>{mode}</Badge>;
}
export function DeletionStateBadge({ value }: { value: string }) {
  return <Badge tone={deletionStateTone(value)}>{value}</Badge>;
}
export function DeletionKindBadge({ value }: { value: string }) {
  return <Badge tone={value === "tenant_offboarding" ? "danger" : value === "subject_data" ? "warning" : "neutral"}>{deletionKindLabel(value)}</Badge>;
}

export type TechWatchTab = "sources" | "updates";

export function TechWatchNav({ active, detected }: { active: TechWatchTab; detected?: number }) {
  const items: Array<{ key: TechWatchTab; href: string; label: string }> = [
    { key: "sources", href: TECH_WATCH_BASE, label: "Sources & watch runs" },
    { key: "updates", href: `${TECH_WATCH_BASE}?view=updates`, label: `Detected updates${detected ? ` (${detected} new)` : ""}` }
  ];
  return (
    <nav className="flex flex-wrap gap-2 text-xs">
      {items.map((i) => (
        <Link key={i.key} href={i.href} className={`rounded-full border px-3 py-1 ${i.key === active ? "border-cyan/60 text-cyan" : "border-border text-muted hover:text-fg"}`}>
          {i.label}
        </Link>
      ))}
      <Link href={GOVERNANCE_BASE} className="rounded-full border border-border px-3 py-1 text-muted hover:text-fg">Data governance</Link>
    </nav>
  );
}

/** The warning every Tech Watch page carries: live fetching is refused through the sandbox proxy; detection changes nothing. */
export function TechWatchSandboxNote() {
  return (
    <div className="rounded-card border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
      Live source fetching is not connected in this sandbox: the egress proxy refuses api.github.com, so the worker records fixture items and labels the run fixture (live runs here end as failed with the proxy's 403 on the source). Where egress allows it, the same job fetches approved sources over HTTPS with a 15 second timeout. Detection only records metadata and the vendor's own summary; it never assesses, approves or applies anything.
    </div>
  );
}

const STANDARD_ROWS: Array<{ label: string; state: "implemented" | "simulated" | "not_connected" | "planned"; note?: string }> = [
  { label: "Technology Intelligence agent (automatic assessment)", state: "planned", note: "assessment is recorded by hand in this release; the agent may assess, never approve" },
  { label: "Live source fetching", state: "not_connected", note: "not connected in this sandbox (fixture mode); works where egress allows api.github.com" },
  { label: "Subject data and tenant off-boarding deletions", state: "simulated", note: "manual runbook: approved by a reviewer, completed by a superadmin with a written summary" },
  { label: "Automatic production upgrades", state: "not_connected", note: "refused by design (ADR-022): a human merges the pull request; the platform only records it" }
];

/** The implementation-status card every Milestone 6 governance page carries (product rule: no mock data presented as working). */
export function GovernanceStatusCard({ implemented, footer }: { implemented: string[]; footer?: string }) {
  return (
    <Card title="Implementation status" footer={footer ?? "Tech tables are agency knowledge: readable in agency scope only (RLS, migration 0009). Retention floors and the deletion lifecycle are enforced by the database; the worker executes sweeps and approved deletions, never the web app."}>
      <ul className="space-y-1 text-sm">
        {implemented.map((label) => (
          <li key={label} className="flex items-start gap-2"><Status state="implemented" /><span>{label}</span></li>
        ))}
        {STANDARD_ROWS.map((r) => (
          <li key={r.label} className="flex items-start gap-2">
            <Status state={r.state} />
            <span>
              {r.label}
              {r.note ? <span className="text-xs text-faint"> ({r.note})</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
