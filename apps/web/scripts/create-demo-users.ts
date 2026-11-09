import { loadRootEnv } from "./_env";

/**
 * Creates or updates demo client users for a tenant (development and staging only; refuses in production).
 * Usage: SBOS_DEMO_TENANT=northline-events SBOS_DEMO_PASSWORD='...' pnpm --filter @sbos/web create-demo-users
 * Creates <role>@<slug-without-dashes>.test for client_admin (owner), department_manager (admin) and client_employee (member),
 * creates the tenant's organisation when missing (linked through the auth bridge) and syncs memberships.
 */
loadRootEnv();
if (process.env.NODE_ENV === "production") throw new Error("refusing to create demo users in production");
const slug = process.env.SBOS_DEMO_TENANT;
const password = process.env.SBOS_DEMO_PASSWORD;
if (!slug || !password || password.length < 12) throw new Error("SBOS_DEMO_TENANT and SBOS_DEMO_PASSWORD (12+ chars) are required");

const { sql, eq } = await import("drizzle-orm");
const { operatorContext } = await import("@sbos/db");
const { betterAuthSchema } = await import("@sbos/db/schema");
const { auth } = await import("../lib/auth");
const { getAuthDb, closeAuthDb } = await import("../lib/auth-db");
const { getDb } = await import("../lib/db");
const { syncMemberships, linkOrganizationToTenant } = await import("../lib/auth-bridge");

const db = getDb();
const authDb = getAuthDb();
const domain = `${slug.split("-")[0]}.test`; // matches the seed convention (ceo@northline.test)
const plan: Array<{ email: string; name: string; orgRole: "owner" | "admin" | "member" }> = [
  { email: `ceo@${domain}`, name: "Demo client admin", orgRole: "owner" },
  { email: `finance@${domain}`, name: "Demo department manager", orgRole: "admin" },
  { email: `staff@${domain}`, name: "Demo employee", orgRole: "member" }
];

try {
  const tenant = await db.withContext(operatorContext({ actorType: "system", actorId: "create-demo-users", roles: ["system"] }), async (tx) => {
    const r = await tx.execute<{ id: string; slug: string; name: string; kind: string; auth_org_id: string | null }>(sql`SELECT id, slug, name, kind::text AS kind, auth_org_id FROM tenants WHERE slug = ${slug}`);
    return r.rows[0] ?? null;
  });
  if (!tenant) throw new Error(`tenant ${slug} not found; run pnpm db:seed`);
  if (tenant.kind === "agency") throw new Error("use bootstrap-admin for the agency tenant");

  let ownerId: string | null = null;
  const userIds = new Map<string, string>();
  for (const p of plan) {
    let [user] = await authDb.select({ id: betterAuthSchema.user.id }).from(betterAuthSchema.user).where(eq(betterAuthSchema.user.email, p.email));
    if (!user) {
      const created = await auth.api.createUser({ body: { email: p.email, password, name: p.name, role: "user", data: { emailVerified: true } } });
      user = { id: created.user.id };
      console.log(`created ${p.email}`);
    } else {
      const ctx = await auth.$context;
      const hash = await ctx.password.hash(password);
      await ctx.internalAdapter.updatePassword(user.id, hash);
      await authDb.update(betterAuthSchema.user).set({ emailVerified: true }).where(eq(betterAuthSchema.user.id, user.id));
      console.log(`updated password for ${p.email}`);
    }
    userIds.set(p.email, user.id);
    if (p.orgRole === "owner") ownerId = user.id;
  }

  let [org] = tenant.auth_org_id
    ? await authDb.select({ id: betterAuthSchema.organization.id }).from(betterAuthSchema.organization).where(eq(betterAuthSchema.organization.id, tenant.auth_org_id))
    : [];
  if (!org) [org] = await authDb.select({ id: betterAuthSchema.organization.id }).from(betterAuthSchema.organization).where(eq(betterAuthSchema.organization.slug, tenant.slug));
  if (org && !tenant.auth_org_id) {
    await linkOrganizationToTenant({ id: org.id, slug: tenant.slug, name: tenant.name });
    console.log(`linked existing organisation ${org.id} to tenant ${tenant.slug}`);
  }
  if (!org) {
    const created = await auth.api.createOrganization({ body: { name: tenant.name, slug: tenant.slug, userId: ownerId! } });
    if (!created) throw new Error("createOrganization returned nothing");
    org = { id: created.id };
    console.log(`created organisation ${org.id} for ${tenant.slug}`);
  }
  for (const p of plan) {
    const userId = userIds.get(p.email)!;
    const [member] = await authDb.select({ id: betterAuthSchema.member.id, role: betterAuthSchema.member.role }).from(betterAuthSchema.member).where(sql`${betterAuthSchema.member.organizationId} = ${org.id} AND ${betterAuthSchema.member.userId} = ${userId}`);
    if (!member) await auth.api.addMember({ body: { userId, organizationId: org.id, role: p.orgRole } });
    else if (member.role !== p.orgRole) await authDb.update(betterAuthSchema.member).set({ role: p.orgRole }).where(eq(betterAuthSchema.member.id, member.id));
    const sync = await syncMemberships(userId);
    console.log(`${p.email}: ${sync.memberships.map((m) => `${m.slug}=${m.roleKey}`).join(", ") || "no memberships"}`);
  }
  console.log(`done. Sign in with any of the three addresses and the password you provided.`);
} finally {
  await closeAuthDb();
  await db.close();
}
