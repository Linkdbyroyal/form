import Link from "next/link";
import { notFound } from "next/navigation";
import { clientNav, Shell } from "@/components/shell";
import { Badge, Card, Empty, Stat, Status } from "@/components/ui";
import { PageHeader, ShortId, SimulatedBadge, StateBadge, Table, Td, Tr, TriggerBadge } from "@/components/agent-ui";
import { getClientAgentCenter, getTenantHeader } from "@/lib/client/queries";
import { fmtDate } from "@/lib/format";
import { requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function ClientAgentCenterPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireTenantContext(slug);
  if (!access) notFound();
  const [tenant, c] = await Promise.all([getTenantHeader(access.ctx), getClientAgentCenter(access.ctx)]);
  if (!tenant) notFound();
  return (
    <Shell title={tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
      <div className="space-y-6">
        <PageHeader title="Client Agent Center">
          The agents working for your organisation, what they did recently and what they are waiting for. Every run shows its trigger; agents run when scheduled or asked, not around the clock. <Status state="implemented" />
        </PageHeader>
        <div className="grid gap-4 md:grid-cols-4">
          <Stat label="Agents" value={c.instances.length} hint="instances in this workspace" />
          <Stat label="Approvals waiting" value={c.pendingApprovals} hint="decide in Approvals" />
          <Stat label="Open questions" value={c.openQuestions} hint="in the Interview Inbox" />
          <Stat label="Open tasks" value={c.openTasks.length} hint="assigned or in progress" />
        </div>

        <Card title="Agents" footer="Pause, resume and task assignment are operator actions in Mission Control; client-side agent controls are planned for a later milestone.">
          {c.instances.length === 0 ? <Empty>No agents assigned to this workspace yet.</Empty> : (
            <ul className="divide-y divide-border">
              {c.instances.map((i) => (
                <li key={i.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div>
                    <div className="flex items-center gap-2"><span className="font-medium">{i.name}</span><StateBadge kind="agent" value={i.state} /></div>
                    <div className="text-xs text-muted">{i.definitionName}: {i.mission}</div>
                    <div className="mt-1 text-xs text-faint">model {i.model ?? i.defaultModel}</div>
                  </div>
                  <div className="text-right text-xs text-muted">
                    <div>last run {fmtDate(i.lastRunAt)}</div>
                    <div>next scheduled {fmtDate(i.nextScheduledRunAt)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recent runs" footer="Summaries are written by the agent at the end of a run. Simulated runs used a deterministic stand-in model because the worker had no API key; they are labelled as such.">
          <Table head={["Run", "Agent", "Trigger", "State", "Mode", "Started", "Finished", "Summary"]} empty={c.runs.length === 0 ? <Empty>No runs yet.</Empty> : null}>
            {c.runs.map((r) => (
              <Tr key={r.id}>
                <Td><ShortId id={r.id} /></Td>
                <Td>{r.agentName}</Td>
                <Td><TriggerBadge trigger={r.trigger} /></Td>
                <Td><StateBadge kind="run" value={r.state} /></Td>
                <Td><SimulatedBadge simulated={r.simulated} /></Td>
                <Td className="text-muted">{fmtDate(r.startedAt ?? r.createdAt)}</Td>
                <Td className="text-muted">{fmtDate(r.finishedAt)}</Td>
                <Td className="max-w-md text-muted">{r.summary ?? ""}</Td>
              </Tr>
            ))}
          </Table>
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Open tasks">
            <Table head={["Task", "Title", "Priority", "State", "Created"]} empty={c.openTasks.length === 0 ? <Empty>No open tasks.</Empty> : null}>
              {c.openTasks.map((t) => (
                <Tr key={t.id}>
                  <Td><ShortId id={t.id} /></Td>
                  <Td className="font-medium">{t.title}</Td>
                  <Td><Badge tone={t.priority === "critical" ? "danger" : t.priority === "high" ? "warning" : "neutral"}>{t.priority}</Badge></Td>
                  <Td><StateBadge kind="task" value={t.state} /></Td>
                  <Td className="text-muted">{fmtDate(t.createdAt)}</Td>
                </Tr>
              ))}
            </Table>
          </Card>
          <Card title="Where to act">
            <ul className="space-y-2 text-sm">
              <li><Link href={`/c/${slug}/approvals`} className="underline">Approvals</Link>: {c.pendingApprovals} waiting for a decision <Status state="implemented" /></li>
              <li><Link href={`/c/${slug}/inbox`} className="underline">Interview Inbox</Link>: {c.openQuestions} open questions <Status state="implemented" /></li>
              <li>Feedback to an agent from the client side <Status state="planned" /></li>
            </ul>
          </Card>
        </div>
      </div>
    </Shell>
  );
}
