import Link from "next/link";
import { Badge, Card, Status } from "./ui";
import { adoptionStateTone, consentTone, deprecationEventTone, evalResultTone, knowledgeStateTone, promotionStateTone, riskTone } from "@/lib/mission-control/agency-vault-helpers";

/**
 * Presentational pieces for the Agency Intelligence Vault pages (spec 4H). Pure server components; the tones
 * come from the pure helpers so they are unit-tested without React.
 */

export type AgencyVaultTab = "library" | "new" | "reviews" | "templates" | "history";

export const AGENCY_VAULT_BASE = "/mission-control/agency-vault";

export function AgencyVaultNav({ active, pendingReviews }: { active: AgencyVaultTab; pendingReviews?: number }) {
  const items: Array<{ key: AgencyVaultTab; href: string; label: string }> = [
    { key: "library", href: AGENCY_VAULT_BASE, label: "Knowledge Library" },
    { key: "new", href: `${AGENCY_VAULT_BASE}/new`, label: "New record" },
    { key: "reviews", href: `${AGENCY_VAULT_BASE}/reviews`, label: `Pending Knowledge Reviews${pendingReviews ? ` (${pendingReviews})` : ""}` },
    { key: "templates", href: `${AGENCY_VAULT_BASE}/templates`, label: "Templates & adoptions" },
    { key: "history", href: `${AGENCY_VAULT_BASE}/history`, label: "Version History" }
  ];
  return (
    <nav className="flex flex-wrap gap-2 text-xs">
      {items.map((i) => (
        <Link key={i.key} href={i.href} className={`rounded-full border px-3 py-1 ${i.key === active ? "border-cyan/60 text-cyan" : "border-border text-muted hover:text-fg"}`}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

export function KnowledgeStateBadge({ value }: { value: string }) {
  return <Badge tone={knowledgeStateTone(value)}>{value.replaceAll("_", " ")}</Badge>;
}
export function PromotionStateBadge({ value }: { value: string }) {
  return <Badge tone={promotionStateTone(value)}>{value.replaceAll("_", " ")}</Badge>;
}
export function AdoptionStateBadge({ value }: { value: string }) {
  return <Badge tone={adoptionStateTone(value)}>{value.replaceAll("_", " ")}</Badge>;
}
export function RiskBadge({ value }: { value: string }) {
  return <Badge tone={riskTone(value)}>{value}</Badge>;
}
export function ConsentBadge({ value }: { value: string }) {
  return <Badge tone={consentTone(value)}>{value.replaceAll("_", " ")}</Badge>;
}
export function EvalResultBadge({ value }: { value: string }) {
  return <Badge tone={evalResultTone(value)}>{value.replaceAll("_", " ")}</Badge>;
}
export function DeprecationKindBadge({ value }: { value: string }) {
  return <Badge tone={deprecationEventTone(value)}>{value.replaceAll("_", " ")}</Badge>;
}

export function OriginBadge({ value }: { value: string }) {
  return <Badge tone={value === "abstracted_from_client" ? "indigo" : value === "public_license" ? "cyan" : "neutral"}>{value.replaceAll("_", " ")}</Badge>;
}

/** The implementation-status card every vault page carries (product rule: no mock data presented as working). */
export function AgencyVaultStatusCard({ extra }: { extra?: Array<{ label: string; state: "implemented" | "simulated" | "not_connected" | "planned"; note?: string }> }) {
  const rows: NonNullable<typeof extra> = [
    { label: "Knowledge records, immutable versions, lifecycle with reviewer gate (DB triggers)", state: "implemented" },
    { label: "Methodology templates, per-tenant adoptions with pinned versions, rollback, revoke", state: "implemented" },
    { label: "Client-to-agency promotion requests with human review and manual publication", state: "implemented" },
    { label: "Full-text search over agency records (lexical, logged in audit_events)", state: "implemented" },
    { label: "Semantic search (pgvector)", state: "planned", note: "deferred to M5 per ADR-019" },
    { label: "Agency Knowledge Curator Agent (nominations from runs, evaluation runs, tech-watch digests)", state: "planned", note: "evaluation results are recorded by hand until then" },
    ...(extra ?? [])
  ];
  return (
    <Card title="Implementation status" footer="Agency knowledge is readable only in agency scope (RLS, migration 0007). Tenant scope sees none of these tables; the operator role sees metadata columns only.">
      <ul className="space-y-1 text-sm">
        {rows.map((r) => (
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
