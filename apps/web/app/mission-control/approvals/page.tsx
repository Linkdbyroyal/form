import Link from "next/link";
import { Badge, Card, Empty, Status, inputClass } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { Notice, PageHeader, ShortId, StateBadge, Table, Td, Tr, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { firstParam, fmtDate } from "@/lib/format";
import { decideApprovalAction } from "@/lib/mission-control/actions";
import { listApprovals, operatorMayDecide } from "@/lib/mission-control/queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOperatorContext();
  const sp = await searchParams;
  const { pending, decided } = await listApprovals();
  const returnTo = "/mission-control/approvals";
  return (
    <div className="space-y-6">
      <PageHeader title="Approvals">
        Pending approvals across tenants. Operators decide only approvals addressed to an agency role; approvals for client roles are decided in the client workspace (ADR-018: decisions happen inside the authenticated platform, never from a notification). <Status state="implemented" />
      </PageHeader>
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />

      <Card title={`Pending (${pending.length})`} footer="The database trigger blocks a second decision and self-approval. Approving re-queues the suspended run; rejecting ends it as cancelled (M1-07). Summary and rationale are written by the requesting agent and must not contain client specifics.">
        <Table head={["Approval", "Tenant", "Summary", "Risk", "Approver role", "Requested by", "Run", "Created", "Expires", "Decision"]} empty={pending.length === 0 ? <Empty>No pending approvals. A Discovery run requests one before publishing questions to client staff.</Empty> : null}>
          {pending.map((a) => (
            <Tr key={a.id}>
              <Td><ShortId id={a.id} /></Td>
              <Td><Link href={`/mission-control/clients/${a.tenantSlug}`} className="underline">{a.tenantName}</Link></Td>
              <Td className="max-w-sm">{a.summary}{a.blocking ? <Badge tone="warning">blocking</Badge> : null}</Td>
              <Td><StateBadge kind="risk" value={a.risk} /></Td>
              <Td className="text-muted">{a.approverRole}</Td>
              <Td className="text-xs text-muted">{a.requestedByActorType}:{a.requestedByActorId.length > 24 ? `${a.requestedByActorId.slice(0, 24)}…` : a.requestedByActorId}</Td>
              <Td>{a.runId ? <Link href={`/mission-control/runs/${a.runId}`} className="underline"><ShortId id={a.runId} /></Link> : <span className="text-faint">n/a</span>}</Td>
              <Td className="text-muted">{fmtDate(a.createdAt)}</Td>
              <Td className="text-muted">{fmtDate(a.expiresAt)}</Td>
              <Td>
                {operatorMayDecide(a.approverRole) ? (
                  <div className="space-y-1">
                    <form action={decideApprovalAction} className="flex items-center gap-1">
                      <input type="hidden" name="tenantId" value={a.tenantId} /><input type="hidden" name="approvalId" value={a.id} /><input type="hidden" name="returnTo" value={returnTo} />
                      <input name="note" placeholder="note (optional)" maxLength={1000} className={`${inputClass} w-40 py-1 text-xs`} />
                      <button type="submit" name="decision" value="approved" className={smallPrimaryClass}>Approve</button>
                      <ConfirmButton name="decision" value="rejected" message="Reject this approval? The suspended run will be cancelled." className={smallDangerClass}>Reject</ConfirmButton>
                    </form>
                  </div>
                ) : (
                  <div className="text-xs text-muted">
                    Client decision: <Link href={`/c/${a.tenantSlug}/approvals/${a.id}`} className="underline">open in client workspace</Link>
                  </div>
                )}
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <Card title="Decided (last 20)" footer="decided_by is the actor id of the deciding user; the decision note is free text written by that user.">
        <Table head={["Approval", "Tenant", "Summary", "Risk", "Approver role", "State", "Decided by", "Decided at", "Note"]} empty={decided.length === 0 ? <Empty>No decided approvals yet.</Empty> : null}>
          {decided.map((a) => (
            <Tr key={a.id}>
              <Td><ShortId id={a.id} /></Td>
              <Td><Link href={`/mission-control/clients/${a.tenantSlug}`} className="underline">{a.tenantName}</Link></Td>
              <Td className="max-w-sm">{a.summary}</Td>
              <Td><StateBadge kind="risk" value={a.risk} /></Td>
              <Td className="text-muted">{a.approverRole}</Td>
              <Td><StateBadge kind="approval" value={a.state} /></Td>
              <Td className="text-xs text-muted">{a.decidedByActorId ? (a.decidedByActorId.length > 12 ? `${a.decidedByActorId.slice(0, 8)}…` : a.decidedByActorId) : "system"}</Td>
              <Td className="text-muted">{fmtDate(a.decidedAt)}</Td>
              <Td className="text-xs text-muted">{a.decisionNote ?? ""}</Td>
            </Tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
