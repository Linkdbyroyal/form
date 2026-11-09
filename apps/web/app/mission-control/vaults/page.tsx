import Link from "next/link";
import { Badge, Card, Empty, Stat, Status } from "@/components/ui";
import { Masked, Table, Td, Tr } from "@/components/agent-ui";
import { fmtDate } from "@/lib/format";
import { listVaultMetadata } from "@/lib/mission-control/queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

/**
 * Operator view of every client vault: counts only. The operator role has no grant on document bodies, fact
 * statements, answers or search queries, so this page cannot show content even by mistake (Postgres would
 * refuse the column). Content lives in the client workspace, reachable through a break-glass grant.
 */
export default async function MissionControlVaultsPage() {
  await requireOperatorContext();
  const rows = await listVaultMetadata();
  const totals = rows.reduce(
    (acc, r) => ({ documents: acc.documents + r.documents, facts: acc.facts + r.factsTotal, requests: acc.requests + r.openVerificationRequests, proposals: acc.proposals + r.pendingProposals, audits: acc.audits + r.retrievalAudits7d }),
    { documents: 0, facts: 0, requests: 0, proposals: 0, audits: 0 }
  );
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Knowledge Vaults</h1>
        <p className="text-sm text-muted">Per-tenant vault metadata through the operator role: document and fact counts, verification state, open reviews and retrieval activity. No titles, statements, bodies or queries. <Status state="implemented" /></p>
      </header>
      <div className="grid gap-4 md:grid-cols-5">
        <Stat label="Documents" value={totals.documents} hint="all client vaults" />
        <Stat label="Facts" value={totals.facts} hint="all verification states" />
        <Stat label="Open verification requests" value={totals.requests} hint="waiting for a client admin" />
        <Stat label="Pending proposals" value={totals.proposals} hint="agent changes under review" />
        <Stat label="Retrievals (7d)" value={totals.audits} hint="searches and agent context reads" />
      </div>
      <Card title="Per tenant" footer="Facts by verification: unconfirmed / hypothesis / evidence backed / verified / approved policy / deprecated. Masked columns are content columns the operator role cannot read.">
        <Table head={["Tenant", "Documents", "Restricted docs", "Facts", "By verification", "Open requests", "Pending proposals", "Retrievals (7d)", "Last document update", "Content"]} empty={rows.length === 0 ? <Empty>No client tenants.</Empty> : null}>
          {rows.map((r) => (
            <Tr key={r.tenantId}>
              <Td className="font-medium">{r.tenantName}<div className="text-xs text-faint">{r.tenantSlug}</div></Td>
              <Td>{r.documents}</Td>
              <Td>{r.restrictedDocuments > 0 ? <Badge tone="danger">{r.restrictedDocuments}</Badge> : <span className="text-muted">0</span>}</Td>
              <Td>{r.factsTotal}</Td>
              <Td className="text-xs text-muted">
                <span title="unconfirmed">{r.factsByVerification.unconfirmed ?? 0}</span> / <span title="hypothesis" className="text-warning">{r.factsByVerification.hypothesis ?? 0}</span> / <span title="evidence_backed" className="text-cyan">{r.factsByVerification.evidence_backed ?? 0}</span> / <span title="verified" className="text-success">{r.factsByVerification.verified ?? 0}</span> / <span title="approved_policy" className="text-indigo">{r.factsByVerification.approved_policy ?? 0}</span> / <span title="deprecated" className="text-danger">{r.factsByVerification.deprecated ?? 0}</span>
              </Td>
              <Td>{r.openVerificationRequests > 0 ? <Badge tone="warning">{r.openVerificationRequests}</Badge> : <span className="text-muted">0</span>}</Td>
              <Td>{r.pendingProposals > 0 ? <Badge tone="warning">{r.pendingProposals}</Badge> : <span className="text-muted">0</span>}</Td>
              <Td>{r.retrievalAudits7d}</Td>
              <Td className="text-xs text-muted">{fmtDate(r.lastDocumentUpdate)}</Td>
              <Td><Masked what="document bodies, fact statements, answers, search queries" /> <Link href={`/mission-control/clients/${r.tenantSlug}`} className="text-xs underline">operator view</Link></Td>
            </Tr>
          ))}
        </Table>
      </Card>
      <Card title="Implementation status">
        <ul className="space-y-1 text-sm">
          <li><Status state="implemented" /> Vault metadata per tenant through column-level operator grants (M2-11)</li>
          <li><Status state="planned" /> Vault health signals (stale documents, unresolved contradictions older than N days) and export status (M3)</li>
        </ul>
      </Card>
    </div>
  );
}
