import { eq, sql } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { agencyContext, operatorContext, writeAudit, type OperatorContext } from "@sbos/db";
import { authBreakGlassTotpReplay } from "@sbos/db/schema";
import { queueNotification, type JobBackend } from "@sbos/core";
import { auth } from "./auth";
import { getAuthDb } from "./auth-db";
import { tenantBySlug } from "./auth-bridge";
import { grantIsActive } from "./auth-policy";
import { canRevokeGrant, expiresAtFor, totpCounter, totpCounterIsFresh, type BreakGlassRequest } from "./break-glass-policy";
import { getDb } from "./db";
import { fmtDate } from "./format";

/**
 * Break-glass service (ADR-017, ticket M1-18). No Next.js request state here: the actor and the request
 * headers come in as arguments, so the server actions in `break-glass.ts` and the tests share one code path.
 *
 * Fresh second factor: `auth.api.verifyTOTP({ body: { code }, headers })` validates a TOTP code for the
 * CURRENT signed-in session (the plugin's signed-in branch; it does not create a session or set cookies).
 * Better Auth keeps no record of used codes, so `verifyFreshTotp` adds a replay guard in
 * `auth.break_glass_totp_replay` keyed on the RFC 6238 time counter. See docs/auth.md.
 */
export interface BreakGlassActor {
  /** Better Auth user id: session subject, `audit_events.actor_id`, replay table key. */
  authUserId: string;
  /** `public.users.id` for the grant row (same id as the auth user unless a seeded row with the same e-mail existed). */
  publicUserId: string;
  roles: readonly string[];
}

export type TotpVerificationResult = { ok: true } | { ok: false; reason: string };
export type TotpVerifier = (input: { userId: string; code: string; headers: HeadersInit }) => Promise<TotpVerificationResult>;

async function betterAuthTotpVerifier(input: { code: string; headers: HeadersInit }): Promise<TotpVerificationResult> {
  try {
    await auth.api.verifyTOTP({ body: { code: input.code }, headers: input.headers });
    return { ok: true };
  } catch (err) {
    if (err instanceof APIError) return { ok: false, reason: err.body?.message ?? "invalid authenticator code" };
    throw err;
  }
}

let totpVerifier: TotpVerifier = betterAuthTotpVerifier;

/** Tests replace the Better Auth check; `null` restores it. Never called by application code. */
export function setTotpVerifierForTests(verifier: TotpVerifier | null): void {
  totpVerifier = verifier ?? betterAuthTotpVerifier;
}

/**
 * Verifies a TOTP code for the signed-in user and refuses replays: the code's time counter must be at least
 * two windows past the last counter this user verified for break-glass (Better Auth accepts neighbouring
 * windows, so one window of distance would still let a code pass twice). The counter is claimed with a
 * conditional upsert, so two concurrent requests with the same code cannot both succeed.
 */
export async function verifyFreshTotp(input: { userId: string; code: string; headers: HeadersInit; now?: Date }): Promise<TotpVerificationResult> {
  const counter = totpCounter(input.now);
  const authDb = getAuthDb();
  const [row] = await authDb.select({ lastCounter: authBreakGlassTotpReplay.lastCounter }).from(authBreakGlassTotpReplay).where(eq(authBreakGlassTotpReplay.userId, input.userId));
  if (!totpCounterIsFresh(counter, row?.lastCounter ?? null)) {
    return { ok: false, reason: "an authenticator code was already used for break-glass less than a minute ago; wait for the next code" };
  }
  const result = await totpVerifier({ userId: input.userId, code: input.code, headers: input.headers });
  if (!result.ok) return result;
  const claimed = await authDb
    .insert(authBreakGlassTotpReplay)
    .values({ userId: input.userId, lastCounter: counter, usedAt: new Date() })
    .onConflictDoUpdate({
      target: authBreakGlassTotpReplay.userId,
      set: { lastCounter: counter, usedAt: new Date() },
      setWhere: sql`${authBreakGlassTotpReplay.lastCounter} <= ${counter - 2}`
    })
    .returning({ userId: authBreakGlassTotpReplay.userId });
  if (claimed.length === 0) return { ok: false, reason: "this authenticator code was just used by another request" };
  return { ok: true };
}

