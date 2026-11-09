import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, tenantContext, type DbHandle } from "@sbos/db";
import { markStaleConnections, observeKpi, raiseIncident, type JobBackend } from "@sbos/core";
import { describeProvider, isProvider } from "./registry";

const { kpis, kpiObservations, connections } = schema;

/**
 * Stale-data rule (M5): a connection that missed more than two sync intervals makes its KPIs `stale`. For every
 * KPI the provider feeds we write one `stale_data` observation (no value, lineage says why) unless the latest
 * observation already says so, and raise one deduplicated incident per connection. Nothing is invented: the
 * dashboard shows the state, never the last number as if it were current.
 */
export async function markStaleData(handle: DbHandle, jobs: JobBackend, ctxFactory = tenantContext, now = new Date()): Promise<{ connections: number; observations: number }> {
  const opCtx = { kind: "operator" as const, actorType: "system" as const, actorId: "worker:stale-check", roles: ["agency_operator"] };
  const stale = await handle.withContext(opCtx, (tx) => markStaleConnections(tx, opCtx, now));
  let observations = 0;
  for (const s of stale) {
    const ctx = ctxFactory({ tenantId: s.tenantId, actorType: "system", actorId: `connector:${s.connectionId.slice(0, 8)}`, roles: ["system"] });
    await handle.withContext(ctx, async (tx) => {
      const [conn] = await tx.select({ provider: connections.provider, lastSyncAt: connections.lastSyncAt, interval: connections.syncIntervalMinutes }).from(connections).where(eq(connections.id, s.connectionId));
      if (!conn || !isProvider(conn.provider)) return;
      const keys = describeProvider(conn.provider).metrics.map((m) => m.key);
      const rows = await tx.select({ id: kpis.id, key: kpis.key }).from(kpis).where(and(eq(kpis.tenantId, s.tenantId), inArray(kpis.key, keys)));
      for (const k of rows) {
        const [latest] = await tx.select({ status: kpiObservations.status }).from(kpiObservations).where(eq(kpiObservations.kpiId, k.id)).orderBy(desc(kpiObservations.observedAt)).limit(1);
        if (latest?.status === "stale_data") continue;
        await observeKpi(tx, ctx, { tenantId: s.tenantId, kpiId: k.id, periodStart: conn.lastSyncAt ?? now, periodEnd: now, status: "stale_data", lineage: { query_or_formula: `no successful sync since ${conn.lastSyncAt?.toISOString() ?? "never"} (interval ${conn.interval} min)`, source_record_ids: [] } });
        observations++;
      }
      await raiseIncident(tx, jobs, { tenantId: s.tenantId, kind: "missed_schedule", severity: "medium", title: `Connector sync overdue (${conn.provider})`, details: { connectionId: s.connectionId, lastSyncAt: conn.lastSyncAt?.toISOString() ?? null, intervalMinutes: conn.interval }, dedupeKey: `connector-stale:${s.connectionId}` });
    });
  }
  return { connections: stale.length, observations };
}
