import Link from "next/link";
import { notFound } from "next/navigation";
import { clientNav, Shell } from "@/components/shell";
import { Badge, Card, Empty, Status, inputClass } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { Notice, PageHeader, SimulatedBadge, StateBadge, Table, Td, Tr, TriggerBadge, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { decideClientApprovalAction } from "@/lib/client/actions";
import { getClientApproval, getTenantHeader } from "@/lib/client/queries";
import { firstParam, fmtDate } from "@/lib/format";
import { requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function ClientApprovalDetailPage({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug, id } = await params;
  const sp = await searchParams;
  const access = await requireTenantContext(slug);
  if (!access) notFound();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [tenant, d] = await Promise.all([getTenantHeader(access.ctx), getClientApproval(access.ctx, id)]);
  if (!tenant || !d) notFound();
  const { approval: a } = d;
  const returnTo = `/c/${slug}/approvals/${id}`;
  const canDecide = a.state === "pending" && !access.viaGrant && access.ctx.roles.includes(a.approverRole);
  const payload = d.action?.payload && typeof d.action.payload === "object" ? (d.action.payload as Record<string, unknown>) : null;
  return (
    <Shell title={tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
      <div className="space-y-6">
        <PageHeader title={`Approval ${id.slice(0, 8)}`} crumbs={[{ href: `/c/${slug}/approvals`, label: "Approvals" }, { label: id.slice(0, 8) }]}>
          What the agent asks permission for, why, and what it will do when approved. Content is visible because this page runs in your tenant context. <Status state="implemented" />
        </PageHeader>
        <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />

        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Request">
            <dl className="space-y-2 text-sm">
              <div><dt className="text-faint">Summary</dt><dd className="font-medium">{a.summary}</dd></div>
              <div><dt className="text-faint">Rationale</dt><dd>{a.rationale}</dd></div>
              <div className="flex justify-between"><dt className="text-faint">Risk</dt><dd><StateBadge kind="risk" value={a.risk} /> {a.blocking ? <Badge tone="warning">blocks the run</Badge> : null}</dd></div>
              <div className="flex justify-between"><dt className="text-faint">Needs role</dt><dd>{a.approverRole}</dd></div>
              <div className="flex justify-between"><dt className="text-faint">Requested by</dt><dd className="font-mono text-xs">{a.requestedByActorType}: {a.requestedByActorId}</dd></div>
              <div className="flex justify-between"><dt className="text-faint">Created</dt><dd>{fmtDate(a.createdAt)}</dd></div>
              <div className="flex justify-between"><dt className="text-faint">Expires</dt><dd>{fmtDate(a.expiresAt)}</dd></div>
            </dl>
          </Card>
          <Card title="Decision">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-faint">State</dt><dd><StateBadge kind="approval" value={a.state} /></dd></div>
              {a.state !== "pending" ? (
                <>
                  <div className="flex justify-between"><dt className="text-faint">Decided by</dt><dd className="font-mono text-xs">{a.decidedByActorId ?? "system"}</dd></div>
                  <div className="flex justify-between"><dt className="text-faint">Decided at</dt><dd>{fmtDate(a.decidedAt)}</dd></div>
                  <div><dt className="text-faint">Note</dt><dd>{a.decisionNote ?? <span className="text-faint">none</span>}</dd></div>
                </>
              ) : canDecide ? (
                <form action={decideClientApprovalAction} className="space-y-2 pt-2">
                  <input type="hidden" name="slug" value={slug} /><input type="hidden" name="approvalId" value={a.id} /><input type="hidden" name="returnTo" value={returnTo} />
                  <label className="block text-xs text-muted">Note (optional)<input name="note" maxLength={1000} className={`${inputClass} mt-1`} /></label>
                  <div className="flex gap-2">
                    <button type="submit" name="decision" value="approved" className={smallPrimaryClass}>Approve</button>
                    <ConfirmButton name="decision" value="rejected" message="Reject? The agent run will be cancelled and nothing is published." className={smallDangerClass}>Reject</ConfirmButton>
                  </div>
                </form>
              ) : (
                <div className="text-xs text-muted">{access.viaGrant ? "Break-glass access is read-only." : `Requires the ${a.approverRole} role. Your roles: ${access.ctx.roles.join(", ") || "none"}.`}</div>
              )}
            </dl>
          </Card>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Agent run" footer="The run is suspended in waiting_for_approval while this request is pending. Approve: it re-queues and continues. Reject: it ends as cancelled.">
            {d.run ? (
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-faint">Agent</dt><dd>{d.run.agentName}</dd></div>
                <div className="flex justify-between"><dt className="text-faint">Run</dt><dd className="font-mono text-xs">{d.run.id.slice(0, 8)}</dd></div>
                <div className="flex justify-between"><dt className="text-faint">Trigger</dt><dd><TriggerBadge trigger={d.run.trigger} /></dd></div>
                <div className="flex justify-between"><dt className="text-faint">State</dt><dd><StateBadge kind="run" value={d.run.state} /></dd></div>
                <div className="flex justify-between"><dt className="text-faint">Mode</dt><dd><SimulatedBadge simulated={d.run.simulated} /></dd></div>
                <div><dt className="text-faint">Summary</dt><dd>{d.run.summary ?? <span className="text-faint">not finished</span>}</dd></div>
              </dl>
            ) : (
              <Empty>No run attached to this approval.</Empty>
            )}
          </Card>
          <Card title="Gated action" footer="The action cannot execute until this approval is approved: a database trigger, not application code, enforces it (M1-07).">
            {d.action ? (
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-faint">Action</dt><dd className="font-mono text-xs">{d.action.actionType}</dd></div>
                <div className="flex justify-between"><dt className="text-faint">Risk</dt><dd><StateBadge kind="risk" value={d.action.risk} /></dd></div>
                <div className="flex justify-between"><dt className="text-faint">Executed</dt><dd>{d.action.executedAt ? fmtDate(d.action.executedAt) : <Badge tone="warning">not executed</Badge>}</dd></div>
                {payload && Array.isArray(payload.questionIds) ? <div className="flex justify-between"><dt className="text-faint">Questions to publish</dt><dd>{payload.questionIds.length}</dd></div> : null}
              </dl>
            ) : (
              <Empty>No gated action linked ({a.subjectType}).</Empty>
            )}
          </Card>
        </div>

        <Card title={`Questions in scope (${d.questions.length})`} footer="Drafted by the agent in this run. Approving publishes them to the Interview Inbox (state open); rejecting leaves them as drafts and cancels the run.">
          <Table head={["Department", "To", "Question", "Why", "Evidence gap", "Priority", "Answer type", "State"]} empty={d.questions.length === 0 ? <Empty>No questions attached to this run.</Empty> : null}>
            {d.questions.map((q) => (
              <Tr key={q.id}>
                <Td className="text-muted">{q.department}</Td>
                <Td className="text-muted">{q.recipientRole}</Td>
                <Td className="max-w-md font-medium">{q.questionText}</Td>
                <Td className="max-w-xs text-xs text-muted">{q.reason}</Td>
                <Td className="max-w-xs text-xs text-muted">{q.evidenceGap}</Td>
                <Td><Badge tone={q.priority === "critical" ? "danger" : q.priority === "high" ? "warning" : "neutral"}>{q.priority}</Badge></Td>
                <Td className="text-xs text-muted">{q.answerType}</Td>
                <Td><StateBadge kind="question" value={q.state} /></Td>
              </Tr>
            ))}
          </Table>
          <div className="mt-3 text-xs"><Link href={`/c/${slug}/approvals`} className="underline">Back to approvals</Link></div>
        </Card>
      </div>
    </Shell>
  );
}
