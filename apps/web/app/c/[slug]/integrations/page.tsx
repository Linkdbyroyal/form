import Link from "next/link";
import { notFound } from "next/navigation";
import { clientNav, Shell } from "@/components/shell";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Card, Empty, Stat, Status, inputClass } from "@/components/ui";
import { Mono, Notice, PageHeader, ShortId, Table, Td, Tr, selectClass, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { ConnectionStatusBadge, ConsentBadge, IntegrationStatusCard, ModeBadge, PhaseBadge, PhaseChangeKindBadge, PhaseExplainer, PhaseLadder, ReviewOutcomeBadge, SyncStatusBadge } from "@/components/integration-ui";
import { grantConsentAction, proposeConnectionAction, revokeConsentAction } from "@/lib/client/integration-actions";
import { clientActionsFor, describeScopes, fmtInterval, fmtSyncDuration, kpiStatusTone, scopesForPhase, suggestProvider, SYNC_INTERVAL_MAX, SYNC_INTERVAL_MIN } from "@/lib/client/integration-helpers";
import { getIntegrationCenter, type ConnectionView, type SystemView } from "@/lib/client/integration-queries";
import { getTenantHeader } from "@/lib/client/queries";
import { firstParam, fmtDate } from "@/lib/format";
import { requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function IntegrationCenterPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await requireTenantContext(slug);
  if (!access) notFound();
  const [tenant, center] = await Promise.all([getTenantHeader(access.ctx), getIntegrationCenter(access.ctx)]);
  if (!tenant) notFound();
  const roles = access.ctx.roles;
  const isAdmin = !access.viaGrant && roles.includes("client_admin");
  const returnTo = `/c/${slug}/integrations`;
  const all = [...center.systems.flatMap((s) => s.connections), ...center.orphanConnections];
  const reading = all.filter((c) => c.phase !== "metadata" && c.status === "active");

  return (
    <Shell title={tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
      <div className="space-y-6">
        <PageHeader title="Integration Center">
          Your systems and what the platform may read from them. Every connection moves metadata to read-only to sandbox one step at a time, and only after your consent per phase. Nothing is read until the phase is read-only. <Status state="implemented" />
        </PageHeader>
        <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge tone="cyan">your roles: {roles.join(", ") || "none"}</Badge>
          {access.viaGrant ? <Badge tone="danger">break-glass grant: read-only, access is logged; consent decisions stay with your client admin</Badge> : null}
          {!isAdmin && !access.viaGrant ? <Badge tone="neutral">consent is granted and revoked by the client_admin role</Badge> : null}
        </div>
        <div className="grid gap-4 md:grid-cols-4">
          <Stat label="Registered systems" value={center.systems.length} hint="from the onboarding intake" />
          <Stat label="Connections" value={all.length} hint="proposed or active" />
          <Stat label="Reading" value={reading.length} hint="phase read-only or sandbox, active" />
          <Stat label="Awaiting your consent" value={all.filter((c) => c.consent === "pending").length} hint="metadata phase, nothing is read" />
        </div>

        <Card title="How the phases work" footer="Consent is recorded with who, when and which scopes. The security review and the phase advance are agency decisions recorded in Mission Control; agents never change a phase or a consent. Revoking consent drops a connection back to metadata, pauses it and marks the KPIs it feeds as missing_source.">
          <PhaseExplainer descriptor={null} />
        </Card>

        {center.systems.length === 0 ? <Empty>No systems registered yet. Systems come from the onboarding intake; a connection can only be proposed for a registered system.</Empty> : null}
        {center.systems.map((s) => (
          <SystemCard key={s.id} system={s} slug={slug} returnTo={returnTo} isAdmin={isAdmin} descriptors={center.descriptors} />
        ))}
        {center.orphanConnections.length > 0 ? (
          <Card title="Connections without a registered system">
            <div className="space-y-4">
              {center.orphanConnections.map((c) => <ConnectionBlock key={c.id} c={c} slug={slug} returnTo={returnTo} isAdmin={isAdmin} />)}
            </div>
          </Card>
        ) : null}

        <IntegrationStatusCard implemented={["Connections per registered system with phase, consent (who, when, scopes), status, last sync, interval and the masked last error.", "Propose connection, grant consent per scope and revoke consent (client_admin only, never under a break-glass grant); the database trigger enforce_connection_phase is the gate.", "Sync runs and the phase change timeline from the database; KPIs fed by a connection with their status and lineage link."]} />
      </div>
    </Shell>
  );
}

function SystemCard({ system, slug, returnTo, isAdmin, descriptors }: { system: SystemView; slug: string; returnTo: string; isAdmin: boolean; descriptors: ConnectionView["descriptor"][] }) {
  const known = descriptors.filter((d): d is NonNullable<typeof d> => d !== null);
  const suggested = suggestProvider(system, known);
  return (
    <Card title={`${system.name}${system.vendor ? ` (${system.vendor})` : ""}`} footer={`Function: ${system.function}. Claim status: ${system.claimStatus}.`}>
      {system.connections.length === 0 ? (
        <div className="space-y-3">
          <Empty>No connection for this system. It is registered as metadata only: name, function and vendor. Nothing is read.</Empty>
          {isAdmin ? (
            <form action={proposeConnectionAction} className="flex flex-wrap items-end gap-2 rounded-card border border-border p-3">
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <input type="hidden" name="systemId" value={system.id} />
              <label className="text-xs text-faint">Provider
                <select name="provider" defaultValue={suggested ?? known[0]?.provider} className={`${selectClass} block`}>
                  {known.map((d) => <option key={d.provider} value={d.provider}>{d.displayName} ({d.vendor})</option>)}
                </select>
              </label>
              <label className="text-xs text-faint">Sync interval (minutes, {SYNC_INTERVAL_MIN} to {SYNC_INTERVAL_MAX})
                <input name="syncIntervalMinutes" type="number" min={SYNC_INTERVAL_MIN} max={SYNC_INTERVAL_MAX} defaultValue={60} className={`${inputClass} w-40`} />
              </label>
              <label className="flex-1 text-xs text-faint">Why (optional)
                <input name="reason" maxLength={1000} className={inputClass} placeholder="Which question should this connection answer?" />
              </label>
              <ConfirmButton className={smallPrimaryClass} message={`Propose a connection for ${system.name}? It starts in phase metadata with consent pending; nothing is read.`}>Propose connection</ConfirmButton>
            </form>
          ) : (
            <div className="text-xs text-faint">Proposing a connection requires the client_admin role.</div>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {system.connections.map((c) => <ConnectionBlock key={c.id} c={c} slug={slug} returnTo={returnTo} isAdmin={isAdmin} />)}
        </div>
      )}
    </Card>
  );
}

function ConnectionBlock({ c, slug, returnTo, isAdmin }: { c: ConnectionView; slug: string; returnTo: string; isAdmin: boolean }) {
  const offered = clientActionsFor(c, isAdmin);
  const readOnlyScopes = c.descriptor ? scopesForPhase(c.descriptor, "read_only") : [];
  const granted = describeScopes(c.descriptor, c.scopes);
  const title = c.descriptor?.displayName ?? c.provider;
  return (
    <div className="space-y-4 rounded-card border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{title}</span>
        <Mono>{c.provider}</Mono>
        <PhaseBadge phase={c.phase} />
        <ConnectionStatusBadge status={c.status} />
        <ConsentBadge consent={c.consent} />
        {!c.descriptor ? <Badge tone="danger">unknown provider: no descriptor</Badge> : <Badge tone="warning">sandbox fixtures: simulated</Badge>}
        <span className="ml-auto"><ShortId id={c.id} /></span>
      </div>
      <PhaseLadder phase={c.phase} />
      <dl className="grid gap-x-6 gap-y-2 text-xs md:grid-cols-3">
        <div><dt className="text-faint">Consent</dt><dd>{c.consent === "granted" ? `granted by ${c.consentGivenByName ?? "unknown user"} at ${fmtDate(c.consentGivenAt)}` : c.consent === "revoked" ? `revoked${c.pausedReason ? `: ${c.pausedReason}` : ""}` : "pending: nothing is read"}</dd></div>
        <div><dt className="text-faint">Scopes granted</dt><dd>{granted.length === 0 ? <span className="text-faint">none</span> : <ul className="space-y-0.5">{granted.map((s) => <li key={s.scope}><span className="font-mono">{s.scope}</span>{s.gloss ? <span className="text-muted">: {s.gloss}</span> : null}</li>)}</ul>}</dd></div>
        <div><dt className="text-faint">Security review</dt><dd>{c.securityReviewedAt ? `approved ${fmtDate(c.securityReviewedAt)} by ${c.securityReviewedBy ?? "agency"}` : "not recorded (agency decision in Mission Control)"}</dd></div>
        <div><dt className="text-faint">Last sync</dt><dd>{c.lastSyncAt ? fmtDate(c.lastSyncAt) : "never"}</dd></div>
        <div><dt className="text-faint">Sync interval</dt><dd>{fmtInterval(c.syncIntervalMinutes)}</dd></div>
        <div><dt className="text-faint">Last error (masked as stored)</dt><dd>{c.lastError ? <span className="font-mono text-danger">{c.lastError}</span> : <span className="text-faint">none</span>}</dd></div>
        {c.status === "paused" && c.pausedReason ? <div className="md:col-span-3"><dt className="text-faint">Paused</dt><dd>{c.pausedReason}</dd></div> : null}
      </dl>

      {c.phase === "metadata" ? <div className="rounded-card border border-dashed border-border p-3 text-xs text-muted">Phase metadata: nothing is read from {title}. {c.consent === "granted" ? "Your consent is recorded. The agency now records a security review and advances the phase to read-only; only then does the worker read the listed fields." : "After your consent, the agency records a security review and advances the phase to read-only. Only then does the worker read the listed fields."}</div> : null}

      {c.descriptor ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">What {title} reads in each phase, and never reads</summary>
          <div className="mt-2"><PhaseExplainer descriptor={c.descriptor} /></div>
        </details>
      ) : null}

      {offered.grantConsent && c.descriptor ? (
        <form action={grantConsentAction} className="space-y-2 rounded-card border border-cyan/30 p-3">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="connectionId" value={c.id} />
          <input type="hidden" name="provider" value={c.provider} />
          <div className="text-sm font-medium">Grant read-only consent for {title}</div>
          <p className="text-xs text-muted">By granting consent you allow the platform read-only access to exactly the scopes you tick below, in the fields listed above. Nothing is written back. You can revoke this at any time; revoking drops the connection back to metadata and pauses it. The agency still has to record a security review and advance the phase before anything is read.</p>
          <ul className="space-y-1">
            {readOnlyScopes.map((s) => (
              <li key={s.scope}><label className="flex items-start gap-2 text-xs"><input type="checkbox" name="scopes" value={s.scope} className="mt-0.5" /><span><span className="font-mono">{s.scope}</span><span className="text-muted">: {s.gloss}</span></span></label></li>
            ))}
          </ul>
          <label className="block text-xs text-faint">Reason or basis (at least 10 characters)<textarea name="reason" required minLength={10} maxLength={2000} rows={2} className={inputClass} placeholder="For example: agreed in the kick-off on <date>; read-only, no amounts" /></label>
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" name="acknowledge" value="yes" required className="mt-0.5" /><span>I understand this allows read-only access to the ticked scopes only and that I can revoke it at any time.</span></label>
          <ConfirmButton className={smallPrimaryClass} message={`Grant read-only consent for ${title} with the ticked scopes? It is recorded with your name and the time.`}>Grant consent</ConfirmButton>
        </form>
      ) : null}
      {offered.revokeConsent ? (
        <form action={revokeConsentAction} className="flex flex-wrap items-end gap-2 rounded-card border border-danger/30 p-3">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="connectionId" value={c.id} />
          <label className="flex-1 text-xs text-faint">Revoke consent: reason<input name="reason" required minLength={3} maxLength={500} className={inputClass} placeholder="Why consent is withdrawn" /></label>
          <ConfirmButton className={smallDangerClass} message={`Revoke consent for ${title}? The connection drops to metadata and pauses; KPIs fed by it become missing_source.`}>Revoke consent</ConfirmButton>
        </form>
      ) : null}
      {!isAdmin && c.consent !== "granted" ? <div className="text-xs text-faint">Granting consent requires the client_admin role.</div> : null}

      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">KPIs fed by this connection ({c.kpis.length})</div>
        {c.kpis.length === 0 ? <div className="text-xs text-faint">No KPI references this source yet. The first successful read-only sync defines the descriptor's metrics as KPIs with formula and source field.</div> : (
          <ul className="flex flex-wrap gap-2 text-xs">
            {c.kpis.map((k) => (
              <li key={k.id} className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5">
                <Link href={`/c/${slug}/dashboard/kpi/${k.id}`} className="underline">{k.name}</Link>
                <Badge tone={kpiStatusTone(k.status)}>{k.status.replaceAll("_", " ")}</Badge>
                <span className="text-faint">{k.sourceSystem}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Recent sync runs ({c.syncRuns.length})</div>
        <Table head={["Started", "Trigger", "Phase", "Mode", "Status", "Objects", "Observations", "Duration", "Note or error (masked)"]} empty={c.syncRuns.length === 0 ? <Empty>No sync runs yet. Runs appear once the worker processes a scheduled or manual sync.</Empty> : null}>
          {c.syncRuns.map((r) => (
            <Tr key={r.id}>
              <Td className="text-muted">{fmtDate(r.startedAt)}</Td>
              <Td><Badge tone={r.trigger === "schedule" ? "indigo" : "neutral"}>{r.trigger}</Badge></Td>
              <Td><PhaseBadge phase={r.phase} /></Td>
              <Td><ModeBadge mode={r.mode} /></Td>
              <Td><SyncStatusBadge status={r.status} /></Td>
              <Td>{r.objectsRead}</Td>
              <Td>{r.observationsWritten}</Td>
              <Td className="text-muted">{fmtSyncDuration(r.startedAt, r.finishedAt)}</Td>
              <Td className="max-w-md text-xs text-muted">{r.errorMessage ? <span className="font-mono text-danger">{r.errorClass}: {r.errorMessage}</span> : r.note}</Td>
            </Tr>
          ))}
        </Table>
      </div>

      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Phase change timeline ({c.phaseChanges.length})</div>
        <Table head={["When", "Kind", "Phase", "Actor", "Roles", "Scopes", "Reason", "Review"]}>
          {c.phaseChanges.map((p) => (
            <Tr key={p.id}>
              <Td className="text-muted">{fmtDate(p.createdAt)}</Td>
              <Td><PhaseChangeKindBadge kind={p.kind} /></Td>
              <Td className="text-xs">{p.fromPhase ? `${p.fromPhase.replaceAll("_", " ")} to ` : ""}{p.toPhase.replaceAll("_", " ")}</Td>
              <Td className="text-xs">{p.userName ?? p.actorId} <span className="text-faint">({p.actorType})</span></Td>
              <Td className="text-xs text-muted">{p.roles.join(", ")}</Td>
              <Td className="text-xs font-mono">{p.scopes.join(", ")}</Td>
              <Td className="max-w-md text-xs">{p.reason}</Td>
              <Td><ReviewOutcomeBadge outcome={p.reviewOutcome} /></Td>
            </Tr>
          ))}
        </Table>
      </div>
    </div>
  );
}
