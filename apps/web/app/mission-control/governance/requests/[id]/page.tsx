import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Card, Empty, Status, inputClass } from "@/components/ui";
import { Notice, PageHeader, ShortId, Table, Td, Tr, selectClass, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { DeletionKindBadge, DeletionStateBadge, GovernanceStatusCard } from "@/components/governance-ui";
import { firstParam, fmtDate } from "@/lib/format";
import { shortActor } from "@/lib/mission-control/agency-vault-helpers";
import { completeDeletionManuallyAction, decideDeletionAction } from "@/lib/mission-control/governance-actions";
import { DATA_CLASS_LABELS, DELETION_KIND_INFO, deletionDecisionsFor, deletionRequestHref, executionNote, GOVERNANCE_BASE, isAutomatedDeletion, isSuperadmin, summaryRows, WORKER_SWEEP_SCHEDULE, type DeletionKind } from "@/lib/mission-control/governance-helpers";
import { getDeletionRequestDetail } from "@/lib/mission-control/governance-queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function DeletionRequestPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const op = await requireOperatorContext();
  const sp = await searchParams;
  const detail = await getDeletionRequestDetail(op, id);
  if (!detail) notFound();
  const { request: r, tenantSlug, tenantName, requestedByName, tenantRetention } = detail;
  const superadmin = isSuperadmin(op.roles);
  const canDecide = op.roles.includes("agency_reviewer") || superadmin;
  const decisions = deletionDecisionsFor(r.state);
  const automated = isAutomatedDeletion(r.kind);
  const info = DELETION_KIND_INFO[r.kind as DeletionKind];
  const rows = summaryRows(r.summary);
  const returnTo = deletionRequestHref(r.id);
  const hidden = (
    <>
      <input type="hidden" name="requestId" value={r.id} />
      <input type="hidden" name="tenantId" value={r.tenantId} />
      <input type="hidden" name="returnTo" value={returnTo} />
    </>
  );

  return (
    <div className="space-y-6">
      <PageHeader title={`Deletion request: ${info?.label ?? r.kind} for ${tenantName}`} crumbs={[{ href: "/mission-control", label: "Mission Control" }, { href: GOVERNANCE_BASE, label: "Data governance" }, { label: "Request" }]}>
        Request <ShortId id={r.id} /> of <Link href={`/mission-control/clients/${tenantSlug}`} className="underline">{tenantName}</Link>. This page reads the full request in agency scope pinned to the tenant; the decision runs there as you and the trigger enforce_deletion_request is the gate (reviewer or superadmin, no approval under legal hold). Execution: {executionNote(r.kind, r.state)}. <Status state="implemented" />
      </PageHeader>
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />

      <Card title="Request">
        <div className="flex flex-wrap items-center gap-2">
          <DeletionStateBadge value={r.state} />
          <DeletionKindBadge value={r.kind} />
          {r.legalHold ? <Badge tone="danger">legal hold</Badge> : null}
          <Badge tone={automated ? "cyan" : "warning"}>{automated ? "automated by the worker" : "manual runbook"}</Badge>
        </div>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs md:grid-cols-2">
          <div><dt className="text-faint">{info?.subjectLabel ?? "Subject reference"}</dt><dd className="break-all font-mono">{r.subjectRef}</dd></div>
          <div><dt className="text-faint">Reason or legal basis</dt><dd className="whitespace-pre-wrap">{r.reason}</dd></div>
          <div><dt className="text-faint">Requested by</dt><dd>{requestedByName ?? shortActor(r.requestedByActorId)} <span className="text-faint">({r.requestedByActorType}) at {fmtDate(r.createdAt)}</span></dd></div>
          <div><dt className="text-faint">Reviewer</dt><dd>{r.reviewerActorId ? <>{shortActor(r.reviewerActorId)} <span className="text-faint">at {fmtDate(r.decidedAt)}</span></> : <span className="text-faint">not decided</span>}</dd></div>
          <div><dt className="text-faint">Review note</dt><dd className="whitespace-pre-wrap">{r.reviewNote ?? <span className="text-faint">none</span>}</dd></div>
          <div><dt className="text-faint">Executed</dt><dd>{r.executedAt ? fmtDate(r.executedAt) : <span className="text-faint">{r.state === "approved" ? (automated ? WORKER_SWEEP_SCHEDULE : "waiting for manual completion") : "not executed"}</span>}</dd></div>
        </dl>
        <p className="mt-3 text-xs text-muted">{info?.help}</p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Outcome" footer="For automated kinds the worker writes the counts per table into the request; for manual kinds the superadmin's summary is stored. An audit event records every execution; audit events are never deleted.">
          {rows.length === 0 ? <Empty>{r.state === "completed" ? "Completed without counts." : "No outcome yet."}</Empty> : (
            <Table head={["Key", "Value"]}>
              {rows.map((x) => (
                <Tr key={x.key}><Td className="font-mono text-xs">{x.key}</Td><Td className="whitespace-pre-wrap text-xs">{x.value}</Td></Tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Tenant retention (effective)" footer="For context: the tenant's effective retention per data class (its override or the platform default). Rows older than these are deleted by the same weekly sweep.">
          <Table head={["Data class", "Days", "Source"]}>
            {(Object.keys(tenantRetention) as Array<keyof typeof tenantRetention>).map((dc) => (
              <Tr key={dc}><Td className="text-xs">{DATA_CLASS_LABELS[dc].label}</Td><Td className="text-xs">{tenantRetention[dc].days}</Td><Td><Badge tone={tenantRetention[dc].source === "tenant" ? "indigo" : "neutral"}>{tenantRetention[dc].source}</Badge></Td></Tr>
            ))}
          </Table>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {decisions.length > 0 ? (
          canDecide ? (
            <Card title="Decide" footer="Agency reviewer or superadmin in agency scope pinned to the tenant (trigger). A request marked legal hold cannot be approved; use reject with legal hold to park it. The note is visible to the client.">
              <form action={decideDeletionAction} className="space-y-2">
                {hidden}
                <label className="block text-xs text-faint">Decision
                  <select name="decision" className={`${selectClass} block`} defaultValue={decisions[0]}>{decisions.map((d) => <option key={d} value={d}>{d === "approved" ? "approve" : "reject"}</option>)}</select>
                </label>
                <label className="block text-xs text-faint">Review note (required)<textarea name="note" required minLength={5} maxLength={2000} rows={2} className={inputClass} placeholder="erasure obligation confirmed; no legal hold" /></label>
                <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" name="legalHold" /> legal hold (keeps the data; approval is refused while set)</label>
                <ConfirmButton className={smallPrimaryClass} message={automated ? "Record this decision? An approved request is executed by the worker on Sunday 03:00 UTC." : "Record this decision? An approved request of this kind is completed by hand after the runbook."}>Record decision</ConfirmButton>
              </form>
            </Card>
          ) : (
            <Card title="Decide"><Empty>Deciding a deletion request needs the agency_reviewer or superadmin role. Your roles: {op.roles.join(", ")}.</Empty></Card>
          )
        ) : null}

        {!automated && r.state === "approved" ? (
          superadmin ? (
            <Card title="Complete manually" footer="Superadmin only. Follow the runbook first (search answers, facts and documents for a person; export, delete per table and confirm for an off-boarding), then describe what was deleted or corrected and where (at least 20 characters).">
              <form action={completeDeletionManuallyAction} className="space-y-2">
                {hidden}
                <label className="block text-xs text-faint">Summary<textarea name="summary" required minLength={20} maxLength={4000} rows={3} className={inputClass} placeholder="Searched answers, facts and documents for the subject; two facts corrected, no documents found." /></label>
                <ConfirmButton className={smallDangerClass} message="Mark this request completed with the summary? This records that the runbook was carried out.">Complete manually</ConfirmButton>
              </form>
            </Card>
          ) : (
            <Card title="Complete manually"><Empty>This kind is not automated; a superadmin completes it with a written summary after the runbook.</Empty></Card>
          )
        ) : null}

        {automated && r.state === "approved" ? (
          <Card title="Execution"><Empty>Approved. The worker executes this request on its weekly schedule (retention.sweep, Sundays 03:00 UTC) and writes the counts here. The web app never deletes.</Empty></Card>
        ) : null}
      </div>

      <GovernanceStatusCard implemented={["Full request (subject reference, reason, review note, summary) read in agency scope pinned to the tenant; the list page sees metadata only.", "Decision (approve or reject with note and legal hold) and manual completion as server actions with audit rows; the trigger enforce_deletion_request is the gate.", "Document and connection data deletions executed by the worker (counts per table); audit events stay."]} />
    </div>
  );
}
