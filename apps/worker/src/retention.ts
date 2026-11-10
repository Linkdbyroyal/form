import { agencyContext, operatorContext, schema, type DbHandle } from "@sbos/db";
import { approvedDeletionRequests, executeDeletionRequest, sweepRetention } from "@sbos/core";
import { log } from "./log";

const { tenants } = schema;

/** Weekly: apply the effective retention policy per tenant and to platform rows, then execute approved automatable deletion requests. */
export async function runRetentionSweep(handle: DbHandle, now = new Date()): Promise<{ tenants: number; deleted: number; requestsExecuted: number }> {
  const op = operatorContext({ actorType: "system", actorId: "worker:retention", roles: ["agency_operator"] });
  const rows = await handle.withContext(op, (tx) => tx.select({ id: tenants.id, slug: tenants.slug }).from(tenants));
  let deleted = 0;
  for (const t of rows) {
    const ctx = agencyContext({ tenantId: t.id, actorType: "system", actorId: "worker:retention", roles: ["system"] });
    const counts = await handle.withContext(ctx, (tx) => sweepRetention(tx, ctx, { tenantId: t.id, now }));
    const n = Object.values(counts).reduce((a, b) => a + b, 0);
    deleted += n;
    if (n > 0) log("info", "retention sweep", { tenant: t.slug, ...counts });
  }
  const platform = agencyContext({ tenantId: null, actorType: "system", actorId: "worker:retention", roles: ["system"] });
  const platformCounts = await handle.withContext(platform, (tx) => sweepRetention(tx, platform, { tenantId: null, now }));
  deleted += Object.values(platformCounts).reduce((a, b) => a + b, 0);

  const approved = await handle.withContext(op, (tx) => approvedDeletionRequests(tx, op));
  let requestsExecuted = 0;
  for (const r of approved) {
    const ctx = agencyContext({ tenantId: r.tenantId, actorType: "system", actorId: "worker:retention", roles: ["system"] });
    try {
      const summary = await handle.withContext(ctx, (tx) => executeDeletionRequest(tx, ctx, { tenantId: r.tenantId, requestId: r.id }));
      requestsExecuted++;
      log("info", "deletion request executed", { requestId: r.id, kind: r.kind, ...summary });
    } catch (err) {
      log("error", "deletion request failed", { requestId: r.id, error: (err as Error).message });
    }
  }
  return { tenants: rows.length, deleted, requestsExecuted };
}
