import { schema, writeAudit, type TenantContext } from "@sbos/db";
import { eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import type { TenantDetail } from "./queries";

const { tenants, departments, systems, auditEvents } = schema;

/**
 * Client workspace view in TENANT context only. Replaces `getTenantDetail()` for the /c/[slug] page:
 * that function resolves the slug through the operator role first, which a client user does not have.
 * `viaGrant` marks a break-glass read; the audit row records it (ADR-017).
 */
export async function getTenantWorkspace(ctx: TenantContext, viaGrant: boolean): Promise<TenantDetail | null> {
  const db = getDb();
  return db.withContext(ctx, async (tx) => {
    const [tenant] = await tx
      .select({ id: tenants.id, slug: tenants.slug, name: tenants.name, kind: tenants.kind, status: tenants.status, industry: tenants.industry, locale: tenants.locale })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId));
    if (!tenant) return null;
    const deps = await tx.select({ id: departments.id, key: departments.key, name: departments.name, headRole: departments.headRole }).from(departments).orderBy(departments.name);
    const sys = await tx
      .select({
        id: systems.id,
        name: systems.name,
        vendor: systems.vendor,
        function: systems.function,
        claimStatus: systems.claimStatus,
        apiCapabilities: systems.apiCapabilities,
        sourceOfTruthFor: systems.sourceOfTruthFor,
        notes: systems.notes
      })
      .from(systems)
      .orderBy(systems.name);
    const recentAudit = await tx
      .select({ id: auditEvents.id, action: auditEvents.action, entityType: auditEvents.entityType, actorType: auditEvents.actorType, actorId: auditEvents.actorId, occurredAt: auditEvents.occurredAt })
      .from(auditEvents)
      .orderBy(sql`${auditEvents.occurredAt} desc`)
      .limit(10);
    await writeAudit(tx, ctx, {
      action: viaGrant ? "workspace.viewed.break_glass" : "workspace.viewed",
      entityType: "tenant",
      entityId: tenant.id,
      metadata: viaGrant ? { viaGrant: true } : {}
    });
    return { tenant, departments: deps, systems: sys, recentAudit, contentVisible: true };
  });
}
