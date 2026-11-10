"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { agencyContext, writeAudit } from "@sbos/db";
import { betterAuthSchema } from "@sbos/db/schema";
import { getAuthDb } from "../auth-db";
import { getDb } from "../db";
import { errorMessage, withNotice } from "../format";
import { sendMail } from "../mailer";
import { getSession, requireOperatorContext } from "../request-context";
import { canManageTeam, inviteNotice, parseInvite, roleKeyFor } from "./team-helpers";
import { agencyOrganisation } from "./team-queries";

const RETURN_TO = "/mission-control/team";

/**
 * Invites a colleague into the agency organisation. Superadmin only. Writes the invitation row in the shape
 * Better Auth expects (the existing /accept-invitation/[id] page creates the account for that address and the
 * bridge mirrors the organisation role into `memberships`), sends the mail through the mailer and audits it.
 */
export async function inviteAgencyMemberAction(form: FormData): Promise<void> {
  let outcome: { ok?: string; error?: string };
  try {
    const op = await requireOperatorContext();
    if (!canManageTeam(op.roles)) throw new Error("only a superadmin can invite agency team members");
    const session = await getSession();
    if (!session) throw new Error("not signed in");
    const parsed = parseInvite({ email: form.get("email"), role: form.get("role") });
    if (!parsed.ok) throw new Error(parsed.error);
    const agency = await agencyOrganisation(op);
    if (!agency?.orgId) throw new Error("the agency organisation is not linked yet; run the superadmin bootstrap first");

    const authDb = getAuthDb();
    const { member, user, invitation } = betterAuthSchema;
    const [existing] = await authDb.select({ id: member.id }).from(member).innerJoin(user, eq(user.id, member.userId)).where(and(eq(member.organizationId, agency.orgId), eq(user.email, parsed.email)));
    if (existing) throw new Error(`${parsed.email} is already a member of the agency organisation`);
    const [pending] = await authDb.select({ id: invitation.id }).from(invitation).where(and(eq(invitation.organizationId, agency.orgId), eq(invitation.email, parsed.email), eq(invitation.status, "pending")));
    if (pending) throw new Error(`${parsed.email} already has a pending invitation; revoke it first to send a new one`);

    const invitationId = randomUUID();
    const expiresAt = new Date(Date.now() + 72 * 3_600_000);
    await authDb.insert(invitation).values({ id: invitationId, organizationId: agency.orgId, email: parsed.email, role: parsed.role, status: "pending", expiresAt, createdAt: new Date(), inviterId: session.user.id });
    const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
    const acceptUrl = `${baseUrl}/accept-invitation/${invitationId}`;
    const roleKey = roleKeyFor(parsed.role) ?? parsed.role;
    const delivery = await sendMail({
      to: parsed.email,
      subject: `Second Brain Business OS: invitation to ${agency.name}`,
      text: `${session.user.name || session.user.email} invited you to join ${agency.name} as ${roleKey}.\n\nAccept the invitation here:\n${acceptUrl}\n\nThe invitation expires in 72 hours. You create your account on that page; public sign-up is disabled.`
    });
    const ctx = agencyContext({ tenantId: agency.tenantId, actorType: "user", actorId: op.actorId, roles: op.roles });
    await getDb().withContext(ctx, (tx) => writeAudit(tx, ctx, { action: "auth.invitation.created", entityType: "invitation", entityId: invitationId, after: { role: parsed.role, roleKey, expiresAt: expiresAt.toISOString() }, metadata: { delivery: delivery.channel, organizationId: agency.orgId, scope: "agency_team" } }));
    outcome = { ok: inviteNotice({ email: parsed.email, roleKey, delivery: delivery.channel === "resend" ? "resend" : "console", acceptUrl }) };
  } catch (err) {
    outcome = { error: errorMessage(err) };
  }
  revalidatePath(RETURN_TO);
  redirect(withNotice(RETURN_TO, outcome));
}

