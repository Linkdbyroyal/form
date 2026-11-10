import { and, eq, gt, sql } from "drizzle-orm";
import { betterAuthSchema } from "@sbos/db/schema";
import { getAuthDb } from "./auth-db";

export interface PendingInvitation {
  id: string;
  organizationName: string;
  organizationSlug: string;
  role: string | null;
  expiresAt: Date;
}

/** Pending, unexpired invitations for an e-mail address (identity data, shown to that signed-in user only). */
export async function pendingInvitationsFor(email: string): Promise<PendingInvitation[]> {
  const authDb = getAuthDb();
  const { invitation, organization } = betterAuthSchema;
  return authDb
    .select({ id: invitation.id, organizationName: organization.name, organizationSlug: organization.slug, role: invitation.role, expiresAt: invitation.expiresAt })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(and(eq(sql`lower(${invitation.email})`, email.toLowerCase()), eq(invitation.status, "pending"), gt(invitation.expiresAt, new Date())))
    .orderBy(invitation.createdAt);
}
