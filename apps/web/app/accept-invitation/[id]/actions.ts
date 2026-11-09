"use server";

import { auth } from "@/lib/auth";
import { loadInvitation } from "./invitation";

export type CreateAccountResult = { ok: true } | { ok: false; error: string };

/**
 * Invitation-only onboarding: public sign-up is disabled, so the invitee's account is created here,
 * server-side, only for a pending, unexpired invitation and only for the invited address. The account
 * starts unverified; a verification mail is sent whose link returns to this invitation.
 */
export async function createAccountFromInvitation(input: { invitationId: string; name: string; password: string }): Promise<CreateAccountResult> {
  const inv = await loadInvitation(input.invitationId);
  if (!inv) return { ok: false, error: "Invitation not found" };
  if (inv.status !== "pending") return { ok: false, error: `Invitation is ${inv.status}` };
  if (inv.expiresAt.getTime() < Date.now()) return { ok: false, error: "Invitation has expired" };
  if (inv.accountExists) return { ok: false, error: "An account already exists for this address; sign in instead" };
  const name = input.name.trim();
  if (name.length < 2) return { ok: false, error: "Name is required" };
  if (input.password.length < 12) return { ok: false, error: "Password must be at least 12 characters" };
  try {
    await auth.api.createUser({ body: { email: inv.email, password: input.password, name } });
    await auth.api.sendVerificationEmail({ body: { email: inv.email, callbackURL: `/accept-invitation/${inv.id}` } });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
