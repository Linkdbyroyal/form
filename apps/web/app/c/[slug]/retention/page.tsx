import { notFound } from "next/navigation";
import { clientNav, Shell } from "@/components/shell";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Card, Empty, Stat, Status, inputClass } from "@/components/ui";
import { Notice, PageHeader, ShortId, Table, Td, Tr, selectClass, smallPrimaryClass } from "@/components/agent-ui";
import { DeletionKindBadge, DeletionStateBadge, GovernanceStatusCard } from "@/components/governance-ui";
import { requestDeletionAction, setTenantRetentionAction } from "@/lib/client/retention-actions";
import { getRetentionCenter } from "@/lib/client/retention-queries";
import { getTenantHeader } from "@/lib/client/queries";
import { firstParam, fmtDate } from "@/lib/format";
import { DATA_CLASS_LABELS, DELETION_KIND_INFO, DELETION_KINDS, executionNote, RETENTION_MAX_DAYS, summaryRows, WORKER_SWEEP_SCHEDULE } from "@/lib/mission-control/governance-helpers";
import { requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function DataRetentionPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await requireTenantContext(slug);
  if (!access) notFound();
  const [tenant, center] = await Promise.all([getTenantHeader(access.ctx), getRetentionCenter(access.ctx)]);
  if (!tenant) notFound();
  const roles = access.ctx.roles;
  const isAdmin = !access.viaGrant && roles.includes("client_admin");
  const returnTo = `/c/${slug}/retention`;
  const overrides = center.classes.filter((c) => c.source === "tenant").length;
  const open = center.requests.filter((r) => r.state === "requested" || r.state === "approved" || r.state === "executing").length;
  const hidden = (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="returnTo" value={returnTo} />
    </>
  );

  return (
    <Shell title={tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
      <div className="space-y-6">
        <PageHeader title="Data & Retention">
          How long the platform keeps your operational data per class, and your requests to delete specific data. Retention runs on a weekly sweep; deletion requests are decided by an agency reviewer and then {WORKER_SWEEP_SCHEDULE} or, for a person or an off-boarding, completed by hand with a written summary. Audit events are never deleted. <Status state="implemented" />
        </PageHeader>
        <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge tone="cyan">your roles: {roles.join(", ") || "none"}</Badge>
          {access.viaGrant ? <Badge tone="danger">break-glass grant: read-only, access is logged; retention and deletion decisions stay with your client admin</Badge> : null}
          {!isAdmin && !access.viaGrant ? <Badge tone="neutral">overrides and deletion requests are made by the client_admin role</Badge> : null}
        </div>
        <div className="grid gap-4 md:grid-cols-4">
          <Stat label="Data classes" value={center.classes.length} hint={`${overrides} with a workspace override`} />
          <Stat label="Open deletion requests" value={open} hint="requested, approved or executing" />
          <Stat label="Completed requests" value={center.requests.filter((r) => r.state === "completed").length} />
          <Stat label="Sweeps recorded" value={center.sweeps.length} hint="rows deleted by the weekly sweep" />
        </div>

        <Card title="Effective retention per data class" footer={`Platform default or your override, whichever applies. Every class has a floor the platform enforces (also in the database); an override below it is refused. Maximum ${RETENTION_MAX_DAYS} days. Changes apply on the next sweep (Sundays 03:00 UTC).`}>
          <Table head={["Data class", "What it holds", "Effective (days)", "Source", "Floor (days)", "Reason", isAdmin ? "Override" : ""]}>
            {center.classes.map((c) => (
              <Tr key={c.dataClass}>
                <Td className="font-medium">{DATA_CLASS_LABELS[c.dataClass].label}<div className="font-mono text-[11px] text-faint">{c.dataClass}</div></Td>
                <Td className="max-w-xs text-xs text-muted">{DATA_CLASS_LABELS[c.dataClass].description}</Td>
                <Td className="text-lg font-semibold">{c.days}</Td>
                <Td><Badge tone={c.source === "tenant" ? "indigo" : "neutral"}>{c.source === "tenant" ? "workspace override" : "platform default"}</Badge>{c.source === "tenant" && c.platformDefault ? <div className="text-[11px] text-faint">default {c.platformDefault.days}</div> : null}</Td>
                <Td className="text-xs">{c.floor}</Td>
                <Td className="max-w-xs text-xs text-muted">{c.reason}{c.override ? <div className="text-[11px] text-faint">set {fmtDate(c.override.updatedAt)}</div> : null}</Td>
                <Td>
                  {isAdmin ? (
                    <form action={setTenantRetentionAction} className="flex flex-col gap-1">
                      {hidden}
                      <input type="hidden" name="dataClass" value={c.dataClass} />
                      <input name="retentionDays" type="number" required min={c.floor} max={RETENTION_MAX_DAYS} defaultValue={c.days} title={`at least ${c.floor} days`} className={`${inputClass} w-24`} />
                      <input name="reason" required minLength={5} maxLength={1000} placeholder="Reason (required)" className={`${inputClass} w-44`} />
                      <ConfirmButton className={smallPrimaryClass} message={`Set retention for ${c.dataClass} for this workspace? Rows older than that are deleted on the next weekly sweep.`}>Set override</ConfirmButton>
                    </form>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </Table>
        </Card>

        <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
          <Card title="Request a deletion" footer="Filed as requested; an agency reviewer approves or rejects with a note you can read below. Nothing is deleted until approval, and never by this page.">
            {isAdmin ? (
              <form action={requestDeletionAction} className="space-y-2">
                {hidden}
                <label className="block text-xs text-faint">Kind<select name="kind" className={`${selectClass} block w-full`} defaultValue="document">{DELETION_KINDS.map((k) => <option key={k} value={k}>{DELETION_KIND_INFO[k].label}</option>)}</select></label>
                <label className="block text-xs text-faint">Subject reference<input name="subjectRef" required maxLength={500} className={inputClass} placeholder="19_history_and_archive/former-employee.md" /></label>
                <ul className="space-y-1 text-[11px] text-faint">
                  {DELETION_KINDS.map((k) => <li key={k}><span className="font-medium text-muted">{DELETION_KIND_INFO[k].label}:</span> {DELETION_KIND_INFO[k].help}</li>)}
                </ul>
                <label className="block text-xs text-faint">Reason or legal basis (at least 10 characters)<textarea name="reason" required minLength={10} maxLength={4000} rows={3} className={inputClass} placeholder="former employee asked for erasure (GDPR article 17)" /></label>
                <ConfirmButton className={smallPrimaryClass} message="File this deletion request? An agency reviewer decides; nothing is deleted yet.">File request</ConfirmButton>
              </form>
            ) : <Empty>Deletion requests are filed by the client_admin role{access.viaGrant ? " and never under a break-glass grant" : ""}.</Empty>}
          </Card>

          <Card title={`Deletion requests (${center.requests.length})`} footer="Your workspace's requests with the reviewer's note, the execution time and the counts per table (or the written summary for manual kinds).">
            <Table head={["Filed", "Kind", "Subject", "State", "Reviewer note", "Executed", "Outcome"]} empty={center.requests.length === 0 ? <Empty>No deletion requests yet.</Empty> : null}>
              {center.requests.map((r) => {
                const rows = summaryRows(r.summary);
                return (
                  <Tr key={r.id}>
                    <Td className="text-xs text-muted">{fmtDate(r.createdAt)}<div><ShortId id={r.id} /></div><div className="text-[11px] text-faint">by {r.requestedByName ?? r.requestedByActorId.slice(0, 8)}</div></Td>
                    <Td><DeletionKindBadge value={r.kind} /></Td>
                    <Td className="max-w-xs break-all font-mono text-[11px]">{r.subjectRef}<div className="font-sans text-[11px] text-faint">{r.reason.length > 80 ? `${r.reason.slice(0, 80)}…` : r.reason}</div></Td>
                    <Td><DeletionStateBadge value={r.state} />{r.legalHold ? <div><Badge tone="danger">legal hold</Badge></div> : null}<div className="mt-1 text-[11px] text-faint">{executionNote(r.kind, r.state)}</div></Td>
                    <Td className="max-w-xs whitespace-pre-wrap text-xs">{r.reviewNote ?? <span className="text-faint">none yet</span>}{r.decidedAt ? <div className="text-[11px] text-faint">{fmtDate(r.decidedAt)}</div> : null}</Td>
                    <Td className="text-xs text-muted">{r.executedAt ? fmtDate(r.executedAt) : ""}</Td>
                    <Td className="text-xs">{rows.length === 0 ? <span className="text-faint">none</span> : <ul>{rows.map((x) => <li key={x.key}><span className="font-mono text-[11px] text-muted">{x.key}</span>: {x.value}</li>)}</ul>}</Td>
                  </Tr>
                );
              })}
            </Table>
          </Card>
        </div>

        <Card title={`Retention sweep history (${center.sweeps.length})`} footer="One row per data class per sweep in which rows older than the cutoff were deleted for this workspace. Sweeps that deleted nothing leave no row. Written by the worker, never by this page.">
          <Table head={["Ran at", "Data class", "Cutoff", "Rows deleted"]} empty={center.sweeps.length === 0 ? <Empty>No sweep has deleted rows for this workspace yet. The sweep runs {WORKER_SWEEP_SCHEDULE.replace("executed by the worker on its weekly schedule ", "")}.</Empty> : null}>
            {center.sweeps.map((s) => (
              <Tr key={s.id}>
                <Td className="text-xs text-muted">{fmtDate(s.ranAt)}</Td>
                <Td className="text-xs">{DATA_CLASS_LABELS[s.dataClass as keyof typeof DATA_CLASS_LABELS]?.label ?? s.dataClass}</Td>
                <Td className="text-xs text-muted">{fmtDate(s.cutoff)}</Td>
                <Td className="text-xs">{s.deletedCount}</Td>
              </Tr>
            ))}
          </Table>
        </Card>

        <GovernanceStatusCard implemented={["Effective retention per data class (platform default or workspace override) with floor and reason, read in tenant context.", "Override per class and deletion requests (client_admin only, never under a break-glass grant); the floor is checked in the form, in the action and by the database.", "Your requests with state, reviewer note, execution time and counts; sweep history from retention_sweeps."]} footer="Tenant context: RLS returns this workspace's rows and the platform defaults only. Deletions run in agency scope by the worker; a tenant context cannot delete audit-class rows (restrictive policy)." />
      </div>
    </Shell>
  );
}
