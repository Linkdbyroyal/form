import Link from "next/link";
import { notFound } from "next/navigation";
import { clientNav, Shell } from "@/components/shell";
import { Badge, Card, Empty, Status, inputClass } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { Notice, PageHeader, ShortId, StateBadge, Table, Td, Tr, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { decideClientApprovalAction } from "@/lib/client/actions";
import { getTenantHeader, listClientApprovals } from "@/lib/client/queries";
import { firstParam, fmtDate } from "@/lib/format";
import { requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function ClientApprovalsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await requireTenantContext(slug);
  if (!access) notFound();
  const [tenant, { pending, decided }] = await Promise.all([getTenantHeader(access.ctx), listClientApprovals(access.ctx)]);
  if (!tenant) notFound();
  const returnTo = `/c/${slug}/approvals`;
  const canDecide = (role: string) => !access.viaGrant && access.ctx.roles.includes(role);
  return (
    <Shell title={tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
      <div className="space-y-6">
        <PageHeader title="Approvals">
          Decisions your organisation owes to its agents. Approving lets the suspended run continue; rejecting cancels it. Decisions are taken only here, inside the signed-in platform, never from an e-mail link (ADR-018). <Status state="implemented" />
        </PageHeader>
        <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
        <div className="flex gap-2 text-xs">
          <Badge tone="cyan">your roles: {access.ctx.roles.join(", ") || "none"}</Badge>
          {access.viaGrant ? <Badge tone="danger">break-glass grant: read-only, access is logged</Badge> : null}
        </div>

        <Card title={`Pending (${pending.length})`} footer="The database refuses a second decision and refuses a requester deciding their own request; such refusals are shown above the table.">
          <Table head={["Approval", "Summary", "Risk", "Needs role", "Requested by", "Created", "Expires", "Decision"]} empty={pending.length === 0 ? <Empty>Nothing waiting for a decision.</Empty> : null}>
            {pending.map((a) => (
              <Tr key={a.id}>
                <Td><Link href={`/c/${slug}/approvals/${a.id}`} className="underline"><ShortId id={a.id} /></Link></Td>
                <Td className="max-w-md">
                  <div>{a.summary}</div>
                  <div className="text-xs text-muted">{a.rationale}</div>
                  <Link href={`/c/${slug}/approvals/${a.id}`} className="text-xs underline">view details</Link>
                </Td>
                <Td><StateBadge kind="risk" value={a.risk} /></Td>
                <Td className="text-muted">{a.approverRole}</Td>
                <Td className="text-xs text-muted">{a.requestedByActorType}: {a.requestedByActorId}</Td>
                <Td className="text-muted">{fmtDate(a.createdAt)}</Td>
                <Td className="text-muted">{fmtDate(a.expiresAt)}</Td>
                <Td>
                  {canDecide(a.approverRole) ? (
                    <form action={decideClientApprovalAction} className="flex items-center gap-1">
                      <input type="hidden" name="slug" value={slug} /><input type="hidden" name="approvalId" value={a.id} /><input type="hidden" name="returnTo" value={returnTo} />
                      <input name="note" placeholder="note (optional)" maxLength={1000} className={`${inputClass} w-36 py-1 text-xs`} />
                      <button type="submit" name="decision" value="approved" className={smallPrimaryClass}>Approve</button>
                      <ConfirmButton name="decision" value="rejected" message="Reject? The agent run will be cancelled and nothing is published." className={smallDangerClass}>Reject</ConfirmButton>
                    </form>
                  ) : (
                    <span className="text-xs text-muted">requires {a.approverRole}</span>
                  )}
                </Td>
              </Tr>
            ))}
          </Table>
        </Card>

        <Card title="Decided (last 20)">
          <Table head={["Approval", "Summary", "Risk", "State", "Decided by", "Decided at", "Note"]} empty={decided.length === 0 ? <Empty>No decisions yet.</Empty> : null}>
            {decided.map((a) => (
              <Tr key={a.id}>
                <Td><Link href={`/c/${slug}/approvals/${a.id}`} className="underline"><ShortId id={a.id} /></Link></Td>
                <Td className="max-w-md">{a.summary}</Td>
                <Td><StateBadge kind="risk" value={a.risk} /></Td>
                <Td><StateBadge kind="approval" value={a.state} /></Td>
                <Td className="text-xs text-muted">{a.decidedByActorId ? <ShortId id={a.decidedByActorId} /> : "system"}</Td>
                <Td className="text-muted">{fmtDate(a.decidedAt)}</Td>
                <Td className="text-xs text-muted">{a.decisionNote ?? ""}</Td>
              </Tr>
            ))}
          </Table>
        </Card>
      </div>
    </Shell>
  );
}
