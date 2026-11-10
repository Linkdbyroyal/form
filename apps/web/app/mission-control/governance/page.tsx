import Link from "next/link";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Card, Empty, Stat, Status, inputClass } from "@/components/ui";
import { Masked, Notice, PageHeader, ShortId, Table, Td, Tr, smallButtonClass, smallPrimaryClass } from "@/components/agent-ui";
import { DeletionKindBadge, DeletionStateBadge, GovernanceStatusCard } from "@/components/governance-ui";
import { RETENTION_MINIMUM_DAYS } from "@sbos/core";
import { firstParam, fmtDate } from "@/lib/format";
import { shortActor } from "@/lib/mission-control/agency-vault-helpers";
import { setPlatformRetentionAction } from "@/lib/mission-control/governance-actions";
import { DATA_CLASS_LABELS, DELETION_STATES, deletionRequestHref, GOVERNANCE_BASE, isSuperadmin, RETENTION_MAX_DAYS, TECH_WATCH_BASE, WORKER_SWEEP_SCHEDULE } from "@/lib/mission-control/governance-helpers";
import { getPlatformRetention, listAllDeletionRequests } from "@/lib/mission-control/governance-queries";
import { requireAgencyContext, requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function DataGovernancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const op = await requireOperatorContext();
  // Platform defaults are agency-scope rows (tenant_id NULL); the same user in agency scope reads them.
  const agency = await requireAgencyContext();
  const sp = await searchParams;
  const state = firstParam(sp.state);
  const [defaults, requests] = await Promise.all([getPlatformRetention(agency), listAllDeletionRequests(op, { state })]);
  const superadmin = isSuperadmin(op.roles);
  const canDecide = op.roles.includes("agency_reviewer") || superadmin;
  const total = [...requests.counts.values()].reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Data governance" crumbs={[{ href: "/mission-control", label: "Mission Control" }, { label: "Data governance" }]}>
        Platform retention defaults per data class and every deletion request across tenants. The list uses the operator role (metadata columns only: tenant, kind, state, legal hold, reviewer, dates); a request&apos;s subject reference and reason are read in agency scope pinned to its tenant on the detail page. Approved document and connection deletions are {WORKER_SWEEP_SCHEDULE}; the web app never deletes. <Status state="implemented" />
      </PageHeader>
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
      <div className="flex flex-wrap gap-2 text-xs">
        <Link href={TECH_WATCH_BASE} className="rounded-full border border-border px-3 py-1 text-muted hover:text-fg">Tech Watch</Link>
        <Badge tone="cyan">your roles: {op.roles.join(", ")}</Badge>
        {!canDecide ? <Badge tone="neutral">deciding requests needs agency_reviewer or superadmin</Badge> : null}
      </div>

      <div className="grid gap-4 md:grid-cols-5">
        <Stat label="Requests" value={total} hint="across all tenants" />
        <Stat label="Requested" value={requests.counts.get("requested") ?? 0} hint="waiting for a decision" />
        <Stat label="Approved" value={requests.counts.get("approved") ?? 0} hint="waiting for execution" />
        <Stat label="Completed" value={requests.counts.get("completed") ?? 0} hint="executed or completed manually" />
        <Stat label="Rejected" value={requests.counts.get("rejected") ?? 0} />
      </div>

      <Card title="Platform retention defaults" footer={`Rows with tenant_id NULL in retention_policies, set by a superadmin in agency scope. Each data class has a floor the database enforces (retention_minimum_days); tenants may override above the floor in their workspace. Maximum ${RETENTION_MAX_DAYS} days. Audit events are never deleted. The sweep runs ${WORKER_SWEEP_SCHEDULE}.`}>
        <Table head={["Data class", "What it holds", "Default (days)", "Floor (days)", "Reason", "Set by", "Updated", superadmin ? "Change" : ""]}>
          {defaults.map((d) => (
            <Tr key={d.dataClass}>
              <Td className="font-medium">{DATA_CLASS_LABELS[d.dataClass].label}<div className="font-mono text-[11px] text-faint">{d.dataClass}</div></Td>
              <Td className="max-w-xs text-xs text-muted">{DATA_CLASS_LABELS[d.dataClass].description}</Td>
              <Td className="text-lg font-semibold">{d.days}</Td>
              <Td className="text-xs">{RETENTION_MINIMUM_DAYS[d.dataClass]}</Td>
              <Td className="max-w-xs text-xs text-muted">{d.reason}</Td>
              <Td className="font-mono text-[11px] text-muted">{d.setByActorId ? shortActor(d.setByActorId) : <span className="text-faint">floor, no row</span>}</Td>
              <Td className="text-xs text-muted">{d.updatedAt ? fmtDate(d.updatedAt) : ""}</Td>
              <Td>
                {superadmin ? (
                  <form action={setPlatformRetentionAction} className="flex flex-col gap-1">
                    <input type="hidden" name="returnTo" value={GOVERNANCE_BASE} />
                    <input type="hidden" name="dataClass" value={d.dataClass} />
                    <input name="retentionDays" type="number" required min={RETENTION_MINIMUM_DAYS[d.dataClass]} max={RETENTION_MAX_DAYS} defaultValue={d.days} className={`${inputClass} w-24`} />
                    <input name="reason" required minLength={5} maxLength={1000} placeholder="Reason" className={`${inputClass} w-44`} />
                    <ConfirmButton className={smallPrimaryClass} message={`Set the platform default for ${d.dataClass} ? Tenants without an override follow it from the next sweep.`}>Set default</ConfirmButton>
                  </form>
                ) : <span className="text-[11px] text-faint">superadmin only</span>}
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <Card title={`Deletion requests (${requests.rows.length} shown of ${total})`} footer="Operator role: the subject reference, reason, review note and summary columns are not granted here (Masked); they are read in agency scope pinned to the tenant on the detail page, where the decision is also made.">
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          <Link href={GOVERNANCE_BASE} className={`rounded-full border px-3 py-1 ${!state ? "border-cyan/60 text-cyan" : "border-border text-muted hover:text-fg"}`}>any state ({total})</Link>
          {DELETION_STATES.map((s) => (
            <Link key={s} href={`${GOVERNANCE_BASE}?state=${s}`} className={`rounded-full border px-3 py-1 ${state === s ? "border-cyan/60 text-cyan" : "border-border text-muted hover:text-fg"}`}>
              {s} <span className="text-faint">({requests.counts.get(s) ?? 0})</span>
            </Link>
          ))}
        </div>
        <Table head={["Tenant", "Kind", "Subject", "State", "Legal hold", "Reviewer", "Requested", "Decided", "Executed", ""]} empty={requests.rows.length === 0 ? <Empty>No deletion requests{state ? ` in state ${state}` : ""}. Client admins file them in their workspace under Data &amp; Retention.</Empty> : null}>
          {requests.rows.map((r) => (
            <Tr key={r.id}>
              <Td><Link href={`/mission-control/clients/${r.tenantSlug}`} className="underline">{r.tenantName}</Link><div className="text-[11px] text-faint"><ShortId id={r.id} /></div></Td>
              <Td><DeletionKindBadge value={r.kind} /></Td>
              <Td><Masked what="deletion_requests.subject_ref" /></Td>
              <Td><DeletionStateBadge value={r.state} /></Td>
              <Td>{r.legalHold ? <Badge tone="danger">legal hold</Badge> : <span className="text-xs text-faint">no</span>}</Td>
              <Td className="font-mono text-[11px] text-muted">{r.reviewerActorId ? shortActor(r.reviewerActorId) : ""}</Td>
              <Td className="text-xs text-muted">{fmtDate(r.createdAt)}</Td>
              <Td className="text-xs text-muted">{r.decidedAt ? fmtDate(r.decidedAt) : ""}</Td>
              <Td className="text-xs text-muted">{r.executedAt ? fmtDate(r.executedAt) : r.state === "approved" ? <span className="text-faint">waiting for the worker (Sundays 03:00 UTC)</span> : ""}</Td>
              <Td><Link href={deletionRequestHref(r.id)} className={smallButtonClass}>Open</Link></Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <GovernanceStatusCard implemented={["Platform retention defaults with floors from the database; edit form for superadmins (setRetentionPolicy in agency scope, audit row).", "Deletion requests across tenants through the operator role (metadata columns only) with state filter and counts.", `Worker job retention.sweep (${WORKER_SWEEP_SCHEDULE}): effective policy per tenant, then approved document and connection data requests; every execution writes an audit event with counts.`]} />
    </div>
  );
}
