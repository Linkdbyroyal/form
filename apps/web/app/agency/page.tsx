import Link from "next/link";
import { Badge, Card, Empty, Stat, Status } from "@/components/ui";
import { AGENCY_STAFF_NAV, MISSION_CONTROL_NAV, Shell } from "@/components/shell";
import { AGENCY_VAULT_BASE, AgencyVaultStatusCard, KnowledgeStateBadge } from "@/components/agency-vault-ui";
import { canReviewKnowledge, hasOperatorRole } from "@/lib/mission-control/agency-vault-helpers";
import { getAgencyVaultSummary } from "@/lib/mission-control/agency-vault-queries";
import { requireAgencyContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

/**
 * Landing page for agency staff (spec 4H). Any agency role may open it; operators also see Mission Control.
 * Counts are read in agency scope. Promotion counts are only meaningful for reviewers (RLS hides requests from others).
 */
export default async function AgencyLanding() {
  const ctx = await requireAgencyContext();
  const s = await getAgencyVaultSummary(ctx);
  const operator = hasOperatorRole(ctx.roles);
  const reviewer = canReviewKnowledge(ctx.roles);
  return (
    <Shell title={operator ? "Mission Control" : "Agency Vault"} subtitle={operator ? "Operator console" : "Second Brain intelligence"} nav={operator ? MISSION_CONTROL_NAV : AGENCY_STAFF_NAV}>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Agency Intelligence Vault</h1>
          <p className="text-sm text-muted">Second Brain&apos;s own and explicitly released generic knowledge. Your agency roles: {ctx.roles.map((r) => <Badge key={r} tone="indigo">{r}</Badge>)} <Status state="implemented" /></p>
        </header>
        <div className="grid gap-4 md:grid-cols-4">
          <Stat label="Knowledge records" value={s.records} hint={`${s.recordsByState.find((x) => x.state === "published")?.n ?? 0} published`} />
          <Stat label="Pending reviews" value={s.canSeePromotions ? s.pendingReviews : "n/a"} hint={s.canSeePromotions ? `${s.approvedAwaitingPublication} approved, awaiting publication` : "reviewer role required"} />
          <Stat label="Templates" value={s.templates} hint="active methodology templates" />
          <Stat label="Active adoptions" value={s.activeAdoptions} hint="pinned versions in client vaults" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Records by state" footer="Lifecycle enforced by the database: draft, in review, approved, published, deprecated, archived.">
            {s.records === 0 ? (
              <Empty>No agency records yet. Run the seed or create one in the Knowledge Library.</Empty>
            ) : (
              <div className="flex flex-wrap gap-3 text-sm">
                {s.recordsByState.map((x) => (
                  <span key={x.state} className="flex items-center gap-1"><KnowledgeStateBadge value={x.state} /><span className="text-muted">{x.n}</span></span>
                ))}
              </div>
            )}
          </Card>
          <Card title="Modules" footer={reviewer ? "You hold a reviewer role: approve, publish, deprecate, release and promotion reviews are available to you." : "Approve, publish, deprecate, release and promotion reviews need agency_reviewer or superadmin; you can draft, version and define templates."}>
            <ul className="space-y-1 text-sm">
              <li><Link href={AGENCY_VAULT_BASE} className="underline">Knowledge Library</Link> <span className="text-muted">18 folders, search, state filters, Interview Library, Industry Blueprints, Design System, Tech Watch, Skills Registry</span></li>
              <li><Link href={`${AGENCY_VAULT_BASE}/new`} className="underline">New record</Link> <span className="text-muted">draft with version 1</span></li>
              <li><Link href={`${AGENCY_VAULT_BASE}/reviews`} className="underline">Pending Knowledge Reviews</Link> <span className="text-muted">client-to-agency promotion requests; publication is never automatic</span></li>
              <li><Link href={`${AGENCY_VAULT_BASE}/templates`} className="underline">Templates and adoptions</Link> <span className="text-muted">adopt per tenant with pinned versions, roll back, revoke</span></li>
              <li><Link href={`${AGENCY_VAULT_BASE}/history`} className="underline">Version History</Link> <span className="text-muted">cross-record timeline</span></li>
              {operator ? <li><Link href="/mission-control" className="underline">Mission Control</Link> <span className="text-muted">operator console (agents, runs, approvals, costs)</span></li> : null}
            </ul>
          </Card>
        </div>
        <AgencyVaultStatusCard />
      </div>
    </Shell>
  );
}
