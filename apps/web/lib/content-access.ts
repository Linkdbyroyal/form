import { sql } from "drizzle-orm";
import type { TenantContext, Tx } from "@sbos/db";
import { getDb } from "./db";

/**
 * `knowledge_access_logs` writer (ADR-017). Every content read under a break-glass grant records who read
 * what: the request context writes one `page` row per request, and queries that read specific content
 * call `logContentAccess` (or `logContentAccessTx` inside their own transaction) with the resource.
 * The row is written in TENANT context, so RLS pins it to the tenant of the grant.
 */
export interface ContentAccessInput {
  grantId: string | null;
  resourceType: string;
  resourceId: string | null;
  purpose?: string | null;
}

export async function logContentAccessTx(tx: Tx, ctx: TenantContext, input: ContentAccessInput): Promise<void> {
  await tx.execute(sql`
    INSERT INTO knowledge_access_logs (tenant_id, actor_type, actor_id, grant_id, resource_type, resource_id, purpose)
    VALUES (${ctx.tenantId}::uuid, ${ctx.actorType}::actor_type, ${ctx.actorId}, ${input.grantId}::uuid, ${input.resourceType}, ${input.resourceId}, ${input.purpose ?? null})
  `);
}

/** Writes one access log row in its own transaction. */
export async function logContentAccess(ctx: TenantContext, grantId: string | null, resourceType: string, resourceId: string | null, purpose: string | null = "break_glass"): Promise<void> {
  await getDb().withContext(ctx, (tx) => logContentAccessTx(tx, ctx, { grantId, resourceType, resourceId, purpose }));
}
