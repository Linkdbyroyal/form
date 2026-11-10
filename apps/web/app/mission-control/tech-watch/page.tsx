import Link from "next/link";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Card, Empty, Stat, Status, inputClass } from "@/components/ui";
import { Notice, PageHeader, ShortId, Table, Td, Tr, selectClass, smallButtonClass, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { GovernanceStatusCard, SecurityRiskBadge, TechWatchNav, TechWatchSandboxNote, UpgradeKindBadge, UpgradeStatusBadge, WatchModeBadge, WatchRunBadge } from "@/components/governance-ui";
import { firstParam, fmtDate } from "@/lib/format";
import { shortActor } from "@/lib/mission-control/agency-vault-helpers";
import { registerSourceAction, setSourceApprovalAction } from "@/lib/mission-control/governance-actions";
import { CHECK_INTERVAL_MAX, CHECK_INTERVAL_MIN, isReviewer, TECH_FETCH_KINDS, TECH_SOURCE_KINDS, TECH_WATCH_BASE, UPGRADE_STATUSES, updateHref, WORKER_WATCH_SCHEDULE } from "@/lib/mission-control/governance-helpers";
import { listRecentWatchRuns, listTechSources, listUpdates } from "@/lib/mission-control/governance-queries";
import { requireAgencyContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

function updatesHref(status: string | null): string {
  return status ? `${TECH_WATCH_BASE}?view=updates&status=${status}` : `${TECH_WATCH_BASE}?view=updates`;
}

export default async function TechWatchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAgencyContext();
  const sp = await searchParams;
  const view = firstParam(sp.view) === "updates" ? "updates" : "sources";
  const status = firstParam(sp.status);
  const reviewer = isReviewer(ctx.roles);
  const [sources, runs, updates] = await Promise.all([listTechSources(ctx), listRecentWatchRuns(ctx, 15), listUpdates(ctx, { status: view === "updates" ? status : null })]);
  const approved = sources.filter((s) => s.source.approved);
  const detected = updates.counts.get("detected") ?? 0;
  const failedRuns = runs.filter((r) => r.status === "failed").length;
  const returnTo = view === "updates" ? updatesHref(status) : TECH_WATCH_BASE;

  return (
    <div className="space-y-6">
      <PageHeader title="Tech Watch" crumbs={[{ href: "/mission-control", label: "Mission Control" }, { label: "Tech Watch" }]}>
        Technology Intelligence Center (spec 4D): approved sources the worker checks {WORKER_WATCH_SCHEDULE}, and every detected update with its UpgradeProposal fields. Detection only records; assessing, approving and applying happen in the Upgrade Center per update. Your agency roles: {ctx.roles.map((r) => <Badge key={r} tone="indigo">{r}</Badge>)} <Status state="implemented" />
      </PageHeader>
      <TechWatchNav active={view} detected={detected} />
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
      <TechWatchSandboxNote />

      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Approved sources" value={approved.length} hint={`${sources.length - approved.length} registered, not approved`} />
        <Stat label="Detected, not assessed" value={detected} hint="waiting for an assessment" />
        <Stat label="Approved, not applied" value={updates.counts.get("approved") ?? 0} hint="need a test result" />
        <Stat label="Failed watch runs" value={failedRuns} hint={`of the last ${runs.length} runs`} />
      </div>

      {view === "sources" ? (
        <>
          <Card title={`Sources (${sources.length})`} footer="Only an approved source is ever fetched (reviewer decision, recorded with actor and time). The url is shown as text, never followed from this page. Manual sources are read by people; the worker skips them.">
            <Table head={["Source", "Kind", "Fetch", "URL", "Approval", "Interval", "Last checked", "Last error", "Latest run", "Updates", ""]} empty={sources.length === 0 ? <Empty>No sources registered yet. Register one below; a reviewer approves it.</Empty> : null}>
              {sources.map(({ source: s, latestRun, updates: n }) => (
                <Tr key={s.id}>
                  <Td className="font-medium">{s.name}<div className="font-mono text-[11px] text-faint">{s.key}</div>{s.relevantAgentKeys.length > 0 ? <div className="text-[11px] text-muted">agents: {s.relevantAgentKeys.join(", ")}</div> : null}</Td>
                  <Td className="text-xs text-muted">{s.kind.replaceAll("_", " ")}</Td>
                  <Td><Badge tone={s.fetchKind === "manual" ? "neutral" : "cyan"}>{s.fetchKind.replaceAll("_", " ")}</Badge></Td>
                  <Td className="max-w-xs break-all font-mono text-[11px] text-muted">{s.url}</Td>
                  <Td>{s.approved ? <><Badge tone="success">approved</Badge><div className="text-[11px] text-faint">by {shortActor(s.approvedBy ?? "unknown")} at {fmtDate(s.approvedAt)}</div></> : <Badge tone="warning">not approved</Badge>}</Td>
                  <Td className="text-xs">{s.checkIntervalHours} h</Td>
                  <Td className="text-xs text-muted">{s.lastCheckedAt ? fmtDate(s.lastCheckedAt) : "never"}</Td>
                  <Td className="max-w-xs text-xs text-danger">{s.lastError ?? <span className="text-faint">none</span>}</Td>
                  <Td className="text-xs">{latestRun ? <div className="space-y-0.5"><div><WatchModeBadge mode={latestRun.mode} /> <WatchRunBadge status={latestRun.status} /></div><div className="text-faint">{latestRun.itemsSeen} items, {latestRun.updatesNew} new, {fmtDate(latestRun.startedAt)}</div></div> : <span className="text-faint">no run yet</span>}</Td>
                  <Td className="text-xs">{n}</Td>
                  <Td>
                    {reviewer ? (
                      <form action={setSourceApprovalAction} className="flex flex-col gap-1">
                        <input type="hidden" name="sourceId" value={s.id} />
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <input type="hidden" name="approved" value={s.approved ? "false" : "true"} />
                        <input name="note" required maxLength={1000} placeholder="Reason" className={`${inputClass} w-40`} />
                        {s.approved ? <ConfirmButton className={smallDangerClass} message={`Unapprove ${s.name}? The worker stops fetching it.`}>Unapprove</ConfirmButton> : <ConfirmButton className={smallPrimaryClass} message={`Approve ${s.name}? The worker fetches it on its interval.`}>Approve</ConfirmButton>}
                      </form>
                    ) : <span className="text-[11px] text-faint">approval: reviewer or superadmin</span>}
                  </Td>
                </Tr>
              ))}
            </Table>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Register source" footer="Any agency role may register a source (agents may only propose one in a note). It starts unapproved. Key: lowercase letters, digits, dashes. The url must be https. For github_releases the url is the repository's releases page; the worker calls the GitHub API for it.">
              <form action={registerSourceAction} className="space-y-2">
                <input type="hidden" name="returnTo" value={returnTo} />
                <div className="grid gap-2 md:grid-cols-2">
                  <label className="block text-xs text-faint">Key<input name="key" required pattern="[a-z0-9][a-z0-9-]{1,63}" title="lowercase letters, digits and dashes" maxLength={64} className={inputClass} placeholder="tailwind-releases" /></label>
                  <label className="block text-xs text-faint">Name<input name="name" required maxLength={200} className={inputClass} placeholder="Tailwind CSS releases" /></label>
                  <label className="block text-xs text-faint">Kind<select name="kind" className={`${selectClass} block w-full`} defaultValue="github_releases">{TECH_SOURCE_KINDS.map((k) => <option key={k} value={k}>{k.replaceAll("_", " ")}</option>)}</select></label>
                  <label className="block text-xs text-faint">Fetch kind<select name="fetchKind" className={`${selectClass} block w-full`} defaultValue="github_releases">{TECH_FETCH_KINDS.map((k) => <option key={k} value={k}>{k.replaceAll("_", " ")}</option>)}</select></label>
                </div>
                <label className="block text-xs text-faint">URL (https)<input name="url" required type="url" pattern="https://.*" maxLength={1000} className={inputClass} placeholder="https://github.com/tailwindlabs/tailwindcss/releases" /></label>
                <div className="grid gap-2 md:grid-cols-2">
                  <label className="block text-xs text-faint">Relevant agent keys (comma separated)<input name="relevantAgentKeys" maxLength={1000} className={inputClass} placeholder="worker, process-redesign" /></label>
                  <label className="block text-xs text-faint">Check interval (hours, {CHECK_INTERVAL_MIN} to {CHECK_INTERVAL_MAX})<input name="checkIntervalHours" type="number" min={CHECK_INTERVAL_MIN} max={CHECK_INTERVAL_MAX} defaultValue={24} className={inputClass} /></label>
                </div>
                <button type="submit" className={smallPrimaryClass}>Register source (unapproved)</button>
              </form>
            </Card>

            <Card title={`Latest watch runs (${runs.length})`} footer="One row per source per worker run. Mode fixture means the sandbox recorded fixture items; a live run that fails records the masked error on the run and on the source.">
              <Table head={["Started", "Source", "Mode", "Status", "Items", "New", "Error"]} empty={runs.length === 0 ? <Empty>No watch runs yet. The worker runs tech.watch {WORKER_WATCH_SCHEDULE}.</Empty> : null}>
                {runs.map((r) => (
                  <Tr key={r.id}>
                    <Td className="text-xs text-muted">{fmtDate(r.startedAt)}</Td>
                    <Td className="text-xs">{r.sourceName}</Td>
                    <Td><WatchModeBadge mode={r.mode} /></Td>
                    <Td><WatchRunBadge status={r.status} /></Td>
                    <Td className="text-xs">{r.itemsSeen}</Td>
                    <Td className="text-xs">{r.updatesNew}</Td>
                    <Td className="max-w-xs text-xs text-danger">{r.errorMessage ?? ""}</Td>
                  </Tr>
                ))}
              </Table>
            </Card>
          </div>
        </>
      ) : (
        <Card title={`Detected updates (${updates.rows.length} shown of ${updates.total})`} footer="Every item a watch run found, once per source and external id. Open an update for its UpgradeProposal fields, the assessment and decision forms and the transition timeline. The status filter mirrors the lifecycle enforced by the trigger enforce_upgrade_transition.">
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            <Link href={updatesHref(null)} className={`rounded-full border px-3 py-1 ${!status ? "border-cyan/60 text-cyan" : "border-border text-muted hover:text-fg"}`}>any status ({updates.total})</Link>
            {UPGRADE_STATUSES.map((s) => (
              <Link key={s} href={updatesHref(s)} className={`rounded-full border px-3 py-1 ${status === s ? "border-cyan/60 text-cyan" : "border-border text-muted hover:text-fg"}`}>
                {s.replaceAll("_", " ")} <span className="text-faint">({updates.counts.get(s) ?? 0})</span>
              </Link>
            ))}
          </div>
          <Table head={["Subject", "Version", "Source", "Published", "Detected", "Kind", "Risk", "Status", "Reviewer", ""]} empty={updates.rows.length === 0 ? <Empty>No updates in this state.</Empty> : null}>
            {updates.rows.map(({ update: u, sourceName }) => (
              <Tr key={u.id}>
                <Td className="max-w-sm"><Link href={updateHref(u.id)} className="font-medium underline">{u.subject}</Link><div className="text-[11px] text-faint"><ShortId id={u.id} /> · {u.externalId}</div></Td>
                <Td className="font-mono text-xs">{u.currentVersion ? `${u.currentVersion} to ` : ""}{u.proposedVersion}</Td>
                <Td className="text-xs text-muted">{sourceName}</Td>
                <Td className="text-xs text-muted">{fmtDate(u.publishedAt)}</Td>
                <Td className="text-xs text-muted">{fmtDate(u.detectedAt)}</Td>
                <Td><UpgradeKindBadge value={u.kind} /></Td>
                <Td><SecurityRiskBadge value={u.securityRisk} /></Td>
                <Td><UpgradeStatusBadge value={u.status} /></Td>
                <Td className="text-xs text-muted">{u.reviewerActorId ? shortActor(u.reviewerActorId) : ""}</Td>
                <Td><Link href={updateHref(u.id)} className={smallButtonClass}>Open</Link></Td>
              </Tr>
            ))}
          </Table>
        </Card>
      )}

      <GovernanceStatusCard implemented={["Approved sources with approval actor and time, interval, last check, last error and latest watch run; register and approve or unapprove (reviewer, recorded in audit_events).", "Detected updates with counts per status, read in agency scope; the Upgrade Center per update records assessment, decision, application with test result and rollback.", `Worker job tech.watch (${WORKER_WATCH_SCHEDULE}): approved, due, non-manual sources only, HTTPS with timeout, fixture mode in the sandbox and CI.`]} />
    </div>
  );
}
