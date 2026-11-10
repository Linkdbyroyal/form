import { eq, sql } from "drizzle-orm";
import { operatorContext } from "@sbos/db";
import { betterAuthSchema } from "@sbos/db/schema";
import { auth } from "./auth";
import { getAuthDb } from "./auth-db";
import { syncMemberships } from "./auth-bridge";
import { getDb } from "./db";

export interface BootstrapInput {
  email: string;
  password: string;
  name?: string;
}

export interface BootstrapResult {
  userId: string;
  organizationId: string;
  agencySlug: string;
  memberships: string[];
}

/**
 * Creates (or repairs) the first superadmin through Better Auth's server API. Shared by the development script
 * `scripts/bootstrap-admin.ts` and the one-time deployment route `POST /api/setup`.
 *
 * Steps: (1) find the agency tenant (the seed creates it), (2) create the auth user with the admin plugin's
 * createUser (server call, no session: bypasses disableSignUp) with emailVerified = true and role admin,
 * (3) create the agency organisation if missing (hooks link tenants.auth_org_id and mirror the owner membership)
 * or add the owner member, (4) reconcile memberships. The superadmin must still enable TOTP at
 * /account/security before Mission Control opens (ADR-015).
 */
export async function bootstrapSuperadmin(input: BootstrapInput, log: (msg: string) => void = () => {}): Promise<BootstrapResult> {
  const email = input.email.trim().toLowerCase();
  const name = input.name?.trim() || "Superadmin";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("email is not valid");
  if (input.password.length < 12) throw new Error("password must be at least 12 characters");

  const db = getDb();
  const authDb = getAuthDb();
  const agency = await db.withContext(operatorContext({ actorType: "system", actorId: "bootstrap-admin", roles: ["system"] }), async (tx) => {
    const r = await tx.execute<{ id: string; slug: string; name: string; auth_org_id: string | null }>(sql`SELECT id, slug, name, auth_org_id FROM tenants WHERE kind = 'agency'`);
    return r.rows[0] ?? null;
  });
  if (!agency) throw new Error("No agency tenant found. Run the seed first (pnpm db:seed, or SBOS_SEED_ON_START=1 on the worker).");

  let [user] = await authDb.select({ id: betterAuthSchema.user.id, emailVerified: betterAuthSchema.user.emailVerified, role: betterAuthSchema.user.role }).from(betterAuthSchema.user).where(eq(betterAuthSchema.user.email, email));
  if (!user) {
    const created = await auth.api.createUser({ body: { email, password: input.password, name, role: "admin", data: { emailVerified: true } } });
    user = { id: created.user.id, emailVerified: true, role: "admin" };
    log(`created auth user ${user.id}, emailVerified=true`);
  } else {
    if (!user.emailVerified || user.role !== "admin") {
      await authDb.update(betterAuthSchema.user).set({ emailVerified: true, role: "admin" }).where(eq(betterAuthSchema.user.id, user.id));
    }
    log(`auth user ${user.id} already exists; ensured emailVerified=true, role=admin`);
  }

  let [org] = await authDb.select({ id: betterAuthSchema.organization.id }).from(betterAuthSchema.organization).where(eq(betterAuthSchema.organization.slug, agency.slug));
  if (!org) {
    if (agency.auth_org_id) throw new Error(`tenant ${agency.slug} points to organisation ${agency.auth_org_id} which does not exist in auth.organization`);
    const created = await auth.api.createOrganization({ body: { name: agency.name, slug: agency.slug, userId: user.id } });
    if (!created) throw new Error("createOrganization returned nothing");
    org = { id: created.id };
    log(`created agency organisation ${org.id} (${agency.slug}) and linked it to tenant ${agency.id}`);
  } else {
    const [member] = await authDb
      .select({ id: betterAuthSchema.member.id, role: betterAuthSchema.member.role })
      .from(betterAuthSchema.member)
      .where(sql`${betterAuthSchema.member.organizationId} = ${org.id} AND ${betterAuthSchema.member.userId} = ${user.id}`);
    if (!member) {
      await auth.api.addMember({ body: { userId: user.id, organizationId: org.id, role: "owner" } });
      log(`added the user as owner of organisation ${org.id}`);
    } else if (member.role !== "owner") {
      await authDb.update(betterAuthSchema.member).set({ role: "owner" }).where(eq(betterAuthSchema.member.id, member.id));
      log(`promoted the user to owner of organisation ${org.id}`);
    } else {
      log(`the user is already owner of organisation ${org.id}`);
    }
  }

  const sync = await syncMemberships(user.id);
  const memberships = sync.memberships.map((m) => `${m.slug}=${m.roleKey}`);
  log(`memberships: ${memberships.join(", ") || "none"}`);
  return { userId: user.id, organizationId: org.id, agencySlug: agency.slug, memberships };
}

/** True when any Better Auth user already holds the admin role (the setup route then refuses). */
export async function adminUserExists(): Promise<boolean> {
  const authDb = getAuthDb();
  const [row] = await authDb.select({ id: betterAuthSchema.user.id }).from(betterAuthSchema.user).where(eq(betterAuthSchema.user.role, "admin")).limit(1);
  return Boolean(row);
}
