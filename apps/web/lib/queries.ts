import { schema, writeAudit } from "@sbos/db";
import { count, eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { getOperatorContext, getTenantContext } from "./request-context";

const { tenants, memberships, departments, systems, auditEvents } = schema;

export interface TenantHeader {
  id: string;
  slug: string;
  name: string;
  kind: "client" | "agency" | "demo";
  status: string;
  industry: string | null;
  members: number;
  systems: number;
  departments: number;
}

/** Operator view: tenant headers and counts only. No content columns are selected. */
export async function listClientWorkspaces(): Promise<TenantHeader[]> {
  const db = getDb();
  return db.withContext(getOperatorContext(), async (tx) => {
    const rows = await tx
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        kind: tenants.kind,
        status: tenants.status,
        industry: tenants.industry,
        members: sql<number>`(select count(*) from ${memberships} m where m.tenant_id = ${tenants.id})`.mapWith(Number),
        systems: sql<number>`(select count(*) from ${systems} s where s.tenant_id = ${tenants.id})`.mapWith(Number),
        departments: sql<number>`(select count(*) from ${departments} d where d.tenant_id = ${tenants.id})`.mapWith(Number)
      })
      .from(tenants)
      .orderBy(tenants.kind, tenants.name);
    return rows;
  });
}

export interface OperatorOverview {
  tenants: number;
  clientTenants: number;
  auditEvents24h: number;
  authStatus: string;
}

export async function getOperatorOverview(): Promise<OperatorOverview> {
  const db = getDb();
  return db.withContext(getOperatorContext(), async (tx) => {
    const [t] = await tx.select({ n: count() }).from(tenants);
    const [c] = await tx.select({ n: count() }).from(tenants).where(sql`${tenants.kind} <> 'agency'`);
    const [a] = await tx.select({ n: count() }).from(auditEvents).where(sql`${auditEvents.occurredAt} > now() - interval '24 hours'`);
    return { tenants: t?.n ?? 0, clientTenants: c?.n ?? 0, auditEvents24h: a?.n ?? 0, authStatus: "dev-mode-no-auth" };
  });
}

export interface TenantDetail {
  tenant: { id: string; slug: string; name: string; kind: string; status: string; industry: string | null; locale: string };
  departments: Array<{ id: string; key: string; name: string; headRole: string | null }>;
  systems: Array<{
    id: string;
    name: string;
    vendor: string | null;
    function: string;
    claimStatus: string;
    apiCapabilities: string[];
    sourceOfTruthFor: string[];
    notes: string | null;
  }>;
  recentAudit: Array<{ id: string; action: string; entityType: string; actorType: string; actorId: string; occurredAt: Date }>;
  contentVisible: boolean;
}

/**
 * Client workspace view. Runs in TENANT context, so RLS limits every query to this tenant.
 * In M0 the dev actor is treated as a tenant member; M1 derives membership from the session.
 */
export async function getTenantDetail(slug: string): Promise<TenantDetail | null> {
  const db = getDb();
  const header = await db.withContext(getOperatorContext(), async (tx) => {
    const [row] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug));
    return row ?? null;
  });
  if (!header) return null;

  const ctx = getTenantContext(header.id);
  return db.withContext(ctx, async (tx) => {
    const [tenant] = await tx
      .select({ id: tenants.id, slug: tenants.slug, name: tenants.name, kind: tenants.kind, status: tenants.status, industry: tenants.industry, locale: tenants.locale })
      .from(tenants)
      .where(eq(tenants.id, header.id));
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
    await writeAudit(tx, ctx, { action: "workspace.viewed", entityType: "tenant", entityId: tenant.id });
    return { tenant, departments: deps, systems: sys, recentAudit, contentVisible: true };
  });
}

/** Operator drill-down: metadata only (no `notes`). Demonstrates the column grant. */
export async function getTenantOperatorView(slug: string) {
  const db = getDb();
  return db.withContext(getOperatorContext(), async (tx) => {
    const [tenant] = await tx
      .select({ id: tenants.id, slug: tenants.slug, name: tenants.name, kind: tenants.kind, status: tenants.status, industry: tenants.industry })
      .from(tenants)
      .where(eq(tenants.slug, slug));
    if (!tenant) return null;
    const sys = await tx
      .select({ id: systems.id, name: systems.name, vendor: systems.vendor, function: systems.function, claimStatus: systems.claimStatus, apiCapabilities: systems.apiCapabilities })
      .from(systems)
      .where(eq(systems.tenantId, tenant.id))
      .orderBy(systems.name);
    const deps = await tx.select({ id: departments.id, name: departments.name, key: departments.key }).from(departments).where(eq(departments.tenantId, tenant.id));
    const members = await tx.select({ roleKey: memberships.roleKey, n: count() }).from(memberships).where(eq(memberships.tenantId, tenant.id)).groupBy(memberships.roleKey);
    return { tenant, systems: sys, departments: deps, members };
  });
}
