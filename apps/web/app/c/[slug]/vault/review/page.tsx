import Link from "next/link";
import { notFound } from "next/navigation";
import { clientNav, Shell } from "@/components/shell";
import { Badge, Card, Empty, Stat, Status, inputClass } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { Notice, PageHeader, ShortId, Table, Td, Tr, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { ProposalStateBadge, RequestStateBadge, VaultNav, VerificationBadge } from "@/components/vault-ui";
import { getTenantHeader } from "@/lib/client/queries";
import { getReviewQueue } from "@/lib/client/vault-queries";
import { decideProposalAction, decideVerificationRequestAction } from "@/lib/client/vault-actions";
import { canDecideProposals, canManageVaultSettings, canReviewFacts } from "@/lib/client/vault-helpers";
import { firstParam, fmtDate } from "@/lib/format";
import { requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

function docHref(slug: string, path: string): string {
  return `/c/${slug}/vault/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export default async function VaultReviewPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await requireTenantContext(slug);
  if (!access) notFound();
  const [tenant, queue] = await Promise.all([getTenantHeader(access.ctx), getReviewQueue(access.ctx)]);
  if (!tenant) notFound();
  const roles = access.ctx.roles;
  const mayReview = canReviewFacts(roles) && !access.viaGrant;
  const mayDecideProposals = canDecideProposals(roles) && !access.viaGrant;
  const returnTo = `/c/${slug}/vault/review`;
  return (
    <Shell title={tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
      <div className="space-y-6">
        <PageHeader title="Review queue">
          Contradictions an agent found between facts, waiting for a reviewer, and document changes agents proposed under the <em>proposal_required</em> write mode. Promoting a fact to verified is allowed by the database only for the client admin (and agency reviewers); the trigger's refusal is shown here if a role tries anyway. <Status state="implemented" />
        </PageHeader>
        <VaultNav slug={slug} active="review" showSettings={canManageVaultSettings(roles)} />
        <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
        <div className="grid gap-4 md:grid-cols-3">
          <Stat label="Open verification requests" value={queue.openRequests.length} hint="decide: verified or rejected" />
          <Stat label="Pending proposals" value={queue.pendingProposals.length} hint="approve writes a new document revision" />
          <Stat label="Your roles" value={roles.length} hint={roles.join(", ") || "none"} />
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge tone="cyan">your roles: {roles.join(", ") || "none"}</Badge>
          {access.viaGrant ? <Badge tone="danger">break-glass grant: read-only, access is logged</Badge> : null}
          {!mayReview ? <Badge tone="warning">fact decisions require client_admin</Badge> : null}
        </div>

        <Card title={`Fact verification requests (${queue.openRequests.length} open)`} footer="Verified: the fact gets verification verified and confidence 0.90. Rejected: the fact becomes deprecated and leaves search and agent context. Both write a fact revision and an audit event.">
          {queue.openRequests.length === 0 ? (
            <Empty>No open verification requests. An agent raises one when an answer contradicts another fact (for example the systems register).</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {queue.openRequests.map((r) => (
                <li key={r.id} className="py-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <RequestStateBadge value={r.state} />
                    <span className="text-muted">raised by {r.raisedByActorType}: <span className="font-mono">{r.raisedByActorId}</span></span>
                    <span className="text-faint">{fmtDate(r.createdAt)}</span>
                    <span className="text-faint">needs {r.requestedReviewerRole}</span>
                    <Badge>{r.evidenceCount} evidence item{r.evidenceCount === 1 ? "" : "s"}</Badge>
                    <ShortId id={r.id} />
                  </div>
                  <div className="mt-2 rounded-md border border-border bg-surface-2 p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-faint">Fact under review <VerificationBadge value={r.factVerification} />{r.factConfidence !== null ? <span>confidence {r.factConfidence.toFixed(2)}</span> : null}</div>
                    <p className="mt-1">{r.factStatement ?? <span className="text-faint">fact not visible to your role</span>}</p>
                  </div>
                  <p className="mt-2 text-sm"><span className="text-faint">Reason: </span>{r.reason}</p>
                  {r.conflicting.length > 0 ? (
                    <div className="mt-2 text-sm">
                      <div className="text-xs text-faint">Contradicting fact{r.conflicting.length === 1 ? "" : "s"}</div>
                      <ul className="mt-1 space-y-1">
                        {r.conflicting.map((c) => (
                          <li key={c.id} className="flex items-start gap-2"><VerificationBadge value={c.verification} /><span>{c.statement}</span></li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div className="mt-3">
                    {mayReview ? (
                      <form action={decideVerificationRequestAction} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="slug" value={slug} /><input type="hidden" name="requestId" value={r.id} /><input type="hidden" name="returnTo" value={returnTo} />
                        <input name="note" placeholder="decision note (optional)" maxLength={1000} className={`${inputClass} max-w-sm py-1 text-xs`} />
                        <button type="submit" name="decision" value="verified" className={smallPrimaryClass}>Approve (Verified)</button>
                        <ConfirmButton name="decision" value="rejected" message="Reject? The fact under review becomes deprecated." className={smallDangerClass}>Reject</ConfirmButton>
                      </form>
                    ) : (
                      <span className="text-xs text-muted">{access.viaGrant ? "Break-glass access is read-only." : `Deciding requires the ${r.requestedReviewerRole} role.`}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={`Change proposals (${queue.pendingProposals.length} pending)`} footer="Approving writes the proposed content as a new revision of the document (or creates it) and re-indexes links. Rejecting leaves the document unchanged. client_admin and department_manager may decide.">
          {queue.pendingProposals.length === 0 ? (
            <Empty>No pending proposals. Agents create one when the folder's write mode is proposal_required (see <Link href={`/c/${slug}/vault/settings`} className="underline">Settings</Link>).</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {queue.pendingProposals.map((p) => (
                <li key={p.id} className="py-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <ProposalStateBadge value={p.state} />
                    <span className="text-muted">proposed by {p.proposedByActorType}: <span className="font-mono">{p.proposedByActorId}</span></span>
                    <span className="text-faint">{fmtDate(p.createdAt)}</span>
                    {p.documentId ? <Badge tone="cyan">updates existing document</Badge> : <Badge tone="indigo">new document</Badge>}
                    <ShortId id={p.id} />
                  </div>
                  <p className="mt-2 text-sm font-medium">{p.title}</p>
                  <div className="font-mono text-xs text-muted">{p.path}{p.documentId ? <> · <Link href={docHref(slug, p.path)} className="underline">current version</Link></> : null}</div>
                  {p.changeNote ? <p className="mt-1 text-xs text-muted">Note: {p.changeNote}</p> : null}
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-3 font-mono text-xs text-muted">{p.bodyPreview}{p.bodyLength > p.bodyPreview.length ? `\n... (${p.bodyLength - p.bodyPreview.length} more characters)` : ""}</pre>
                  <div className="mt-3">
                    {mayDecideProposals ? (
                      <form action={decideProposalAction} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="slug" value={slug} /><input type="hidden" name="proposalId" value={p.id} /><input type="hidden" name="returnTo" value={returnTo} />
                        <input name="note" placeholder="decision note (optional)" maxLength={1000} className={`${inputClass} max-w-sm py-1 text-xs`} />
                        <button type="submit" name="decision" value="approved" className={smallPrimaryClass}>Approve</button>
                        <ConfirmButton name="decision" value="rejected" message="Reject this proposal? The document stays as it is." className={smallDangerClass}>Reject</ConfirmButton>
                      </form>
                    ) : (
                      <span className="text-xs text-muted">{access.viaGrant ? "Break-glass access is read-only." : "Deciding requires client_admin or department_manager."}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Decided requests (last 20)">
            <Table head={["State", "Fact", "Decided by", "At", "Note"]} empty={queue.decidedRequests.length === 0 ? <Empty>No decisions yet.</Empty> : null}>
              {queue.decidedRequests.map((r) => (
                <Tr key={r.id}>
                  <Td><RequestStateBadge value={r.state} /></Td>
                  <Td className="max-w-xs text-xs">{r.factStatement ?? <span className="text-faint">not visible</span>}</Td>
                  <Td className="text-xs text-muted">{r.resolvedByActorId ? <ShortId id={r.resolvedByActorId} /> : "n/a"}</Td>
                  <Td className="text-xs text-muted">{fmtDate(r.resolvedAt)}</Td>
                  <Td className="text-xs text-muted">{r.resolutionNote ?? ""}</Td>
                </Tr>
              ))}
            </Table>
          </Card>
          <Card title="Decided proposals (last 20)">
            <Table head={["State", "Path", "Decided by", "At", "Note"]} empty={queue.decidedProposals.length === 0 ? <Empty>No decisions yet.</Empty> : null}>
              {queue.decidedProposals.map((p) => (
                <Tr key={p.id}>
                  <Td><ProposalStateBadge value={p.state} /></Td>
                  <Td className="font-mono text-xs"><Link href={docHref(slug, p.path)} className="underline">{p.path}</Link></Td>
                  <Td className="text-xs text-muted">{p.decidedByActorId ? <ShortId id={p.decidedByActorId} /> : "n/a"}</Td>
                  <Td className="text-xs text-muted">{fmtDate(p.decidedAt)}</Td>
                  <Td className="text-xs text-muted">{p.decisionNote ?? ""}</Td>
                </Tr>
              ))}
            </Table>
          </Card>
        </div>

        <Card title="Implementation status">
          <ul className="space-y-1 text-sm">
            <li><Status state="implemented" /> Verification requests with fact, contradicting facts, reason, raiser and evidence count; verified/rejected decisions through decideFactVerification; trigger-enforced reviewer role (M2-05)</li>
            <li><Status state="implemented" /> Change proposals with preview; approve/reject through decideProposal (M2-10)</li>
            <li><Status state="planned" /> Side-by-side diff of a proposal against the current document; agency reviewer grants (M4)</li>
          </ul>
        </Card>
      </div>
    </Shell>
  );
}
