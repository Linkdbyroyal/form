import { eq, sql } from "drizzle-orm";
import { agencyContext, operatorContext, tenantContext, writeAudit, type RequestContext } from "@sbos/db";
import { betterAuthSchema } from "@sbos/db/schema";
import { getAuthDb } from "./auth-db";
import { getDb } from "./db";
import { BRIDGE_MANAGED_ROLES, grantIsActive, mapOrgRoleToMembership, type TenantKind } from "./auth-policy";

/**
 * Identity bridge between Better Auth (schema `auth`, read through the owner pool) and our own
 * tables (schema `public`, written ONLY through `withContext()` so RLS applies). ADR-015.
 *
 * - `ensurePublicUser` mirrors an auth user into `public.users` with the same id.
 * - `linkOrganizationToTenant` sets `tenants.auth_org_id` for the tenant whose slug equals the organisation slug.
 * - `syncMemberships` reconciles the bridge-managed role keys in `public.memberships` for one user from
 *   `auth.member` rows. It is called from every organisation hook (add, remove, role change, accept
 *   invitation) and after every sign-in, so a hook that Better Auth did not fire still converges at
 *   the next sign-in. Role keys outside BRIDGE_MANAGED_ROLES are never touched.
 *
 * Reads that span tenants (memberships, tenants, grants) use the operator role, which is granted
 * SELECT on exactly those metadata tables. Writes use tenant or agency scope as RLS requires.
 */
const SYSTEM_ACTOR = { actorType: "system" as const, actorId: "auth-bridge", roles: ["system"] as const };

export interface TenantRef {
  id: string;
  slug: string;
  kind: TenantKind;
  authOrgId: string | null;
}

export interface AuthUserRef {
  id: string;
  email: string;
  name?: string | null;
}

function systemOperator(): RequestContext {
  return operatorContext({ ...SYSTEM_ACTOR });
}

/** `role_key IN (...)` over the bridge-managed role keys (drizzle renders a JS array as a tuple, not a Postgres array). */
const managedRoleList = () => sql.join(BRIDGE_MANAGED_ROLES.map((r) => sql`${r}`), sql`, `);

/** Inserts the auth user into public.users (same id) if missing and returns the public user id. */
export async function ensurePublicUser(user: AuthUserRef): Promise<string> {
  const db = getDb();
  const displayName = user.name && user.name.trim().length > 0 ? user.name.trim() : user.email;
  return db.withContext(agencyContext({ tenantId: null, ...SYSTEM_ACTOR }), async (tx) => {
    await tx.execute(
      sql`INSERT INTO users (id, email, display_name, status) VALUES (${user.id}::uuid, ${user.email}, ${displayName}, 'active') ON CONFLICT DO NOTHING`
    );
    const r = await tx.execute<{ id: string }>(
      sql`SELECT id FROM users WHERE id = ${user.id}::uuid OR lower(email) = lower(${user.email}) ORDER BY (id = ${user.id}::uuid) DESC LIMIT 1`
    );
    const row = r.rows[0];
    if (!row) throw new Error(`auth-bridge: could not mirror user ${user.id} into public.users`);
    return row.id;
  });
}

/** Resolves the public.users id for an auth user id (same id, or the seeded row with the same e-mail). */
export async function resolvePublicUserId(authUserId: string): Promise<string | null> {
  const authDb = getAuthDb();
  const [u] = await authDb
    .select({ id: betterAuthSchema.user.id, email: betterAuthSchema.user.email, name: betterAuthSchema.user.name })
    .from(betterAuthSchema.user)
    .where(eq(betterAuthSchema.user.id, authUserId));
  if (!u) return null;
  return ensurePublicUser(u);
}

export async function tenantBySlug(slug: string): Promise<TenantRef | null> {
  const db = getDb();
  return db.withContext(systemOperator(), async (tx) => {
    const r = await tx.execute<{ id: string; slug: string; kind: TenantKind; auth_org_id: string | null }>(
      sql`SELECT id, slug, kind, auth_org_id FROM tenants WHERE slug = ${slug}`
    );
    const t = r.rows[0];
    return t ? { id: t.id, slug: t.slug, kind: t.kind, authOrgId: t.auth_org_id } : null;
  });
}

