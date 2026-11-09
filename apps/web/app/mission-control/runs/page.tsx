import Link from "next/link";
import { Card, Empty, Status } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { FilterBar, Notice, PageHeader, ShortId, SimulatedBadge, StateBadge, Table, Td, Tr, TriggerBadge, smallDangerClass } from "@/components/agent-ui";
import { firstParam, fmtDate, fmtInt, fmtUsd } from "@/lib/format";
import { stopRunAction } from "@/lib/mission-control/actions";
import { STOPPABLE_RUN_STATES, listRuns, listTenantOptions, type RunState } from "@/lib/mission-control/queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

const RUN_STATES: RunState[] = ["queued", "running", "waiting_for_input", "waiting_for_approval", "paused", "succeeded", "failed", "cancelled", "timed_out", "interrupted"];

export default async function RunsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOperatorContext();
  const sp = await searchParams;
  const rawState = firstParam(sp.state);
  const state = rawState && (RUN_STATES as string[]).includes(rawState) ? (rawState as RunState) : null;
  const tenantId = firstParam(sp.tenant);
  const [rows, tenantOptions] = await Promise.all([listRuns({ state, tenantId: tenantId && /^[0-9a-f-]{36}$/i.test(tenantId) ? tenantId : null }), listTenantOptions()]);
  const returnTo = `/mission-control/runs${state ? `?state=${state}` : ""}`;
  return (
    <div className="space-y-6">
      <PageHeader title="Runs & Traces">
        Last 100 agent runs across tenants with trigger, state, attempt, tokens and cost. Open a run for its event timeline. Payloads are content and stay masked for operators. <Status state="implemented" />
      </PageHeader>
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
      <div className="space-y-2">
        <FilterBar basePath="/mission-control/runs" param="state" current={state} options={[{ value: null, label: "all states" }, ...RUN_STATES.map((s) => ({ value: s, label: s.replaceAll("_", " ") }))]} />
        <FilterBar basePath="/mission-control/runs" param="tenant" current={tenantId} options={[{ value: null, label: "all tenants" }, ...tenantOptions.map((t) => ({ value: t.id, label: t.name }))]} />
      </div>
      <Card title={`Runs (${rows.length})`} footer="Mode: simulated runs used the deterministic SimulatedModel (no API key in the worker); live runs called the Anthropic API. Cost is the sum of recorded model calls (ADR-016).">
        <Table head={["Run", "Tenant", "Agent", "Trigger", "State", "Attempt", "Tokens in/out", "Cost", "Mode", "Started", "Finished", ""]} empty={rows.length === 0 ? <Empty>No runs match. Runs are created by schedules (worker), by operators (Run now, Assign task) or by resumes after an approval.</Empty> : null}>
          {rows.map((r) => (
            <Tr key={r.id}>
              <Td><Link href={`/mission-control/runs/${r.id}`} className="underline"><ShortId id={r.id} /></Link></Td>
              <Td><Link href={`/mission-control/clients/${r.tenantSlug}`} className="underline">{r.tenantName}</Link></Td>
              <Td><Link href={`/mission-control/agents/${r.agentInstanceId}`} className="underline">{r.agentName}</Link></Td>
              <Td><TriggerBadge trigger={r.trigger} /></Td>
              <Td><StateBadge kind="run" value={r.state} /></Td>
              <Td className="text-muted">{r.attempt}</Td>
              <Td className="text-muted">{fmtInt(r.tokensInput)} / {fmtInt(r.tokensOutput)}</Td>
              <Td>{fmtUsd(r.costUsd)}</Td>
              <Td><SimulatedBadge simulated={r.simulated} /></Td>
              <Td className="text-muted">{fmtDate(r.startedAt ?? r.createdAt)}</Td>
              <Td className="text-muted">{fmtDate(r.finishedAt)}</Td>
              <Td>
                {(STOPPABLE_RUN_STATES as readonly string[]).includes(r.state) ? (
                  <form action={stopRunAction}>
                    <input type="hidden" name="tenantId" value={r.tenantId} /><input type="hidden" name="runId" value={r.id} /><input type="hidden" name="returnTo" value={returnTo} />
                    <ConfirmButton message={`Stop run ${r.id.slice(0, 8)}?`} className={smallDangerClass}>Stop</ConfirmButton>
                  </form>
                ) : null}
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
