import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRootEnv } from "../scripts/_env";
import { decideOperatorAccess, decideTenantAccess, grantIsActive, mapOrgRoleToMembership, mfaGate } from "../lib/auth-policy";

/**
 * M1-01 tests.
 * Unit: role mapping and the MFA / access decision functions (pure).
 * Integration: a dedicated database (DATABASE_URL_TEST with the name suffixed `_web`, created when
 * missing so the @sbos/db suite and this one never reset the same database in parallel). Runs
 * migrations and seed, then exercises Better Auth's server API and checks the bridge rows in
 * public.users, tenants.auth_org_id and public.memberships.
 */
loadRootEnv();
const baseTestUrl = process.env.DATABASE_URL_TEST ?? "postgres://sbos:sbos@localhost:5432/sbos_test";
const webTestUrl = `${baseTestUrl}_web`;
process.env.DATABASE_URL = webTestUrl;
process.env.DATABASE_URL_MIGRATE = webTestUrl;
process.env.DATABASE_URL_AUTH = webTestUrl;
// `.env` may define these as empty strings, so test explicitly instead of using ??=.
if (!process.env.BETTER_AUTH_SECRET) process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-0000";
if (!process.env.BETTER_AUTH_URL) process.env.BETTER_AUTH_URL = "http://localhost:3000";
delete process.env.RESEND_API_KEY;

describe("role mapping (ADR-017 keys)", () => {
  it("maps organisation roles for client and demo tenants", () => {
    expect(mapOrgRoleToMembership("owner", "client")).toBe("client_admin");
    expect(mapOrgRoleToMembership("admin", "client")).toBe("department_manager");
    expect(mapOrgRoleToMembership("member", "demo")).toBe("client_employee");
  });
  it("maps organisation roles for the agency tenant", () => {
    expect(mapOrgRoleToMembership("owner", "agency")).toBe("superadmin");
    expect(mapOrgRoleToMembership("admin", "agency")).toBe("agency_operator");
    expect(mapOrgRoleToMembership("member", "agency")).toBe("agency_consultant");
  });
  it("takes the highest role from a comma-separated list and rejects unknown roles", () => {
    expect(mapOrgRoleToMembership("member,owner", "client")).toBe("client_admin");
    expect(mapOrgRoleToMembership("admin, member", "agency")).toBe("agency_operator");
    expect(mapOrgRoleToMembership("viewer", "client")).toBeNull();
    expect(mapOrgRoleToMembership("", "client")).toBeNull();
  });
});

