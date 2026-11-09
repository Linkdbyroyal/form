import Link from "next/link";
import { AGENCY_VAULT_FOLDERS } from "@sbos/core";
import { Badge, Card, Empty, Status, inputClass } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { Notice, PageHeader, ShortId, StateBadge, Table, Td, Tr, selectClass, smallButtonClass, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { AGENCY_VAULT_BASE, AgencyVaultNav, AgencyVaultStatusCard, ConsentBadge, PromotionStateBadge, RiskBadge } from "@/components/agency-vault-ui";
import { firstParam, fmtDate } from "@/lib/format";
import { publishPromotionAction, reviewPromotionAction } from "@/lib/mission-control/agency-vault-actions";
import { CONSENT_STATUSES, RECORD_KINDS, agencyFolderLabel, canReviewKnowledge, recordHref, shortActor, sourceRefCounts } from "@/lib/mission-control/agency-vault-helpers";
import { listPromotionRequests, type PromotionRow } from "@/lib/mission-control/agency-vault-queries";
import { requireAgencyContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

const RETURN_TO = `${AGENCY_VAULT_BASE}/reviews`;

export default async function PendingReviewsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAgencyContext();
  const sp = await searchParams;
  const reviewer = canReviewKnowledge(ctx.roles);
  const rows = reviewer ? await listPromotionRequests(ctx) : [];
  const open = rows.filter((r) => r.request.state === "nominated" || r.request.state === "in_review");
  const approved = rows.filter((r) => r.request.state === "approved");
  const closed = rows.filter((r) => ["published", "rejected", "withdrawn"].includes(r.request.state));

  return (
    <div className="space-y-6">
      <PageHeader title="Pending Knowledge Reviews" crumbs={[{ href: AGENCY_VAULT_BASE, label: "Agency Intelligence Vault" }, { label: "Pending Knowledge Reviews" }]}>
        Potential Reusable Insights nominated from a client scenario (by an agent or a client user). A human reviewer checks rights, security and identifiability and records the consent status; approval never publishes anything by itself. Publication is a second, explicit step that creates a self-contained agency record without tenant identifiers or source references. <Status state="implemented" />
      </PageHeader>
      <AgencyVaultNav active="reviews" pendingReviews={open.length} />
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />

      {!reviewer ? (
        <Card title="Visibility">
          <Empty>Promotion requests are visible to agency_reviewer and superadmin only (Row-Level Security on knowledge_promotion_requests). Your roles: {ctx.roles.join(", ")}.</Empty>
        </Card>
      ) : (
        <>
          <Card title={`Open requests (${open.length})`} footer="The trigger enforce_promotion_transition refuses approval without a review that passes all three checks and without consent_status granted or not_required. needs_changes returns the request to nominated; agents can never move a request.">
            {open.length === 0 ? <Empty>No nominated or in-review requests. Agents nominate from their runs (worker flows); nothing arrives here automatically from client vaults.</Empty> : <div className="space-y-4">{open.map((r) => <RequestCard key={r.request.id} row={r} mode="review" />)}</div>}
          </Card>

          <Card title={`Approved, awaiting publication (${approved.length})`} footer="Publication is never automatic. The reviewer chooses the target path (default folder 15_approved_reusable_insights), the kind and optionally edits the generic text. The record is created, moved to published in one transaction and carries the request id as rights metadata only.">
            {approved.length === 0 ? <Empty>No approved requests waiting.</Empty> : <div className="space-y-4">{approved.map((r) => <RequestCard key={r.request.id} row={r} mode="publish" />)}</div>}
          </Card>

          <Card title={`Closed (${closed.length})`} footer="Published requests link to the agency record; rejected and withdrawn requests stay for the audit trail.">
            <Table head={["Request", "Title", "Source tenant", "State", "Reviews", "Decided by", "Decided", "Record"]} empty={closed.length === 0 ? <Empty>No closed requests.</Empty> : null}>
              {closed.map((r) => (
                <Tr key={r.request.id}>
                  <Td><ShortId id={r.request.id} /></Td>
                  <Td className="max-w-sm">{r.request.title}</Td>
                  <Td>{r.tenantName} <span className="font-mono text-[11px] text-faint">{r.tenantSlug}</span></Td>
                  <Td><PromotionStateBadge value={r.request.state} /></Td>
                  <Td className="text-xs">{r.reviews.length}</Td>
                  <Td className="font-mono text-[11px] text-muted">{r.request.reviewerActorId ? shortActor(r.request.reviewerActorId) : ""}</Td>
                  <Td className="text-muted">{fmtDate(r.request.decidedAt)}</Td>
                  <Td className="text-xs">{r.request.publishedRecordId ? <Link href={recordHref(r.request.publishedRecordId)} className="underline">{r.publishedPath ?? r.request.publishedRecordId.slice(0, 8)}</Link> : ""}</Td>
                </Tr>
              ))}
            </Table>
          </Card>
        </>
      )}

      <AgencyVaultStatusCard extra={[{ label: "Nominations from client workspaces by client admins (UI)", state: "planned", note: "nominateReusableInsight exists; agents and tests use it" }]} />
    </div>
  );
}

function RequestCard({ row, mode }: { row: PromotionRow; mode: "review" | "publish" }) {
  const { request: r, reviews } = row;
  const refs = sourceRefCounts(r.sourceRefs);
  const defaultFile = r.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "insight";
  return (
    <section className="rounded-card border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="font-medium">{r.title} <span className="font-mono text-xs text-faint">{r.id.slice(0, 8)}</span></h4>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <PromotionStateBadge value={r.state} />
            <StateBadge kind="classification" value={r.classification} />
            <Badge>confidentiality: {r.confidentiality}</Badge>
            <span className="flex items-center gap-1">identifiability risk <RiskBadge value={r.identifiabilityRisk} /></span>
            <span className="flex items-center gap-1">consent <ConsentBadge value={r.consentStatus} /></span>
          </div>
        </div>
        <div className="text-right text-xs text-muted">
          <div>Source tenant: <span className="font-medium text-fg">{row.tenantName}</span> <span className="font-mono text-faint">{row.tenantSlug}</span></div>
          <div>Nominated {fmtDate(r.createdAt)} by {r.nominatedByActorType}:{shortActor(r.nominatedByActorId)}</div>
          <div>Owner role {r.ownerRole} · reviewer role {r.reviewerRole}{r.runId ? <> · run <Link href={`/mission-control/runs/${r.runId}`} className="underline">{r.runId.slice(0, 8)}</Link></> : null}</div>
        </div>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-faint">Proposed generic statement</div>
          <p className="mt-1 whitespace-pre-wrap text-sm">{r.proposedGenericStatement}</p>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-faint">Rationale</div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{r.rationale}</p>
          <div className="mt-2 text-xs text-faint">Rights basis: {r.rightsBasis ?? "not recorded yet"}</div>
          <div className="mt-1 text-xs text-faint">
            Source references (counts only, identifiers stay in the tenant): {refs.length === 0 ? "none" : refs.map((x) => `${x.key}: ${x.count}`).join(", ")}
          </div>
        </div>
      </div>
      <div className="mt-3">
        <div className="text-xs uppercase tracking-wide text-faint">Reviews so far ({reviews.length})</div>
        {reviews.length === 0 ? (
          <p className="text-xs text-muted">None yet.</p>
        ) : (
          <ul className="mt-1 space-y-1 text-xs">
            {reviews.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2">
                <span className="text-muted">{fmtDate(v.createdAt)}</span>
                <Badge tone={v.decision === "approve" ? "success" : v.decision === "reject" ? "danger" : "warning"}>{v.decision.replaceAll("_", " ")}</Badge>
                <span className="font-mono text-muted">{v.reviewerActorType}:{shortActor(v.reviewerActorId)}</span>
                <span className="text-faint">rights {v.rightsCheck ? "ok" : "no"} · security {v.securityCheck ? "ok" : "no"} · identifiability {v.identifiabilityCheck ? "ok" : "no"}</span>
                <span className="text-muted">{v.note}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {mode === "review" ? (
        <form action={reviewPromotionAction} className="mt-4 space-y-2 border-t border-border pt-3">
          <input type="hidden" name="requestId" value={r.id} />
          <input type="hidden" name="returnTo" value={RETURN_TO} />
          <div className="flex flex-wrap gap-4 text-xs">
            <label className="flex items-center gap-1"><input type="checkbox" name="rightsCheck" /> Rights checked (contract or consent allows abstracted reuse)</label>
            <label className="flex items-center gap-1"><input type="checkbox" name="securityCheck" /> Security checked (no credentials, systems detail or confidential figures)</label>
            <label className="flex items-center gap-1"><input type="checkbox" name="identifiabilityCheck" /> Identifiability checked (no client can be recognised)</label>
          </div>
          <div className="grid gap-2 md:grid-cols-[180px_1fr_1fr]">
            <label className="block text-xs text-muted">Consent status
              <select name="consentStatus" defaultValue={r.consentStatus} className={`${selectClass} mt-1 w-full`}>
                {CONSENT_STATUSES.map((c) => <option key={c} value={c}>{c.replaceAll("_", " ")}</option>)}
              </select>
            </label>
            <label className="block text-xs text-muted">Rights basis<input name="rightsBasis" maxLength={500} defaultValue={r.rightsBasis ?? ""} className={`${inputClass} mt-1`} placeholder="e.g. consultancy agreement clause 7" /></label>
            <label className="block text-xs text-muted">Review note (required)<input name="note" required maxLength={2000} className={`${inputClass} mt-1`} placeholder="what you checked and why" /></label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" name="decision" value="approve" className={smallPrimaryClass}>Approve</button>
            <button type="submit" name="decision" value="needs_changes" className={smallButtonClass}>Needs changes</button>
            <ConfirmButton name="decision" value="reject" message="Reject this nomination? The request stays for the audit trail." className={smallDangerClass}>Reject</ConfirmButton>
            <span className="text-xs text-faint">Approving does not publish. The database refuses approval unless all three checks are ticked and consent is granted or not required.</span>
          </div>
        </form>
      ) : (
        <form action={publishPromotionAction} className="mt-4 space-y-2 border-t border-border pt-3">
          <input type="hidden" name="requestId" value={r.id} />
          <input type="hidden" name="returnTo" value={RETURN_TO} />
          <div className="grid gap-2 md:grid-cols-[1fr_1fr_180px]">
            <label className="block text-xs text-muted">Target folder
              <select name="folder" defaultValue="15_approved_reusable_insights" className={`${selectClass} mt-1 w-full`}>
                {AGENCY_VAULT_FOLDERS.map((f) => <option key={f} value={f}>{f.slice(0, 2)} {agencyFolderLabel(f)}</option>)}
              </select>
            </label>
            <label className="block text-xs text-muted">File name<input name="fileName" required maxLength={200} defaultValue={`${defaultFile}.md`} className={`${inputClass} mt-1`} /></label>
            <label className="block text-xs text-muted">Kind
              <select name="kind" defaultValue="reusable_insight" className={`${selectClass} mt-1 w-full`}>
                {RECORD_KINDS.map((k) => <option key={k} value={k}>{k.replaceAll("_", " ")}</option>)}
              </select>
            </label>
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            <label className="block text-xs text-muted">Title (optional, defaults to the request title)<input name="title" maxLength={200} className={`${inputClass} mt-1`} /></label>
            <label className="block text-xs text-muted">License<input name="license" maxLength={200} className={`${inputClass} mt-1`} placeholder="Second Brain internal" /></label>
            <label className="block text-xs text-muted">Related skill keys<input name="relatedSkillKeys" maxLength={1000} className={`${inputClass} mt-1`} placeholder="process-redesign" /></label>
          </div>
          <label className="block text-xs text-muted">Edited generic body (optional Markdown; empty publishes the statement and rationale as approved)
            <textarea name="body" rows={6} className={`${inputClass} mt-1 font-mono`} placeholder={`# ${r.title}\n\n${r.proposedGenericStatement}`} />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <ConfirmButton message="Publish this insight as an agency record? It becomes visible to every agency role; the source tenant is never named in the record." className={smallPrimaryClass}>Publish to agency vault</ConfirmButton>
            <span className="text-xs text-faint">Allowed uses default to internal_method. Reviewer or superadmin only.</span>
          </div>
        </form>
      )}
    </section>
  );
}