export async function tenantByOrgId(orgId: string): Promise<TenantRef | null> {
  const db = getDb();
  return db.withContext(systemOperator(), async (tx) => {
    const r = await tx.execute<{ id: string; slug: string; kind: TenantKind; auth_org_id: string | null }>(
      sql`SELECT id, slug, kind, auth_org_id FROM tenants WHERE auth_org_id = ${orgId}`
    );
    const t = r.rows[0];
    return t ? { id: t.id, slug: t.slug, kind: t.kind, authOrgId: t.auth_org_id } : null;
  });
}

/** Refuses an organisation that has no tenant with the same slug, or whose tenant is already linked elsewhere. */
export async function assertOrganizationCanBeCreated(slug: string): Promise<TenantRef> {
  const tenant = await tenantBySlug(slug);
  if (!tenant) throw new Error(`No tenant with slug "${slug}". Create the tenant first; organisations map 1:1 to tenants (ADR-015).`);
  if (tenant.authOrgId) throw new Error(`Tenant "${slug}" is already linked to organisation ${tenant.authOrgId}.`);
  return tenant;
}

/** Sets tenants.auth_org_id for the tenant matching the organisation slug. Idempotent for the same organisation. */
export async function linkOrganizationToTenant(org: { id: string; slug: string; name: string }): Promise<TenantRef> {
  const tenant = await tenantBySlug(org.slug);
  if (!tenant) throw new Error(`auth-bridge: organisation ${org.id} (${org.slug}) has no tenant with that slug`);
  if (tenant.authOrgId && tenant.authOrgId !== org.id) {
    throw new Error(`auth-bridge: tenant ${tenant.slug} is already linked to organisation ${tenant.authOrgId}`);
  }
  if (tenant.authOrgId === org.id) return tenant;
  const db = getDb();
  const ctx = tenantContext({ tenantId: tenant.id, ...SYSTEM_ACTOR });
  await db.withContext(ctx, async (tx) => {
    await tx.execute(sql`UPDATE tenants SET auth_org_id = ${org.id} WHERE id = ${tenant.id}::uuid AND auth_org_id IS NULL`);
    await writeAudit(tx, ctx, { action: "auth.organization.linked", entityType: "tenant", entityId: tenant.id, metadata: { authOrgId: org.id } });
  });
  return { ...tenant, authOrgId: org.id };
}

/** Sets exactly one bridge-managed role for the user on the tenant (or none when the org role is unknown). */
export async function setBridgedMembership(publicUserId: string, tenant: TenantRef, orgRole: string | null): Promise<string | null> {
  const roleKey = orgRole ? mapOrgRoleToMembership(orgRole, tenant.kind) : null;
  const db = getDb();
  const ctx = tenantContext({ tenantId: tenant.id, ...SYSTEM_ACTOR });
  await db.withContext(ctx, async (tx) => {
    const removed = await tx.execute<{ role_key: string }>(
      sql`DELETE FROM memberships WHERE tenant_id = ${tenant.id}::uuid AND user_id = ${publicUserId}::uuid
          AND role_key IN (${managedRoleList()}) AND role_key IS DISTINCT FROM ${roleKey} RETURNING role_key`
    );
    let inserted = false;
    if (roleKey) {
      const ins = await tx.execute<{ id: string }>(
        sql`INSERT INTO memberships (tenant_id, user_id, role_key) VALUES (${tenant.id}::uuid, ${publicUserId}::uuid, ${roleKey})
            ON CONFLICT DO NOTHING RETURNING id`
      );
      inserted = ins.rows.length > 0;
    }
    if (removed.rows.length > 0 || inserted) {
      await writeAudit(tx, ctx, {
        action: "auth.membership.synced",
        entityType: "membership",
        entityId: publicUserId,
        metadata: { roleKey, removed: removed.rows.map((r) => r.role_key), orgRole }
      });
    }
  });
  return roleKey;
}

export interface SyncResult {
  authUserId: string;
  publicUserId: string;
  memberships: Array<{ tenantId: string; slug: string; roleKey: string | null }>;
  removedTenantIds: string[];
  unlinkedOrganizationIds: string[];
}

