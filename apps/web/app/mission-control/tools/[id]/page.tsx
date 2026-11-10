import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Card, Empty, Status, inputClass } from "@/components/ui";
import { Masked, Mono, Notice, PageHeader, ShortId, Table, Td, Tr, selectClass, smallButtonClass, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { ConnectionStatusBadge, ConsentBadge, IntegrationStatusCard, ModeBadge, PhaseBadge, PhaseChangeKindBadge, PhaseExplainer, PhaseLadder, ReviewOutcomeBadge, SyncStatusBadge } from "@/components/integration-ui";
import { agencyActionsFor, CREDENTIAL_KINDS, describeScopes, fmtInterval, fmtSyncDuration, phaseLabel, SECRET_REF_RE } from "@/lib/client/integration-helpers";
import { firstParam, fmtDate } from "@/lib/format";
import { advancePhaseAction, enqueueSyncAction, pauseResumeAction, registerCredentialAction, registerWebhookAction, securityReviewAction } from "@/lib/mission-control/tools-actions";
import { getConnectionDetail } from "@/lib/mission-control/tools-queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** HTML pattern attribute: same rule as SECRET_REF_RE without the anchors. */
const SECRET_REF_PATTERN = SECRET_REF_RE.source.replace(/^\^/, "").replace(/\$$/, "");

export default async function ConnectedToolDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  await requireOperatorContext();
  const sp = await searchParams;
  const detail = await getConnectionDetail(id);
  if (!detail) notFound();
  const { connection: c, descriptor, phaseChanges, syncRuns, observationsBySyncRun, credentials, webhooks } = detail;
  const offered = agencyActionsFor(c);
  const returnTo = `/mission-control/tools/${c.id}`;
  const title = `${c.displayName} for ${c.tenantName}`;
  const granted = describeScopes(descriptor, c.scopes);
  const hidden = (
    <>
      <input type="hidden" name="connectionId" value={c.id} />
      <input type="hidden" name="tenantId" value={c.tenantId} />
      <input type="hidden" name="returnTo" value={returnTo} />
    </>
  );

  return (
    <div className="space-y-6">
      <PageHeader title={title} crumbs={[{ href: "/mission-control/tools", label: "Connected Tools" }, { label: c.displayName }]}>
        Connection <ShortId id={c.id} /> of <Link href={`/mission-control/clients/${c.tenantSlug}`} className="underline">{c.tenantName}</Link>{c.systemName ? ` for system ${c.systemName}` : ""}. Decisions on this page run as you in agency scope pinned to this tenant; the database trigger enforce_connection_phase is the gate and its text is shown when it refuses. <Status state="implemented" />
      </PageHeader>
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
      <div className="rounded-card border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
        Live connectors are not implemented yet (sandbox fixtures only, every sync labelled simulated). Credential and webhook references point into the worker's environment; no value is stored or shown here.
      </div>

      <Card title="State">
        <div className="flex flex-wrap items-center gap-2">
          <PhaseBadge phase={c.phase} />
          <ConnectionStatusBadge status={c.status} />
          <ConsentBadge consent={c.consent} />
          <Mono>{c.provider}</Mono>
          {c.openIncidents > 0 ? <Link href="/mission-control/errors" className="underline"><Badge tone="danger">{c.openIncidents} open incident(s)</Badge></Link> : null}
        </div>
        <div className="mt-3"><PhaseLadder phase={c.phase} /></div>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs md:grid-cols-3">
          <div><dt className="text-faint">Consent</dt><dd>{c.consent === "granted" ? `granted ${fmtDate(c.consentGivenAt)} (client admin; name is tenant content)` : c.consent}</dd></div>
          <div><dt className="text-faint">Scopes granted</dt><dd>{granted.length === 0 ? <span className="text-faint">none</span> : <ul>{granted.map((s) => <li key={s.scope}><span className="font-mono">{s.scope}</span>{s.gloss ? <span className="text-muted">: {s.gloss}</span> : null}</li>)}</ul>}</dd></div>
          <div><dt className="text-faint">Security review</dt><dd>{c.securityReviewedAt ? `approved ${fmtDate(c.securityReviewedAt)} by ${c.securityReviewedBy ?? "agency"}` : <span className="text-faint">not recorded</span>}</dd></div>
          <div><dt className="text-faint">Last sync</dt><dd>{c.lastSyncAt ? fmtDate(c.lastSyncAt) : "never"}</dd></div>
          <div><dt className="text-faint">Interval</dt><dd>{fmtInterval(c.syncIntervalMinutes)}</dd></div>
          <div><dt className="text-faint">Paused reason</dt><dd>{c.pausedReason ?? <span className="text-faint">none</span>}</dd></div>
          <div><dt className="text-faint">Last error</dt><dd><Masked what="connections.last_error" /> <span className="text-faint">visible to the client in its Integration Center</span></dd></div>
          <div><dt className="text-faint">Config</dt><dd><Masked what="connections.config" /></dd></div>
          <div><dt className="text-faint">Created</dt><dd>{fmtDate(c.createdAt)}</dd></div>
        </dl>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Security review" footer="Agency decision (superadmin, agency_operator, agency_reviewer) after the client's consent. Approved sets security_reviewed_at; rejected clears it and stores the note as the paused reason.">
          {offered.review ? (
            <form action={securityReviewAction} className="space-y-2">
              {hidden}
              <label className="block text-xs text-faint">Outcome
                <select name="outcome" className={`${selectClass} block`} defaultValue="approved"><option value="approved">approved</option><option value="rejected">rejected</option></select>
              </label>
              <label className="block text-xs text-faint">Note (at least 10 characters)<textarea name="note" required minLength={10} maxLength={2000} rows={2} className={inputClass} placeholder="Scopes checked, data categories, where the token lives" /></label>
              <ConfirmButton className={smallPrimaryClass} message="Record this security review?">Record review</ConfirmButton>
            </form>
          ) : <Empty>A security review follows the client's consent; consent is {c.consent}.</Empty>}
        </Card>

        <Card title="Advance phase" footer="One step at a time, as the trigger demands. The write phase is never offered: the database refuses it in this release.">
          {offered.advanceTo ? (
            <form action={advancePhaseAction} className="space-y-2">
              {hidden}
              <input type="hidden" name="to" value={offered.advanceTo} />
              <div className="text-sm">From <PhaseBadge phase={c.phase} /> to <PhaseBadge phase={offered.advanceTo} /></div>
              <label className="block text-xs text-faint">Reason<input name="reason" required maxLength={1000} className={inputClass} placeholder="Why this step now" /></label>
              <ConfirmButton className={smallPrimaryClass} message={`Advance ${c.displayName} to ${phaseLabel(offered.advanceTo)}? The worker starts reading the agreed fields on the next interval.`}>Advance to {phaseLabel(offered.advanceTo)}</ConfirmButton>
            </form>
          ) : <Empty>No advance offered: {offered.advanceBlockedBy}.</Empty>}
        </Card>

        <Card title="Pause or resume" footer="Paused connections are skipped by scheduled and manual syncs; a test connection still runs.">
          {offered.pause ? (
            <form action={pauseResumeAction} className="flex flex-wrap items-end gap-2">
              {hidden}
              <input type="hidden" name="action" value="pause" />
              <label className="flex-1 text-xs text-faint">Reason<input name="reason" required maxLength={500} className={inputClass} /></label>
              <ConfirmButton className={smallDangerClass} message="Pause this connection?">Pause</ConfirmButton>
            </form>
          ) : offered.resume ? (
            <form action={pauseResumeAction} className="flex flex-wrap items-end gap-2">
              {hidden}
              <input type="hidden" name="action" value="resume" />
              <label className="flex-1 text-xs text-faint">Reason<input name="reason" required maxLength={500} className={inputClass} /></label>
              <ConfirmButton className={smallPrimaryClass} message="Resume this connection?">Resume</ConfirmButton>
            </form>
          ) : <Empty>{c.status === "paused" ? "A connection in the metadata phase has nothing to resume; advance the phase instead." : `Status ${c.status}: nothing to pause or resume.`}</Empty>}
        </Card>

        <Card title="Run sync now / Test connection" footer="Both only enqueue the connector.sync job (trigger manual or test); the worker runs it and writes the sync run. The web app never runs a sync. Sandbox mode: simulated fixtures, no external system is contacted.">
          <div className="flex flex-wrap gap-2">
            <form action={enqueueSyncAction}>{hidden}<input type="hidden" name="trigger" value="manual" /><button type="submit" className={smallPrimaryClass} disabled={!offered.runSync}>Run sync now</button></form>
            <form action={enqueueSyncAction}>{hidden}<input type="hidden" name="trigger" value="test" /><button type="submit" className={smallButtonClass} disabled={!offered.testConnection}>Test connection</button></form>
          </div>
          {!offered.testConnection ? <p className="mt-2 text-xs text-faint">Not available in phase {phaseLabel(c.phase)}{c.consent !== "granted" ? " without consent" : ""}: the metadata phase allows no external call.</p> : !offered.runSync ? <p className="mt-2 text-xs text-faint">Manual sync runs only while the connection is active (status {c.status}); a test connection is still allowed.</p> : null}
        </Card>
      </div>

      <Card title={`Credential references (${credentials.length})`} footer={`A reference such as env:NAME names a variable in the worker's environment. The value never passes through this app or this database. ${descriptor ? `Live ${descriptor.displayName} would need: ${descriptor.secretRefs.join(", ")}.` : ""}`}>
        <Table head={["Kind", "Secret reference", "Rotated", "Expires", "Registered by", "Created"]} empty={credentials.length === 0 ? <Empty>No credential reference registered. Sandbox syncs need none.</Empty> : null}>
          {credentials.map((r) => (
            <Tr key={r.id}>
              <Td>{r.kind}</Td>
              <Td><Mono>{r.secretRef}</Mono> <Badge tone="indigo">reference, not a value</Badge></Td>
              <Td className="text-muted">{fmtDate(r.rotatedAt)}</Td>
              <Td className="text-muted">{fmtDate(r.expiresAt)}</Td>
              <Td className="text-xs text-muted">{r.createdByActorId.length > 12 ? `${r.createdByActorId.slice(0, 8)}…` : r.createdByActorId}</Td>
              <Td className="text-muted">{fmtDate(r.createdAt)}</Td>
            </Tr>
          ))}
        </Table>
        <form action={registerCredentialAction} className="mt-4 flex flex-wrap items-end gap-2 rounded-card border border-border p-3">
          {hidden}
          <label className="text-xs text-faint">Kind<select name="kind" className={`${selectClass} block`}>{CREDENTIAL_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
          <label className="flex-1 text-xs text-faint">Secret reference (env:NAME)<input name="secretRef" required pattern={SECRET_REF_PATTERN} title="env:VARIABLE_NAME in upper case" maxLength={120} className={inputClass} placeholder={descriptor?.secretRefs[0] ?? "env:PROVIDER_API_TOKEN"} /></label>
          <label className="text-xs text-faint">Expires (optional)<input name="expiresAt" type="date" className={inputClass} /></label>
          <ConfirmButton className={smallPrimaryClass} message="Register this credential reference? Only the env:NAME reference is stored.">Register reference</ConfirmButton>
        </form>
      </Card>

      <Card title={`Webhook endpoints (${webhooks.length})`} footer="The path token is generated server-side (32 url-safe characters). The signing secret is a reference into the worker's environment. No inbound webhook handler is deployed in this release: signature state stays unverified until one is.">
        <Table head={["Path token", "Signing secret reference", "Signature", "Last received", "Registered by", "Created"]} empty={webhooks.length === 0 ? <Empty>No webhook endpoint registered.</Empty> : null}>
          {webhooks.map((w) => (
            <Tr key={w.id}>
              <Td><Mono>{w.pathToken}</Mono></Td>
              <Td><Mono>{w.secretRef}</Mono></Td>
              <Td><Badge tone={w.signatureState === "verified" ? "success" : w.signatureState === "failed" ? "danger" : "neutral"}>{w.signatureState}</Badge></Td>
              <Td className="text-muted">{fmtDate(w.lastReceivedAt)}</Td>
              <Td className="text-xs text-muted">{w.createdByActorId.length > 12 ? `${w.createdByActorId.slice(0, 8)}…` : w.createdByActorId}</Td>
              <Td className="text-muted">{fmtDate(w.createdAt)}</Td>
            </Tr>
          ))}
        </Table>
        <form action={registerWebhookAction} className="mt-4 flex flex-wrap items-end gap-2 rounded-card border border-border p-3">
          {hidden}
          <label className="flex-1 text-xs text-faint">Signing secret reference (env:NAME)<input name="secretRef" required pattern={SECRET_REF_PATTERN} title="env:VARIABLE_NAME in upper case" maxLength={120} className={inputClass} placeholder="env:PROVIDER_WEBHOOK_SECRET" /></label>
          <ConfirmButton className={smallPrimaryClass} message="Register a webhook endpoint with a new random path token?">Register endpoint</ConfirmButton>
        </form>
      </Card>

      <Card title={`Sync runs (${syncRuns.length})`} footer="Metadata columns only: the error text of a failed run is tenant content and is shown to the client in its Integration Center, not here. Observations counts the kpi_observations rows that carry this sync run as lineage.">
        <Table head={["Started", "Trigger", "Phase", "Mode", "Status", "Objects", "Observations written", "Observations stored", "Duration", "Error class", "Error text"]} empty={syncRuns.length === 0 ? <Empty>No sync runs yet. Runs appear once the worker processes a scheduled, manual or test sync.</Empty> : null}>
          {syncRuns.map((r) => (
            <Tr key={r.id}>
              <Td className="text-muted">{fmtDate(r.startedAt)}</Td>
              <Td><Badge tone={r.trigger === "schedule" ? "indigo" : r.trigger === "test" ? "cyan" : "neutral"}>{r.trigger}</Badge></Td>
              <Td><PhaseBadge phase={r.phase} /></Td>
              <Td><ModeBadge mode={r.mode} /></Td>
              <Td><SyncStatusBadge status={r.status} /></Td>
              <Td>{r.objectsRead}</Td>
              <Td>{r.observationsWritten}</Td>
              <Td>{observationsBySyncRun.get(r.id) ?? 0}</Td>
              <Td className="text-muted">{fmtSyncDuration(r.startedAt, r.finishedAt)}</Td>
              <Td className="text-xs text-muted">{r.errorClass ?? ""}</Td>
              <Td>{r.status === "failed" ? <Masked what="sync_runs.error_message" /> : null}</Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <Card title={`Phase change timeline (${phaseChanges.length})`} footer="The reason column is tenant content (consent basis, review note) and is not granted to the operator role; the client sees it in its Integration Center.">
        <Table head={["When", "Kind", "Phase", "Actor", "Roles", "Consent", "Scopes", "Review", "Reason"]}>
          {phaseChanges.map((p) => (
            <Tr key={p.id}>
              <Td className="text-muted">{fmtDate(p.createdAt)}</Td>
              <Td><PhaseChangeKindBadge kind={p.kind} /></Td>
              <Td className="text-xs">{p.fromPhase ? `${phaseLabel(p.fromPhase)} to ` : ""}{phaseLabel(p.toPhase)}</Td>
              <Td className="text-xs">{p.actorId.length > 24 ? `${p.actorId.slice(0, 8)}…` : p.actorId} <span className="text-faint">({p.actorType})</span></Td>
              <Td className="text-xs text-muted">{p.roles.join(", ")}</Td>
              <Td className="text-xs">{p.consent ?? ""}</Td>
              <Td className="font-mono text-xs">{p.scopes.join(", ")}</Td>
              <Td><ReviewOutcomeBadge outcome={p.reviewOutcome} /></Td>
              <Td><Masked what="connection_phase_changes.reason" /></Td>
            </Tr>
          ))}
        </Table>
      </Card>

      {descriptor ? (
        <Card title={`What ${descriptor.displayName} reads per phase`}>
          <PhaseExplainer descriptor={descriptor} />
        </Card>
      ) : (
        <Card title="Descriptor"><Empty>Provider {c.provider} has no connector descriptor in this release.</Empty></Card>
      )}

      <IntegrationStatusCard implemented={["Security review, phase advance (next step only), pause and resume, credential and webhook references, run sync now and test connection, each as a server action in agency scope pinned to the tenant with an audit row.", "Timeline, sync runs and observation counts through the operator role; references through the pinned agency scope."]} />
    </div>
  );
}
