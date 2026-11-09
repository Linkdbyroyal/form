import Link from "next/link";
import { Badge, Card, Empty, Status } from "@/components/ui";
import { FilterBar, Masked, PageHeader, ShortId, StateBadge, Table, Td, Tr } from "@/components/agent-ui";
import { firstParam, fmtDate } from "@/lib/format";
import { countTasksByState, listTasks, type TaskState } from "@/lib/mission-control/queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

const TASK_STATES: TaskState[] = ["draft", "open", "assigned", "in_progress", "waiting_input", "waiting_approval", "done", "cancelled", "failed"];

export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOperatorContext();
  const sp = await searchParams;
  const raw = firstParam(sp.state);
  const state = raw && (TASK_STATES as string[]).includes(raw) ? (raw as TaskState) : null;
  const [rows, counts] = await Promise.all([listTasks(state), countTasksByState()]);
  const countBy = new Map(counts.map((c) => [c.state, c.n]));
  return (
    <div className="space-y-6">
      <PageHeader title="Tasks">
        All agent tasks across tenants, metadata columns only. Filter by state through the query string. The instruction column is content and stays masked. <Status state="implemented" />
      </PageHeader>
      <FilterBar
        basePath="/mission-control/tasks"
        param="state"
        current={state}
        options={[{ value: null, label: `all (${counts.reduce((a, c) => a + c.n, 0)})` }, ...TASK_STATES.map((s) => ({ value: s, label: `${s.replaceAll("_", " ")} (${countBy.get(s) ?? 0})` }))]}
      />
      <Card title={`Tasks${state ? ` in state ${state}` : ""} (${rows.length})`} footer="Tasks are created by operators (Assign task), by the scheduler on every tick, or by agents. State moves with the run: in_progress when queued, waiting_approval when the run asks for approval, done or failed at the end.">
        <Table head={["Task", "Tenant", "Agent", "Title", "Instruction", "Priority", "State", "Created by", "Due", "Updated"]} empty={rows.length === 0 ? <Empty>No tasks{state ? ` in state ${state}` : ""}.</Empty> : null}>
          {rows.map((t) => (
            <Tr key={t.id}>
              <Td><ShortId id={t.id} /></Td>
              <Td><Link href={`/mission-control/clients/${t.tenantSlug}`} className="underline">{t.tenantName}</Link></Td>
              <Td>{t.agentInstanceId ? <Link href={`/mission-control/agents/${t.agentInstanceId}`} className="underline">{t.agentName ?? "agent"}</Link> : <span className="text-faint">unassigned</span>}</Td>
              <Td className="font-medium">{t.title}</Td>
              <Td><Masked what="instruction" /></Td>
              <Td><Badge tone={t.priority === "critical" ? "danger" : t.priority === "high" ? "warning" : "neutral"}>{t.priority}</Badge></Td>
              <Td><StateBadge kind="task" value={t.state} /></Td>
              <Td className="text-xs text-muted">{t.createdByActorType}:{t.createdByActorId.length > 16 ? `${t.createdByActorId.slice(0, 8)}…` : t.createdByActorId}</Td>
              <Td className="text-muted">{fmtDate(t.dueAt)}</Td>
              <Td className="text-muted">{fmtDate(t.updatedAt)}</Td>
            </Tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