/** Full reconcile of bridge-managed memberships for one user from auth.member. Safe to call often. */
export async function syncMemberships(authUserId: string): Promise<SyncResult> {
  const authDb = getAuthDb();
  const [u] = await authDb
    .select({ id: betterAuthSchema.user.id, email: betterAuthSchema.user.email, name: betterAuthSchema.user.name })
    .from(betterAuthSchema.user)
    .where(eq(betterAuthSchema.user.id, authUserId));
  if (!u) throw new Error(`auth-bridge: auth user ${authUserId} not found`);
  const publicUserId = await ensurePublicUser(u);

  const members = await authDb
    .select({ orgId: betterAuthSchema.member.organizationId, role: betterAuthSchema.member.role })
    .from(betterAuthSchema.member)
    .where(eq(betterAuthSchema.member.userId, authUserId));

  const desired = new Map<string, { tenant: TenantRef; orgRole: string }>();
  const unlinked: string[] = [];
  for (const m of members) {
    const tenant = await tenantByOrgId(m.orgId);
    if (!tenant) {
      unlinked.push(m.orgId);
      continue;
    }
    desired.set(tenant.id, { tenant, orgRole: m.role });
  }

  // Current bridge-managed memberships on org-linked tenants (operator role: metadata read across tenants).
  const db = getDb();
  const current = await db.withContext(systemOperator(), async (tx) => {
    const r = await tx.execute<{ tenant_id: string; slug: string; kind: TenantKind; auth_org_id: string }>(
      sql`SELECT DISTINCT m.tenant_id, t.slug, t.kind, t.auth_org_id FROM memberships m JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = ${publicUserId}::uuid AND t.auth_org_id IS NOT NULL AND m.role_key IN (${managedRoleList()})`
    );
    return r.rows;
  });

  const removedTenantIds: string[] = [];
  for (const row of current) {
    if (desired.has(row.tenant_id)) continue;
    await setBridgedMembership(publicUserId, { id: row.tenant_id, slug: row.slug, kind: row.kind, authOrgId: row.auth_org_id }, null);
    removedTenantIds.push(row.tenant_id);
  }
  const memberships: SyncResult["memberships"] = [];
  for (const { tenant, orgRole } of desired.values()) {
    const roleKey = await setBridgedMembership(publicUserId, tenant, orgRole);
    memberships.push({ tenantId: tenant.id, slug: tenant.slug, roleKey });
  }
  return { authUserId, publicUserId, memberships, removedTenantIds, unlinkedOrganizationIds: unlinked };
}

export interface PrincipalMembership {
  tenantId: string;
  slug: string;
  kind: TenantKind;
  roleKey: string;
}

export interface PrincipalData {
  publicUserId: string;
  memberships: PrincipalMembership[];
  /** Tenant ids with an unexpired, unrevoked client_content_grants row (ADR-017). */
  activeGrantTenantIds: string[];
}

/** Everything the request context needs to authorise a signed-in user. Metadata only. */
export async function loadPrincipalData(authUser: AuthUserRef): Promise<PrincipalData> {
  const publicUserId = await ensurePublicUser(authUser);
  const db = getDb();
  return db.withContext(systemOperator(), async (tx) => {
    const m = await tx.execute<{ tenant_id: string; slug: string; kind: TenantKind; role_key: string }>(
      sql`SELECT m.tenant_id, t.slug, t.kind, m.role_key FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ${publicUserId}::uuid`
    );
    const g = await tx.execute<{ tenant_id: string; expires_at: Date; revoked_at: Date | null }>(
      sql`SELECT tenant_id, expires_at, revoked_at FROM client_content_grants WHERE user_id = ${publicUserId}::uuid`
    );
    const now = new Date();
    return {
      publicUserId,
      memberships: m.rows.map((r) => ({ tenantId: r.tenant_id, slug: r.slug, kind: r.kind, roleKey: r.role_key })),
      activeGrantTenantIds: g.rows
        .filter((r) => grantIsActive({ expiresAt: new Date(r.expires_at), revokedAt: r.revoked_at ? new Date(r.revoked_at) : null }, now))
        .map((r) => r.tenant_id)
    };
  });
}

/** True when the auth user holds `superadmin` on the agency tenant. Used to gate organisation creation. */
export async function isSuperadmin(authUserId: string): Promise<boolean> {
  const publicUserId = await resolvePublicUserId(authUserId);
  if (!publicUserId) return false;
  const db = getDb();
  return db.withContext(systemOperator(), async (tx) => {
    const r = await tx.execute<{ ok: number }>(
      sql`SELECT 1 AS ok FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE t.kind = 'agency' AND m.role_key = 'superadmin' AND m.user_id = ${publicUserId}::uuid LIMIT 1`
    );
    return r.rows.length > 0;
  });
}