export interface CreatedGrant {
  grantId: string;
  tenantId: string;
  tenantSlug: string;
  expiresAt: Date;
}

/**
 * Creates a time-limited content grant for the actor on one client tenant. Order: tenant lookup, fresh
 * TOTP, then one agency-scoped transaction (RLS allows grant INSERT only in agency scope) that writes the
 * grant, the audit row `break_glass.granted` and queues the Pumble notice `break_glass.granted`.
 */
export async function createBreakGlassGrant(input: { actor: BreakGlassActor; request: BreakGlassRequest; headers: HeadersInit; jobs: JobBackend; now?: Date }): Promise<CreatedGrant> {
  const { actor, request } = input;
  const tenant = await tenantBySlug(request.tenantSlug);
  if (!tenant) throw new Error(`no tenant with slug "${request.tenantSlug}"`);
  if (tenant.kind === "agency") throw new Error("break-glass applies to client tenants only");

  const totp = await verifyFreshTotp({ userId: actor.authUserId, code: request.totpCode, headers: input.headers, now: input.now });
  if (!totp.ok) throw new Error(`second factor not verified: ${totp.reason}`);

  const now = input.now ?? new Date();
  const expiresAt = expiresAtFor(request.durationMinutes, now);
  const ctx = agencyContext({ tenantId: tenant.id, actorType: "user", actorId: actor.authUserId, roles: actor.roles });
  return getDb().withContext(ctx, async (tx) => {
    const existing = await tx.execute<{ id: string; expires_at: Date }>(
      sql`SELECT id, expires_at FROM client_content_grants
          WHERE tenant_id = ${tenant.id}::uuid AND user_id = ${actor.publicUserId}::uuid AND revoked_at IS NULL AND expires_at > now()
          ORDER BY expires_at DESC LIMIT 1`
    );
    const open = existing.rows[0];
    if (open) throw new Error(`you already hold an active grant for this client until ${fmtDate(new Date(open.expires_at))}; revoke it first to request a new one`);

    const ins = await tx.execute<{ id: string }>(
      sql`INSERT INTO client_content_grants (tenant_id, user_id, granted_by, reason, expires_at)
          VALUES (${tenant.id}::uuid, ${actor.publicUserId}::uuid, ${actor.publicUserId}::uuid, ${request.reason}, ${expiresAt.toISOString()}::timestamptz)
          RETURNING id`
    );
    const grantId = ins.rows[0]?.id;
    if (!grantId) throw new Error("grant insert returned nothing");

    await writeAudit(tx, ctx, {
      action: "break_glass.granted",
      entityType: "client_content_grant",
      entityId: grantId,
      after: { tenantId: tenant.id, userId: actor.publicUserId, expiresAt: expiresAt.toISOString() },
      metadata: { tenantSlug: tenant.slug, userId: actor.publicUserId, durationMinutes: request.durationMinutes, expiresAt: expiresAt.toISOString(), reason: request.reason, secondFactor: "totp_fresh" }
    });
    await queueNotification(tx, input.jobs, {
      tenantId: tenant.id,
      channel: "pumble",
      template: "break_glass.granted",
      subject: `Break-glass access granted on ${tenant.slug}`,
      // Identifiers, state and the operator-authored reason. No client content (ADR-018).
      payload: { grantId, tenantSlug: tenant.slug, userId: actor.publicUserId, expiresAt: expiresAt.toISOString(), durationMinutes: request.durationMinutes, reason: request.reason, link: `/mission-control/clients/${tenant.slug}` },
      recipientRole: "superadmin"
    });
    return { grantId, tenantId: tenant.id, tenantSlug: tenant.slug, expiresAt };
  });
}

export interface GrantRow {
  id: string;
  tenantId: string;
  tenantSlug: string;
  userId: string;
  holderName: string | null;
  grantedBy: string;
  reason: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  active: boolean;
}

type RawGrant = {
  id: string;
  tenant_id: string;
  tenant_slug: string;
  user_id: string;
  holder_name: string | null;
  granted_by: string;
  reason: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
};

function toGrantRow(r: RawGrant, now: Date): GrantRow {
  const expiresAt = new Date(r.expires_at);
  const revokedAt = r.revoked_at ? new Date(r.revoked_at) : null;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    tenantSlug: r.tenant_slug,
    userId: r.user_id,
    holderName: r.holder_name,
    grantedBy: r.granted_by,
    reason: r.reason,
    createdAt: new Date(r.created_at),
    expiresAt,
    revokedAt,
    active: grantIsActive({ expiresAt, revokedAt }, now)
  };
}

