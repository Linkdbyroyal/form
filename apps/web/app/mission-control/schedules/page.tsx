import Link from "next/link";
import { Badge, Card, Empty, Status } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { Notice, PageHeader, ShortId, Table, Td, Tr, smallButtonClass, smallDangerClass } from "@/components/agent-ui";
import { firstParam, fmtDate } from "@/lib/format";
import { toggleScheduleAction } from "@/lib/mission-control/actions";
import { listSchedules } from "@/lib/mission-control/queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

function expectedBy(next: Date | null, seconds: number): string {
  if (!next) return "n/a";
  return fmtDate(new Date(next.getTime() + seconds * 1000));
}

export default async function SchedulesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOperatorContext();
  const sp = await searchParams;
  const rows = await listSchedules();
  const returnTo = "/mission-control/schedules";
  return (
    <div className="space-y-6">
      <PageHeader title="Schedules">
        Cron schedules per agent instance across tenants. The worker reconciles this table with pg-boss every minute; a tick creates a task and a run with trigger <code>schedule</code>. Expected-by is the stall alarm deadline (next run plus the window). <Status state="implemented" />
      </PageHeader>
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
      <Card title={`Schedules (${rows.length})`} footer="Enable/disable writes schedules.enabled in tenant scope with an audit event. Editing cron expressions and creating schedules is planned for a later milestone. Disabled schedules never fire; silence is reported by the stall check as a missed_schedule incident.">
        <Table head={["Schedule", "Tenant", "Agent", "Cron", "Timezone", "Misfire", "Enabled", "Last run", "Next run", "Expected by", ""]} empty={rows.length === 0 ? <Empty>No schedules. The seed creates one weekday schedule for the Northline Discovery agent.</Empty> : null}>
          {rows.map((s) => (
            <Tr key={s.id}>
              <Td className="font-medium">{s.name}<div><ShortId id={s.id} /></div></Td>
              <Td><Link href={`/mission-control/clients/${s.tenantSlug}`} className="underline">{s.tenantName}</Link></Td>
              <Td><Link href={`/mission-control/agents/${s.agentInstanceId}`} className="underline">{s.agentName}</Link></Td>
              <Td className="font-mono text-xs">{s.cron}</Td>
              <Td className="text-muted">{s.timezone}</Td>
              <Td className="text-muted">{s.misfire.replaceAll("_", " ")}</Td>
              <Td><Badge tone={s.enabled ? "success" : "neutral"}>{s.enabled ? "enabled" : "disabled"}</Badge></Td>
              <Td className="text-muted">{fmtDate(s.lastRunAt)}</Td>
              <Td className="text-muted">{fmtDate(s.nextRunAt)}</Td>
              <Td className="text-muted">{s.enabled ? expectedBy(s.nextRunAt, s.expectedBySeconds) : "n/a"}<div className="text-xs text-faint">window {s.expectedBySeconds}s</div></Td>
              <Td>
                <form action={toggleScheduleAction}>
                  <input type="hidden" name="tenantId" value={s.tenantId} /><input type="hidden" name="scheduleId" value={s.id} /><input type="hidden" name="returnTo" value={returnTo} />
                  <input type="hidden" name="enabled" value={s.enabled ? "false" : "true"} />
                  {s.enabled ? (
                    <ConfirmButton message={`Disable schedule "${s.name}"? The agent will not run on its own until re-enabled.`} className={smallDangerClass}>Disable</ConfirmButton>
                  ) : (
                    <button type="submit" className={smallButtonClass}>Enable</button>
                  )}
                </form>
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>
      <Card title="Status">
        <ul className="space-y-1 text-sm">
          <li><Status state="implemented" /> List across tenants, enable and disable with audit, stall alarm window shown</li>
          <li><Status state="implemented" /> Worker: pg-boss cron registration, tick to task plus run, missed-schedule incidents (M1-06)</li>
          <li><Status state="planned" /> Create and edit schedules, event triggers, per-schedule run history view</li>
        </ul>
      </Card>
    </div>
  );
}
