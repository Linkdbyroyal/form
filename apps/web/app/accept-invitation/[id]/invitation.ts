import { eq } from "drizzle-orm";
import { betterAuthSchema } from "@sbos/db/schema";
import { getAuthDb } from "@/lib/auth-db";

export interface InvitationView {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
  organizationName: string;
  organizationSlug: string;
  accountExists: boolean;
}

/** Server-only read of an invitation through the auth pool (identity data, no tenant content). */
export async function loadInvitation(id: string): Promise<InvitationView | null> {
  const db = getAuthDb();
  const [row] = await db
    .select({
      id: betterAuthSchema.invitation.id,
      email: betterAuthSchema.invitation.email,
      role: betterAuthSchema.invitation.role,
      status: betterAuthSchema.invitation.status,
      expiresAt: betterAuthSchema.invitation.expiresAt,
      organizationName: betterAuthSchema.organization.name,
      organizationSlug: betterAuthSchema.organization.slug
    })
    .from(betterAuthSchema.invitation)
    .innerJoin(betterAuthSchema.organization, eq(betterAuthSchema.organization.id, betterAuthSchema.invitation.organizationId))
    .where(eq(betterAuthSchema.invitation.id, id));
  if (!row) return null;
  const [existing] = await db.select({ id: betterAuthSchema.user.id }).from(betterAuthSchema.user).where(eq(betterAuthSchema.user.email, row.email.toLowerCase()));
  return { ...row, role: row.role ?? "member", accountExists: Boolean(existing) };
}