/** Revokes a pending invitation (status canceled). Superadmin only. */
export async function revokeInvitationAction(form: FormData): Promise<void> {
  let outcome: { ok?: string; error?: string };
  try {
    const op = await requireOperatorContext();
    if (!canManageTeam(op.roles)) throw new Error("only a superadmin can revoke invitations");
    const id = String(form.get("invitationId") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("invitation id is invalid");
    const agency = await agencyOrganisation(op);
    if (!agency?.orgId) throw new Error("the agency organisation is not linked");
    const authDb = getAuthDb();
    const { invitation } = betterAuthSchema;
    const updated = await authDb.update(invitation).set({ status: "canceled" }).where(and(eq(invitation.id, id), eq(invitation.organizationId, agency.orgId), eq(invitation.status, "pending"))).returning({ email: invitation.email });
    if (updated.length === 0) throw new Error("no pending invitation with that id in the agency organisation");
    const ctx = agencyContext({ tenantId: agency.tenantId, actorType: "user", actorId: op.actorId, roles: op.roles });
    await getDb().withContext(ctx, (tx) => writeAudit(tx, ctx, { action: "auth.invitation.revoked", entityType: "invitation", entityId: id, metadata: { organizationId: agency.orgId, scope: "agency_team" } }));
    outcome = { ok: `Invitation for ${updated[0]!.email} revoked.` };
  } catch (err) {
    outcome = { error: errorMessage(err) };
  }
  revalidatePath(RETURN_TO);
  redirect(withNotice(RETURN_TO, outcome));
}

/**
 * Marks the e-mail address of an account created from a pending agency invitation as verified. Superadmin only,
 * audited as an attestation: meant for deployments without a mail provider, where the verification link is only
 * logged. The invitee still signs in with their own password and accepts the invitation themselves.
 */
export async function attestInvitedEmailAction(form: FormData): Promise<void> {
  let outcome: { ok?: string; error?: string };
  try {
    const op = await requireOperatorContext();
    if (!canManageTeam(op.roles)) throw new Error("only a superadmin can attest an invited e-mail address");
    const id = String(form.get("invitationId") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("invitation id is invalid");
    const agency = await agencyOrganisation(op);
    if (!agency?.orgId) throw new Error("the agency organisation is not linked");
    const authDb = getAuthDb();
    const { invitation, user } = betterAuthSchema;
    const [inv] = await authDb.select({ email: invitation.email, status: invitation.status, expiresAt: invitation.expiresAt }).from(invitation).where(and(eq(invitation.id, id), eq(invitation.organizationId, agency.orgId)));
    if (!inv || inv.status !== "pending" || inv.expiresAt.getTime() < Date.now()) throw new Error("no pending, unexpired invitation with that id in the agency organisation");
    const updated = await authDb.update(user).set({ emailVerified: true, updatedAt: new Date() }).where(and(eq(sql`lower(${user.email})`, inv.email.toLowerCase()), eq(user.emailVerified, false))).returning({ id: user.id });
    if (updated.length === 0) throw new Error(`no unverified account exists for ${inv.email}; the invitee creates it first through the invitation link`);
    const ctx = agencyContext({ tenantId: agency.tenantId, actorType: "user", actorId: op.actorId, roles: op.roles });
    await getDb().withContext(ctx, (tx) => writeAudit(tx, ctx, { action: "auth.email.attested", entityType: "auth_user", entityId: updated[0]!.id, after: { emailVerified: true }, metadata: { invitationId: id, organizationId: agency.orgId, reason: "no mail provider; superadmin attestation" } }));
    outcome = { ok: `E-mail address of ${inv.email} marked as verified. The invitee can now sign in and accept the invitation.` };
  } catch (err) {
    outcome = { error: errorMessage(err) };
  }
  revalidatePath(RETURN_TO);
  redirect(withNotice(RETURN_TO, outcome));
}
