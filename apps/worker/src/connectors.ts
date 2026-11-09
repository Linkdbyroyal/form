import { operatorContext, type DbHandle } from "@sbos/db";
import { dueConnections, type JobBackend } from "@sbos/core";

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
