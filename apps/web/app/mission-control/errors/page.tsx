import Link from "next/link";
import { Card, Empty, Status } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { FilterBar, Notice, PageHeader, ShortId, StateBadge, Table, Td, Tr, smallButtonClass, smallPrimaryClass } from "@/components/agent-ui";
import { firstParam, fmtDate } from "@/lib/format";
import { incidentAction } from "@/lib/mission-control/actions";
import { countIncidentsByState, listIncidents, type IncidentState } from "@/lib/mission-control/queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

const INCIDENT_STATES: IncidentState[] = ["open", "acknowledged", "resolved"];

export default async function ErrorsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOperatorContext();
  const sp = await searchParams;
  const raw = firstParam(sp.state);
  const state = raw && (INCIDENT_STATES as string[]).includes(raw) ? (raw as IncidentState) : raw === "all" ? null : "open";
  const [rows, counts] = await Promise.all([listIncidents(state), countIncidentsByState()]);
  const countBy = new Map(counts.map((c) => [c.state, c.n]));
  const returnTo = `/mission-control/errors${raw ? `?state=${encodeURIComponent(raw)}` : ""}`;
  return (
    <div className="space-y-6">
      <PageHeader title="Errors & Incidents">
        Incidents raised by the worker: failed runs, dead-letter jobs, missed schedules, budget stops, lease expiry, refused admissions. Details hold identifiers only. Acknowledge and resolve run under the operator role, which has an UPDATE grant on exactly these columns. <Status state="implemented" />
      </PageHeader>
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
      <FilterBar
        basePath="/mission-control/errors"
        param="state"
        current={raw ?? "open"}
        options={[{ value: "open", label: `open (${countBy.get("open") ?? 0})` }, { value: "acknowledged", label: `acknowledged (${countBy.get("acknowledged") ?? 0})` }, { value: "resolved", label: `resolved (${countBy.get("resolved") ?? 0})` }, { value: "all", label: `all (${counts.reduce((a, c) => a + c.n, 0)})` }]}
      />
      <Card title={`Incidents${state ? ` (${state})` : ""}: ${rows.length}`} footer="High and critical incidents also queue a Pumble notification (ADR-018). Open incidents with the same dedupe key are not duplicated. Dead-letter queue inspection lives in the worker; this page shows the incident it produced.">
        <Table head={["Incident", "Created", "Tenant", "Kind", "Severity", "Title", "Run", "Agent", "State", "Acknowledged by", "Resolved", ""]} empty={rows.length === 0 ? <Empty>No {state ?? ""} incidents. Silence here is only meaningful while the worker is running; check the worker health endpoint.</Empty> : null}>
          {rows.map((i) => (
            <Tr key={i.id}>
              <Td><ShortId id={i.id} /></Td>
              <Td className="text-muted">{fmtDate(i.createdAt)}</Td>
              <Td>{i.tenantSlug ? <Link href={`/mission-control/clients/${i.tenantSlug}`} className="underline">{i.tenantName}</Link> : <span className="text-faint">platform</span>}</Td>
              <Td className="text-muted">{i.kind.replaceAll("_", " ")}</Td>
              <Td><StateBadge kind="risk" value={i.severity} /></Td>
              <Td className="max-w-sm">{i.title}</Td>
              <Td>{i.runId ? <Link href={`/mission-control/runs/${i.runId}`} className="underline"><ShortId id={i.runId} /></Link> : <span className="text-faint">n/a</span>}</Td>
              <Td>{i.agentInstanceId ? <Link href={`/mission-control/agents/${i.agentInstanceId}`} className="underline"><ShortId id={i.agentInstanceId} /></Link> : <span className="text-faint">n/a</span>}</Td>
              <Td><StateBadge kind="incident" value={i.state} /></Td>
              <Td className="text-xs text-muted">{i.acknowledgedBy ? (i.acknowledgedBy.length > 12 ? `${i.acknowledgedBy.slice(0, 8)}…` : i.acknowledgedBy) : ""}</Td>
              <Td className="text-muted">{fmtDate(i.resolvedAt)}</Td>
              <Td>
                {i.state !== "resolved" ? (
                  <div className="flex gap-1">
                    {i.state === "open" ? (
                      <form action={incidentAction}>
                        <input type="hidden" name="incidentId" value={i.id} /><input type="hidden" name="action" value="acknowledge" /><input type="hidden" name="returnTo" value={returnTo} />
                        <button type="submit" className={smallButtonClass}>Acknowledge</button>
                      </form>
                    ) : null}
                    <form action={incidentAction}>
                      <input type="hidden" name="incidentId" value={i.id} /><input type="hidden" name="action" value="resolve" /><input type="hidden" name="returnTo" value={returnTo} />
                      <ConfirmButton message="Mark this incident as resolved?" className={smallPrimaryClass}>Resolve</ConfirmButton>
                    </form>
                  </div>
                ) : null}
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