const GRANT_SELECT = sql`SELECT g.id, g.tenant_id, t.slug AS tenant_slug, g.user_id, u.display_name AS holder_name, g.granted_by, g.reason, g.created_at, g.expires_at, g.revoked_at
  FROM client_content_grants g JOIN tenants t ON t.id = g.tenant_id LEFT JOIN users u ON u.id = g.user_id`;

/** Recent grants for one tenant, newest first. Operator role: metadata read, `users.display_name` is granted. */
export async function listTenantGrants(op: OperatorContext, tenantId: string, limit = 20): Promise<GrantRow[]> {
  const now = new Date();
  return getDb().withContext(op, async (tx) => {
    const r = await tx.execute<RawGrant>(sql`${GRANT_SELECT} WHERE g.tenant_id = ${tenantId}::uuid ORDER BY g.created_at DESC LIMIT ${limit}`);
    return r.rows.map((row) => toGrantRow(row, now));
  });
}

export async function getGrant(op: OperatorContext, grantId: string): Promise<GrantRow | null> {
  const now = new Date();
  return getDb().withContext(op, async (tx) => {
    const r = await tx.execute<RawGrant>(sql`${GRANT_SELECT} WHERE g.id = ${grantId}::uuid`);
    const row = r.rows[0];
    return row ? toGrantRow(row, now) : null;
  });
}

/** The actor's own grant for this tenant that matters for the card: active one first, else the newest. */
export function ownGrantFor(rows: GrantRow[], publicUserId: string): GrantRow | null {
  const own = rows.filter((g) => g.userId === publicUserId);
  return own.find((g) => g.active) ?? own[0] ?? null;
}

/**
 * Revokes an active grant early. Allowed for the holder and for superadmins; writes `break_glass.revoked`
 * audit and notification rows in the same agency-scoped transaction (the UPDATE policy from migration 0004).
 */
export async function revokeBreakGlassGrant(input: { actor: BreakGlassActor; grantId: string; jobs: JobBackend }): Promise<GrantRow> {
  const { actor } = input;
  const op = operatorContext({ actorType: "user", actorId: actor.authUserId, roles: actor.roles });
  const grant = await getGrant(op, input.grantId);
  if (!grant) throw new Error("grant not found");
  if (!canRevokeGrant(actor, grant)) throw new Error("only the grant holder or a superadmin can revoke a grant");
  if (!grant.active) throw new Error(grant.revokedAt ? "grant is already revoked" : "grant has already expired");

  const ctx = agencyContext({ tenantId: grant.tenantId, actorType: "user", actorId: actor.authUserId, roles: actor.roles });
  await getDb().withContext(ctx, async (tx) => {
    const upd = await tx.execute<{ revoked_at: Date }>(
      sql`UPDATE client_content_grants SET revoked_at = now() WHERE id = ${grant.id}::uuid AND revoked_at IS NULL AND expires_at > now() RETURNING revoked_at`
    );
    if (upd.rows.length === 0) throw new Error("grant was revoked or expired by the time this request ran");
    await writeAudit(tx, ctx, {
      action: "break_glass.revoked",
      entityType: "client_content_grant",
      entityId: grant.id,
      before: { revokedAt: null },
      after: { revokedAt: new Date(upd.rows[0]!.revoked_at).toISOString() },
      metadata: { tenantSlug: grant.tenantSlug, holderUserId: grant.userId, revokedBy: actor.publicUserId, byHolder: grant.userId === actor.publicUserId }
    });
    await queueNotification(tx, input.jobs, {
      tenantId: grant.tenantId,
      channel: "pumble",
      template: "break_glass.revoked",
      subject: `Break-glass access revoked on ${grant.tenantSlug}`,
      payload: { grantId: grant.id, tenantSlug: grant.tenantSlug, userId: grant.userId, revokedBy: actor.publicUserId, link: `/mission-control/clients/${grant.tenantSlug}` },
      recipientRole: "superadmin"
    });
  });
  return { ...grant, revokedAt: new Date(), active: false };
}