describe("MFA gate (ADR-015)", () => {
  it("requires MFA for superadmin and agency_operator without a second factor", () => {
    expect(mfaGate({ roles: ["superadmin"], twoFactorEnabled: false })).toBe("require_mfa");
    expect(mfaGate({ roles: ["agency_operator"], twoFactorEnabled: false })).toBe("require_mfa");
    expect(mfaGate({ roles: ["superadmin"], twoFactorEnabled: true })).toBe("allow");
  });
  it("does not require MFA for other roles", () => {
    expect(mfaGate({ roles: ["client_admin", "agency_consultant"], twoFactorEnabled: false })).toBe("allow");
    expect(mfaGate({ roles: [], twoFactorEnabled: false })).toBe("allow");
  });
  it("operator access: unauthenticated and non-operators go to sign-in, operators without MFA to security", () => {
    expect(decideOperatorAccess({ authenticated: false, agencyRoles: [], twoFactorEnabled: false })).toMatchObject({ kind: "redirect", to: "/sign-in" });
    expect(decideOperatorAccess({ authenticated: true, agencyRoles: ["agency_consultant"], twoFactorEnabled: true })).toMatchObject({ kind: "redirect", to: "/sign-in", reason: "not_operator" });
    expect(decideOperatorAccess({ authenticated: true, agencyRoles: ["superadmin"], twoFactorEnabled: false })).toMatchObject({ kind: "redirect", to: "/account/security", reason: "mfa_required" });
    expect(decideOperatorAccess({ authenticated: true, agencyRoles: ["agency_operator", "agency_reviewer"], twoFactorEnabled: true })).toEqual({ kind: "allow", roles: ["agency_operator"] });
  });
  it("tenant access: membership wins, operators need an active grant, others are forbidden", () => {
    const base = { authenticated: true, twoFactorEnabled: true, hasActiveGrant: false };
    expect(decideTenantAccess({ ...base, tenantRoles: ["client_admin"], agencyRoles: [] })).toEqual({ kind: "allow", roles: ["client_admin"], viaGrant: false });
    expect(decideTenantAccess({ ...base, tenantRoles: [], agencyRoles: ["superadmin"] })).toEqual({ kind: "forbidden", reason: "operator_without_grant" });
    expect(decideTenantAccess({ ...base, tenantRoles: [], agencyRoles: ["superadmin"], hasActiveGrant: true })).toEqual({ kind: "allow", roles: ["superadmin"], viaGrant: true });
    expect(decideTenantAccess({ ...base, tenantRoles: [], agencyRoles: ["superadmin"], hasActiveGrant: true, twoFactorEnabled: false })).toEqual({ kind: "redirect", to: "/account/security" });
    expect(decideTenantAccess({ ...base, tenantRoles: [], agencyRoles: ["agency_operator"], hasActiveGrant: true })).toEqual({ kind: "allow", roles: ["agency_operator"], viaGrant: true });
    expect(decideTenantAccess({ ...base, tenantRoles: [], agencyRoles: ["agency_operator"] })).toEqual({ kind: "forbidden", reason: "operator_without_grant" });
    expect(decideTenantAccess({ ...base, tenantRoles: [], agencyRoles: ["agency_consultant"], hasActiveGrant: true })).toEqual({ kind: "forbidden", reason: "no_membership" });
    expect(decideTenantAccess({ ...base, authenticated: false, tenantRoles: [], agencyRoles: [] })).toEqual({ kind: "redirect", to: "/sign-in" });
  });
  it("grants expire and can be revoked", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    expect(grantIsActive({ expiresAt: new Date("2026-11-09T13:00:00Z"), revokedAt: null }, now)).toBe(true);
    expect(grantIsActive({ expiresAt: new Date("2026-11-09T11:00:00Z"), revokedAt: null }, now)).toBe(false);
    expect(grantIsActive({ expiresAt: new Date("2026-11-09T13:00:00Z"), revokedAt: now }, now)).toBe(false);
  });
});

