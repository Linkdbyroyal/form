import Link from "next/link";
import { Badge, Card, Empty, Status } from "@/components/ui";
import { Notice, PageHeader, Table, Td, Tr } from "@/components/agent-ui";
import { AGENCY_VAULT_BASE, AgencyVaultNav, AgencyVaultStatusCard, DeprecationKindBadge } from "@/components/agency-vault-ui";
import { firstParam, fmtDate } from "@/lib/format";
import { recordHref, shortActor } from "@/lib/mission-control/agency-vault-helpers";
import { listHistory } from "@/lib/mission-control/agency-vault-queries";
import { requireAgencyContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAgencyContext();
  const sp = await searchParams;
  const kind = firstParam(sp.kind);
  const all = await listHistory(ctx, 300);
  const kinds = ["transition", "release", "rollback", "deprecate", "reinstate", "archive", "adoption", "promotion"] as const;
  const entries = kind ? all.filter((e) => e.kind === kind) : all;
  return (
    <div className="space-y-6">
      <PageHeader title="Version History" crumbs={[{ href: AGENCY_VAULT_BASE, label: "Agency Intelligence Vault" }, { label: "Version History" }]}>
        Cross-record timeline: lifecycle transitions (written by the database trigger), releases and rollbacks, deprecations, adoptions per tenant (metadata only) and publications from approved promotion requests. Newest first, last 300 entries. <Status state="implemented" />
      </PageHeader>
      <AgencyVaultNav active="history" />
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />

      <div className="flex flex-wrap gap-2 text-xs">
        <Link href={`${AGENCY_VAULT_BASE}/history`} className={`rounded-full border px-3 py-1 ${!kind ? "border-cyan/60 text-cyan" : "border-border text-muted hover:text-fg"}`}>all ({all.length})</Link>
        {kinds.map((k) => (
          <Link key={k} href={`${AGENCY_VAULT_BASE}/history?kind=${k}`} className={`rounded-full border px-3 py-1 ${kind === k ? "border-cyan/60 text-cyan" : "border-border text-muted hover:text-fg"}`}>
            {k} ({all.filter((e) => e.kind === k).length})
          </Link>
        ))}
      </div>

      <Card title={`Timeline (${entries.length})`} footer="Adoption entries name the tenant and the pinned version only; parameter values and client documents stay in the client vault. Promotion entries show the rights basis, never the source references.">
        <Table head={["When", "Kind", "Record", "Event", "Detail", "Tenant", "Actor"]} empty={entries.length === 0 ? <Empty>No history entries.</Empty> : null}>
          {entries.map((e, i) => (
            <Tr key={`${e.kind}-${e.at.toISOString()}-${i}`}>
              <Td className="whitespace-nowrap text-muted">{fmtDate(e.at)}</Td>
              <Td>{e.kind === "transition" ? <Badge tone="cyan">transition</Badge> : e.kind === "adoption" ? <Badge tone="indigo">adoption</Badge> : e.kind === "promotion" ? <Badge tone="success">promotion</Badge> : <DeprecationKindBadge value={e.kind} />}</Td>
              <Td className="max-w-xs">{e.recordId ? <Link href={recordHref(e.recordId)} className="underline">{e.recordTitle ?? e.recordId.slice(0, 8)}</Link> : <span className="text-faint">n/a</span>}{e.recordPath ? <div className="font-mono text-[11px] text-faint">{e.recordPath}</div> : null}</Td>
              <Td className="text-xs">{e.summary}</Td>
              <Td className="max-w-sm text-xs text-muted">{e.detail ?? ""}</Td>
              <Td className="text-xs">{e.tenantName ?? ""}</Td>
              <Td className="font-mono text-[11px] text-muted">{shortActor(e.actor.replace(/^(user|agent|system):/, "$1:"))}</Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <AgencyVaultStatusCard />
    </div>
  );
}
