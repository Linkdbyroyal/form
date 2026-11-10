"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { DESCRIPTORS, isProvider } from "@sbos/connectors";
import { schema, type TenantContext } from "@sbos/db";
import { grantConsent, proposeConnection, revokeConsent } from "@sbos/core";
import { getDb } from "../db";
import { errorMessage, withNotice } from "../format";
import { getPrincipal, requireTenantContext, type ResolvedTenant } from "../request-context";
import { isValidSyncInterval, scopesForPhase, SYNC_INTERVAL_MAX, SYNC_INTERVAL_MIN } from "./integration-helpers";

/**
 * Integration Center write actions (M5, ADR-011/021): propose a connection, grant consent, revoke consent. Each action
 * resolves the tenant context from the session, requires client_admin (never a break-glass grant), and calls the
 * @sbos/core service inside `withContext()`. The database trigger `enforce_connection_phase` is the real gate: a
 * refusal from Postgres is shown through `?error=` on the redirect. Security review and phase advance are agency
 * decisions and live in Mission Control (`lib/mission-control/tools-actions.ts`).
 */
const { systems } = schema;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}

function uuid(form: FormData, name: string): string {
  const v = text(form, name);
  if (!UUID_RE.test(v)) throw new Error(`${name} must be a UUID`);
  return v;
}

interface Resolved {
  slug: string;
  access: ResolvedTenant;
  ctx: TenantContext;
  publicUserId: string;
}

async function resolveWrite(form: FormData): Promise<Resolved> {
  const slug = text(form, "slug");
  if (!SLUG_RE.test(slug)) throw new Error("invalid workspace");
  const access = await requireTenantContext(slug);
  if (!access) throw new Error("workspace not found");
  if (access.viaGrant) throw new Error("a break-glass grant is read-only; consent is a decision of the client's own admin");
  if (!access.ctx.roles.includes("client_admin")) throw new Error(`this decision requires the client_admin role; your roles: ${access.ctx.roles.join(", ") || "none"}`);
  const principal = await getPrincipal();
  if (!principal) throw new Error("not signed in");
  return { slug, access, ctx: access.ctx, publicUserId: principal.data.publicUserId };
}

function safeReturn(form: FormData, fallback: string): string {
  const requested = text(form, "returnTo");
  return requested.startsWith("/") && !requested.startsWith("//") ? requested : fallback;
}

function isRedirect(err: unknown): boolean {
  return typeof err === "object" && err !== null && "digest" in err && typeof (err as { digest?: unknown }).digest === "string" && (err as { digest: string }).digest.startsWith("NEXT_REDIRECT");
}

function finish(slug: string | null, returnTo: string, outcome: { ok?: string; error?: string }): never {
  revalidatePath(returnTo.split("?")[0] ?? returnTo);
  if (slug) for (const p of ["/integrations", "/dashboard", "/x-ray"]) revalidatePath(`/c/${slug}${p}`);
  revalidatePath("/mission-control/tools");
  redirect(withNotice(returnTo, outcome));
}

function fallbackReturn(form: FormData): string {
  const slugGuess = text(form, "slug");
  return safeReturn(form, SLUG_RE.test(slugGuess) ? `/c/${slugGuess}/integrations` : "/");
}

/** Client admin proposes a connection for a registered system: phase metadata, consent pending, nothing is read. */
export async function proposeConnectionAction(form: FormData): Promise<void> {
  const returnTo = fallbackReturn(form);
  let outcome: { ok?: string; error?: string };
  try {
    const { slug, ctx } = await resolveWrite(form);
    const systemId = uuid(form, "systemId");
    const provider = text(form, "provider");
    if (!isProvider(provider)) throw new Error(`provider must be one of ${Object.keys(DESCRIPTORS).join(", ")}`);
    const interval = Number(text(form, "syncIntervalMinutes") || "60");
    if (!isValidSyncInterval(interval)) throw new Error(`sync interval must be a whole number of minutes between ${SYNC_INTERVAL_MIN} and ${SYNC_INTERVAL_MAX}`);
    const reason = text(form, "reason").slice(0, 1000);
    const displayName = DESCRIPTORS[provider].displayName;
    await getDb().withContext(ctx, async (tx) => {
      const [sys] = await tx.select({ id: systems.id, name: systems.name }).from(systems).where(and(eq(systems.id, systemId), eq(systems.tenantId, ctx.tenantId)));
      if (!sys) throw new Error("system not found in this workspace");
      await proposeConnection(tx, ctx, { tenantId: ctx.tenantId, provider, systemId: sys.id, syncIntervalMinutes: interval, reason: reason || `proposed from the Integration Center for ${sys.name}` });
    });
    outcome = { ok: `${displayName} connection proposed in phase metadata. Nothing is read until you grant consent, the agency records a security review and advances the phase to read-only.` };
    return finish(slug, returnTo, outcome);
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(null, returnTo, outcome);
}

/** Client admin grants read-only consent with named scopes and a reason. The trigger records who and when. */
export async function grantConsentAction(form: FormData): Promise<void> {
  const returnTo = fallbackReturn(form);
  let outcome: { ok?: string; error?: string };
  try {
    const { slug, ctx, publicUserId } = await resolveWrite(form);
    const connectionId = uuid(form, "connectionId");
    const provider = text(form, "provider");
    if (!isProvider(provider)) throw new Error("unknown provider");
    const allowed = new Set(scopesForPhase(DESCRIPTORS[provider], "read_only").map((s) => s.scope));
    const scopes = form.getAll("scopes").filter((v): v is string => typeof v === "string" && allowed.has(v));
    if (scopes.length === 0) throw new Error("tick at least one scope; consent is recorded per scope");
    const reason = text(form, "reason").slice(0, 2000);
    if (reason.length < 10) throw new Error("record why or on what basis consent is given (at least 10 characters)");
    if (text(form, "acknowledge") !== "yes") throw new Error("confirm that you understand this grants read-only access that can be revoked at any time");
    await getDb().withContext(ctx, (tx) => grantConsent(tx, ctx, { tenantId: ctx.tenantId, connectionId, scopes, reason, userId: publicUserId }));
    outcome = { ok: `Consent granted for ${scopes.join(", ")}. The connection stays in phase metadata until the agency records a security review and advances it to read-only; nothing is read before that.` };
    return finish(slug, returnTo, outcome);
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(null, returnTo, outcome);
}

/** Client admin revokes consent: the trigger drops the phase to metadata and pauses; dependent KPIs become missing_source. */
export async function revokeConsentAction(form: FormData): Promise<void> {
  const returnTo = fallbackReturn(form);
  let outcome: { ok?: string; error?: string };
  try {
    const { slug, ctx } = await resolveWrite(form);
    const connectionId = uuid(form, "connectionId");
    const reason = text(form, "reason").slice(0, 500);
    if (reason.length < 3) throw new Error("give a short reason for the revocation");
    const result = await getDb().withContext(ctx, (tx) => revokeConsent(tx, ctx, { tenantId: ctx.tenantId, connectionId, reason }));
    outcome = { ok: `Consent revoked. The connection is back in phase metadata and paused; ${result.kpisMarked} KPI(s) fed by it are now marked missing_source.` };
    return finish(slug, returnTo, outcome);
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(null, returnTo, outcome);
}
