"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { breakGlassRequestSchema, breakGlassRevokeSchema, formatZodError, type BreakGlassRequestInput } from "./break-glass-policy";
import { createBreakGlassGrant, revokeBreakGlassGrant, type BreakGlassActor } from "./break-glass-service";
import { errorMessage, withNotice } from "./format";
import { getJobs } from "./jobs";
import { getPrincipal, requireOperatorContext } from "./request-context";

/**
 * Break-glass server actions (ADR-017, ticket M1-18). The actor comes from `requireOperatorContext()`
 * (superadmin or agency_operator with MFA satisfied); the request headers carry the session cookie that
 * `auth.api.verifyTOTP` needs for the fresh second-factor check. Outcomes travel through `?ok=` / `?error=`
 * like the other operator actions; a successful request lands in the client workspace.
 */
async function currentActor(): Promise<BreakGlassActor> {
  const op = await requireOperatorContext();
  const p = await getPrincipal();
  if (!p) redirect("/sign-in?next=%2Fmission-control");
  return { authUserId: op.actorId, publicUserId: p.data.publicUserId, roles: op.roles };
}

function safeReturnTo(value: string | undefined, fallback: string): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : fallback;
}

function finish(returnTo: string, outcome: { ok?: string; error?: string }): never {
  revalidatePath(returnTo.split("?")[0] ?? returnTo);
  redirect(withNotice(returnTo, outcome));
}

export async function requestBreakGlass(input: BreakGlassRequestInput & { returnTo?: string }): Promise<void> {
  const slugForReturn = typeof input.tenantSlug === "string" && /^[a-z0-9-]{1,64}$/.test(input.tenantSlug) ? input.tenantSlug : null;
  const returnTo = safeReturnTo(input.returnTo, slugForReturn ? `/mission-control/clients/${slugForReturn}` : "/mission-control/clients");
  const actor = await currentActor();
  const parsed = breakGlassRequestSchema.safeParse(input);
  if (!parsed.success) finish(returnTo, { error: formatZodError(parsed.error) });
  let slug: string;
  try {
    const result = await createBreakGlassGrant({ actor, request: parsed.data, headers: await headers(), jobs: await getJobs() });
    slug = result.tenantSlug;
  } catch (err) {
    finish(returnTo, { error: errorMessage(err) });
  }
  revalidatePath(`/mission-control/clients/${slug}`);
  revalidatePath(`/c/${slug}`);
  redirect(`/c/${slug}`);
}

/** Form wrapper: reason, durationMinutes, totpCode, tenantSlug, returnTo. An empty duration means the default. */
export async function requestBreakGlassAction(form: FormData): Promise<void> {
  const text = (name: string): string | undefined => {
    const v = form.get(name);
    return typeof v === "string" && v.trim().length > 0 ? v : undefined;
  };
  await requestBreakGlass({
    tenantSlug: text("tenantSlug") ?? "",
    reason: text("reason") ?? "",
    durationMinutes: text("durationMinutes"),
    totpCode: text("totpCode") ?? "",
    returnTo: text("returnTo")
  });
}

export async function revokeBreakGlass(grantId: string, returnTo?: string): Promise<void> {
  const target = safeReturnTo(returnTo, "/mission-control/clients");
  const actor = await currentActor();
  const parsed = breakGlassRevokeSchema.safeParse({ grantId });
  if (!parsed.success) finish(target, { error: formatZodError(parsed.error) });
  let outcome: { ok?: string; error?: string };
  try {
    const grant = await revokeBreakGlassGrant({ actor, grantId: parsed.data.grantId, jobs: await getJobs() });
    revalidatePath(`/c/${grant.tenantSlug}`);
    outcome = { ok: `Grant ${grant.id.slice(0, 8)} on ${grant.tenantSlug} revoked. Content access ends now; the revocation is audited and announced on Pumble.` };
  } catch (err) {
    outcome = { error: errorMessage(err) };
  }
  finish(target, outcome);
}

export async function revokeBreakGlassAction(form: FormData): Promise<void> {
  const grantId = form.get("grantId");
  const returnTo = form.get("returnTo");
  await revokeBreakGlass(typeof grantId === "string" ? grantId : "", typeof returnTo === "string" ? returnTo : undefined);
}
