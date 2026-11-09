import { loadRootEnv } from "./_env";

/**
 * Dev bootstrap: creates the first superadmin through Better Auth's server API.
 *
 *   SBOS_ADMIN_EMAIL=you@example.com SBOS_ADMIN_PASSWORD='...' pnpm --filter @sbos/web bootstrap-admin
 *
 * Steps: (1) find the agency tenant (seed it first), (2) create the auth user via the admin plugin's
 * createUser (server call, no session: bypasses disableSignUp) with emailVerified = true and role
 * admin, (3) create the agency organisation if missing (system action: hooks link tenants.auth_org_id
 * and mirror the owner membership) or add the owner member, (4) reconcile memberships.
 * The new superadmin must still enable TOTP at /account/security before Mission Control opens.
 */
loadRootEnv();

const email = process.env.SBOS_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.SBOS_ADMIN_PASSWORD;
const name = process.env.SBOS_ADMIN_NAME?.trim() || "Superadmin";
if (!email || !password) {
  console.error("SBOS_ADMIN_EMAIL and SBOS_ADMIN_PASSWORD must be set");
  process.exit(1);
}
if (password.length < 12) {
  console.error("SBOS_ADMIN_PASSWORD must be at least 12 characters");
  process.exit(1);
}

const { sql, eq } = await import("drizzle-orm");
const { operatorContext } = await import("@sbos/db");
const { betterAuthSchema } = await import("@sbos/db/schema");
const { auth } = await import("../lib/auth");
const { getAuthDb, closeAuthDb } = await import("../lib/auth-db");
const { getDb } = await import("../lib/db");
const { syncMemberships } = await import("../lib/auth-bridge");

const db = getDb();
const authDb = getAuthDb();
try {
  const agency = await db.withContext(operatorContext({ actorType: "system", actorId: "bootstrap-admin", roles: ["system"] }), async (tx) => {
    const r = await tx.execute<{ id: string; slug: string; name: string; auth_org_id: string | null }>(sql`SELECT id, slug, name, auth_org_id FROM tenants WHERE kind = 'agency'`);
    return r.rows[0] ?? null;
  });
  if (!agency) throw new Error("No agency tenant found. Run `pnpm db:migrate && pnpm db:seed` first.");

  let [user] = await authDb.select({ id: betterAuthSchema.user.id, emailVerified: betterAuthSchema.user.emailVerified, role: betterAuthSchema.user.role }).from(betterAuthSchema.user).where(eq(betterAuthSchema.user.email, email));
  if (!user) {
    const created = await auth.api.createUser({ body: { email, password, name, role: "admin", data: { emailVerified: true } } });
    user = { id: created.user.id, emailVerified: true, role: "admin" };
    console.log(`created auth user ${user.id} (${email}), emailVerified=true`);
  } else {
    if (!user.emailVerified || user.role !== "admin") {
      await authDb.update(betterAuthSchema.user).set({ emailVerified: true, role: "admin" }).where(eq(betterAuthSchema.user.id, user.id));
    }
    console.log(`auth user ${user.id} (${email}) already exists; ensured emailVerified=true, role=admin`);
  }

  let [org] = await authDb.select({ id: betterAuthSchema.organization.id }).from(betterAuthSchema.organization).where(eq(betterAuthSchema.organization.slug, agency.slug));
  if (!org) {
    if (agency.auth_org_id) throw new Error(`tenant ${agency.slug} points to organisation ${agency.auth_org_id} which does not exist in auth.organization`);
    const created = await auth.api.createOrganization({ body: { name: agency.name, slug: agency.slug, userId: user.id } });
    if (!created) throw new Error("createOrganization returned nothing");
    org = { id: created.id };
    console.log(`created agency organisation ${org.id} (${agency.slug}) and linked it to tenant ${agency.id}`);
  } else {
    const [member] = await authDb
      .select({ id: betterAuthSchema.member.id, role: betterAuthSchema.member.role })
      .from(betterAuthSchema.member)
      .where(sql`${betterAuthSchema.member.organizationId} = ${org.id} AND ${betterAuthSchema.member.userId} = ${user.id}`);
    if (!member) {
      await auth.api.addMember({ body: { userId: user.id, organizationId: org.id, role: "owner" } });
      console.log(`added ${email} as owner of organisation ${org.id}`);
    } else if (member.role !== "owner") {
      await authDb.update(betterAuthSchema.member).set({ role: "owner" }).where(eq(betterAuthSchema.member.id, member.id));
      console.log(`promoted ${email} to owner of organisation ${org.id}`);
    } else {
      console.log(`${email} is already owner of organisation ${org.id}`);
    }
  }

  const sync = await syncMemberships(user.id);
  console.log("memberships:", sync.memberships.map((m) => `${m.slug}=${m.roleKey}`).join(", ") || "none");
  console.log("next step: sign in at /sign-in and enable TOTP at /account/security (required for superadmin).");
} finally {
  await closeAuthDb();
  await db.close();
}