describe("integration: Better Auth + identity bridge", () => {
  type Mods = {
    auth: typeof import("../lib/auth").auth;
    bridge: typeof import("../lib/auth-bridge");
    db: ReturnType<typeof import("../lib/db").getDb>;
    closeAuthDb: typeof import("../lib/auth-db").closeAuthDb;
    sbos: typeof import("@sbos/db");
    authSchema: typeof import("@sbos/db/schema").betterAuthSchema;
    drizzle: typeof import("drizzle-orm");
  };
  let m: Mods;
  let agencyTenantId: string;
  let northlineTenantId: string;
  const PASSWORD = "correct-horse-battery-staple-42";
  const sysOperator = () => m.sbos.operatorContext({ actorType: "system", actorId: "auth-test", roles: ["system"] });

  async function ensureDatabase(): Promise<void> {
    const admin = new pg.Client({ connectionString: baseTestUrl });
    await admin.connect();
    try {
      const name = new URL(webTestUrl).pathname.slice(1);
      const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
  }

  async function publicRows<T extends Record<string, unknown>>(query: ReturnType<Mods["drizzle"]["sql"]>): Promise<T[]> {
    return m.db.withContext(sysOperator(), async (tx) => (await tx.execute(query)).rows as T[]);
  }

  beforeAll(async () => {
    await ensureDatabase();
    const sbos = await import("@sbos/db");
    await sbos.resetDatabase(webTestUrl);
    await sbos.runMigrations(webTestUrl);
    const seedHandle = sbos.createDb({ connectionString: webTestUrl, max: 2 });
    const seeded = await sbos.seed(seedHandle);
    await seedHandle.close();
    agencyTenantId = seeded.agencyTenantId;
    northlineTenantId = seeded.tenantIds["northline-events"]!;
    const [{ auth }, bridge, { getDb }, { closeAuthDb }, { betterAuthSchema }, drizzle] = await Promise.all([
      import("../lib/auth"),
      import("../lib/auth-bridge"),
      import("../lib/db"),
      import("../lib/auth-db"),
      import("@sbos/db/schema"),
      import("drizzle-orm")
    ]);
    m = { auth, bridge, db: getDb(), closeAuthDb, sbos, authSchema: betterAuthSchema, drizzle };
  });

  afterAll(async () => {
    await m?.closeAuthDb();
    await m?.db.close();
  });

  it("auth tables live in schema auth and the app roles have no privileges on them", async () => {
    const client = new pg.Client({ connectionString: webTestUrl });
    await client.connect();
    try {
      const tables = await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'auth' ORDER BY table_name");
      expect(tables.rows.map((r) => r.table_name)).toEqual(["account", "break_glass_totp_replay", "invitation", "member", "organization", "session", "two_factor", "user", "verification"]);
      const grants = await client.query("SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'auth' AND grantee IN ('sbos_app', 'sbos_operator')");
      expect(grants.rowCount).toBe(0);
      const usage = await client.query<{ ok: boolean }>("SELECT has_schema_privilege('sbos_app', 'auth', 'USAGE') AS ok");
      expect(usage.rows[0]?.ok).toBe(false);
    } finally {
      await client.end();
    }
  });

  let adminUserId: string;
  it("createUser (admin plugin, server call) mirrors the user into public.users with the same UUID", async () => {
    const res = await m.auth.api.createUser({ body: { email: "boot@secondbrain.test", password: PASSWORD, name: "Boot Admin", role: "admin", data: { emailVerified: true } } });
    adminUserId = res.user.id;
    expect(adminUserId).toMatch(/^[0-9a-f-]{36}$/);
    // users.email is not granted to the operator role (column grant), so read it in agency scope.
    const rows = await m.db.withContext(m.sbos.agencyContext({ tenantId: null, actorType: "system", actorId: "auth-test", roles: ["system"] }), async (tx) =>
      (await tx.execute(m.drizzle.sql`SELECT id, email, display_name FROM users WHERE id = ${adminUserId}::uuid`)).rows
    );
    expect(rows).toEqual([{ id: adminUserId, email: "boot@secondbrain.test", display_name: "Boot Admin" }]);
  });

  it("refuses an organisation whose slug has no tenant", async () => {
    await expect(m.auth.api.createOrganization({ body: { name: "Ghost", slug: "ghost-tenant", userId: adminUserId } })).rejects.toThrow(/No tenant with slug/);
  });

  let agencyOrgId: string;
  it("creating the agency organisation links tenants.auth_org_id and mirrors owner -> superadmin", async () => {
    const org = await m.auth.api.createOrganization({ body: { name: "Second Brain AI Agency", slug: "second-brain-agency", userId: adminUserId } });
    expect(org).not.toBeNull();
    agencyOrgId = org!.id;
    const tenant = await publicRows<{ auth_org_id: string | null }>(m.drizzle.sql`SELECT auth_org_id FROM tenants WHERE id = ${agencyTenantId}::uuid`);
    expect(tenant[0]?.auth_org_id).toBe(agencyOrgId);
    const memberships = await publicRows<{ role_key: string }>(m.drizzle.sql`SELECT role_key FROM memberships WHERE tenant_id = ${agencyTenantId}::uuid AND user_id = ${adminUserId}::uuid`);
    expect(memberships.map((r) => r.role_key)).toEqual(["superadmin"]);
    expect(await m.bridge.isSuperadmin(adminUserId)).toBe(true);
    const audit = await publicRows<{ action: string }>(m.drizzle.sql`SELECT action FROM audit_events WHERE actor_id = 'auth-bridge' ORDER BY occurred_at`);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["auth.organization.linked", "auth.membership.synced"]));
  });

  it("refuses a second organisation for an already linked tenant", async () => {
    await expect(m.auth.api.createOrganization({ body: { name: "Again", slug: "second-brain-agency", userId: adminUserId } })).rejects.toThrow();
  });

  let staffUserId: string;
  let northlineOrgId: string;
  it("client organisation: owner -> client_admin, addMember admin -> department_manager", async () => {
    const org = await m.auth.api.createOrganization({ body: { name: "Northline Events", slug: "northline-events", userId: adminUserId } });
    northlineOrgId = org!.id;
    const staff = await m.auth.api.createUser({ body: { email: "staff@northline.test", password: PASSWORD, name: "Stella Staff" } });
    staffUserId = staff.user.id;
    await m.auth.api.addMember({ body: { userId: staffUserId, organizationId: northlineOrgId, role: "admin" } });
    const rows = await publicRows<{ user_id: string; role_key: string }>(
      m.drizzle.sql`SELECT user_id, role_key FROM memberships WHERE tenant_id = ${northlineTenantId}::uuid AND user_id IN (${adminUserId}::uuid, ${staffUserId}::uuid) ORDER BY role_key`
    );
    expect(rows).toEqual([
      { user_id: adminUserId, role_key: "client_admin" },
      { user_id: staffUserId, role_key: "department_manager" }
    ]);
  });

  it("syncMemberships follows a role change and a removal, and leaves non-bridge roles alone", async () => {
    const { eq, sql } = m.drizzle;
    const authDb = (await import("../lib/auth-db")).getAuthDb();
    // Seeded, non-bridge role on an org-linked tenant must survive the sync.
    await m.db.withContext(m.sbos.tenantContext({ tenantId: northlineTenantId, actorType: "system", actorId: "auth-test", roles: ["system"] }), (tx) =>
      tx.execute(sql`INSERT INTO memberships (tenant_id, user_id, role_key) VALUES (${northlineTenantId}::uuid, ${staffUserId}::uuid, 'client_auditor')`)
    );
    await authDb.update(m.authSchema.member).set({ role: "member" }).where(sql`${m.authSchema.member.userId} = ${staffUserId} AND ${m.authSchema.member.organizationId} = ${northlineOrgId}`);
    const changed = await m.bridge.syncMemberships(staffUserId);
    expect(changed.memberships).toEqual([{ tenantId: northlineTenantId, slug: "northline-events", roleKey: "client_employee" }]);
    let rows = await publicRows<{ role_key: string }>(m.drizzle.sql`SELECT role_key FROM memberships WHERE tenant_id = ${northlineTenantId}::uuid AND user_id = ${staffUserId}::uuid ORDER BY role_key`);
    expect(rows.map((r) => r.role_key)).toEqual(["client_auditor", "client_employee"]);

    await authDb.delete(m.authSchema.member).where(eq(m.authSchema.member.userId, staffUserId));
    const removed = await m.bridge.syncMemberships(staffUserId);
    expect(removed.removedTenantIds).toEqual([northlineTenantId]);
    rows = await publicRows<{ role_key: string }>(m.drizzle.sql`SELECT role_key FROM memberships WHERE tenant_id = ${northlineTenantId}::uuid AND user_id = ${staffUserId}::uuid`);
    expect(rows.map((r) => r.role_key)).toEqual(["client_auditor"]);
  });

  it("an unverified e-mail cannot sign in; a verified one gets a session that resolves through getSession", async () => {
    await expect(m.auth.api.signInEmail({ body: { email: "staff@northline.test", password: PASSWORD } })).rejects.toMatchObject({ status: "FORBIDDEN" });

    const res = await m.auth.api.signInEmail({ body: { email: "boot@secondbrain.test", password: PASSWORD }, asResponse: true });
    expect(res.status).toBe(200);
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(cookie).toContain("session_token");
    const session = await m.auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.id).toBe(adminUserId);
    expect(session?.user.twoFactorEnabled ?? false).toBe(false);
    // The MFA gate treats this superadmin session as not authenticated for Mission Control.
    expect(decideOperatorAccess({ authenticated: true, agencyRoles: ["superadmin"], twoFactorEnabled: Boolean(session?.user.twoFactorEnabled) })).toMatchObject({ kind: "redirect", to: "/account/security" });

    const principal = await m.bridge.loadPrincipalData({ id: adminUserId, email: "boot@secondbrain.test", name: "Boot Admin" });
    expect(principal.memberships.map((x) => `${x.slug}:${x.roleKey}`).sort()).toEqual(["northline-events:client_admin", "second-brain-agency:superadmin"]);
    expect(principal.activeGrantTenantIds).toEqual([]);
  });
});
