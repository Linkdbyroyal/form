import { and, desc, eq, sql } from "drizzle-orm";
import { betterAuthSchema } from "@sbos/db/schema";
import type { OperatorContext } from "@sbos/db";
import { getAuthDb } from "../auth-db";
import { getDb } from "../db";

export interface AgencyOrg {
  tenantId: string;
  slug: string;
  name: string;
  orgId: string | null;
}

export interface TeamMember {
  memberId: string;
  userId: string;
  email: string;
  name: string;
  orgRole: string;
  twoFactorEnabled: boolean;
  joinedAt: Date;
}

export interface TeamInvitation {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  inviterEmail: string | null;
}

/** The agency tenant and its Better Auth organisation (operator read, identifiers only). The caller passes the resolved operator context (pages and server actions resolve it differently). */
export async function agencyOrganisation(op: OperatorContext): Promise<AgencyOrg | null> {
  const db = getDb();
  return db.withContext(op, async (tx) => {
    const r = await tx.execute<{ id: string; slug: string; name: string; auth_org_id: string | null }>(sql`SELECT id, slug, name, auth_org_id FROM tenants WHERE kind = 'agency' LIMIT 1`);
    const t = r.rows[0];
    return t ? { tenantId: t.id, slug: t.slug, name: t.name, orgId: t.auth_org_id } : null;
  });
}

export async function listTeamMembers(orgId: string): Promise<TeamMember[]> {
  const authDb = getAuthDb();
  const { member, user } = betterAuthSchema;
  const rows = await authDb
    .select({ memberId: member.id, userId: user.id, email: user.email, name: user.name, orgRole: member.role, twoFactorEnabled: user.twoFactorEnabled, joinedAt: member.createdAt })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, orgId))
    .orderBy(member.createdAt);
  return rows.map((r) => ({ ...r, twoFactorEnabled: Boolean(r.twoFactorEnabled) }));
}

export async function listTeamInvitations(orgId: string): Promise<TeamInvitation[]> {
  const authDb = getAuthDb();
  const { invitation, user } = betterAuthSchema;
  return authDb
    .select({ id: invitation.id, email: invitation.email, role: invitation.role, status: invitation.status, expiresAt: invitation.expiresAt, createdAt: invitation.createdAt, inviterEmail: user.email })
    .from(invitation)
    .leftJoin(user, eq(user.id, invitation.inviterId))
    .where(and(eq(invitation.organizationId, orgId)))
    .orderBy(desc(invitation.createdAt))
    .limit(50);
}
