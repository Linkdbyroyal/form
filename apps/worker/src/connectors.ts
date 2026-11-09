import { operatorContext, type DbHandle } from "@sbos/db";
import { dueConnections, type JobBackend } from "@sbos/core";
import { markStaleData } from "@sbos/connectors";

/** Every five minutes: queue one `connector.sync` per connection whose interval has elapsed (deduplicated per connection). */
export async function enqueueDueSyncs(handle: DbHandle, jobs: JobBackend): Promise<number> {
  const ctx = operatorContext({ actorType: "system", actorId: "worker:sync-tick", roles: ["agency_operator"] });
  const due = await handle.withContext(ctx, (tx) => dueConnections(tx, ctx));
  let queued = 0;
  for (const c of due) {
    const id = await jobs.enqueue("connector.sync", { tenantId: c.tenantId, connectionId: c.id, trigger: "schedule" as const }, { singletonKey: `connector-sync:${c.id}` });
    if (id) queued++;
  }
  return queued;
}

/** Stale rule: connections that missed more than two intervals get stale observations and one incident. */
export async function markStale(handle: DbHandle, jobs: JobBackend): Promise<{ connections: number; observations: number }> {
  return markStaleData(handle, jobs);
}
