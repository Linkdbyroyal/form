import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobBackend } from "@sbos/core";
import { loadRootEnv } from "../scripts/_env";
import { decideTenantAccess, grantIsActive } from "../lib/auth-policy";
import {
  BREAK_GLASS_DEFAULT_MINUTES,
  BREAK_GLASS_MAX_MINUTES,
  BREAK_GLASS_MIN_MINUTES,
  breakGlassRequestSchema,
  canRevokeGrant,
  expiresAtFor,
  totpCounter,
  totpCounterIsFresh
} from "../lib/break-glass-policy";

/**
 * M1-18 tests (ADR-017 break-glass).
 * Unit: request validation (duration bounds), replay rule, revocation rule, access decision with expired
 * or revoked grants. Integration: a dedicated database (`<DATABASE_URL_TEST>_web_bg`), migrations and
 * seed, a superadmin enrolled in TOTP through Better Auth, then the real fresh-TOTP check, grant creation
 * (grant + audit + notification), knowledge_access_logs under a grant, and revocation.
 */
loadRootEnv();
const baseTestUrl = process.env.DATABASE_URL_TEST ?? "postgres://sbos:sbos@localhost:5432/sbos_test";
const testUrl = `${baseTestUrl}_web_bg`;
process.env.DATABASE_URL = testUrl;
process.env.DATABASE_URL_MIGRATE = testUrl;
process.env.DATABASE_URL_AUTH = testUrl;
if (!process.env.BETTER_AUTH_SECRET) process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-0000";
if (!process.env.BETTER_AUTH_URL) process.env.BETTER_AUTH_URL = "http://localhost:3000";
delete process.env.RESEND_API_KEY;

describe("break-glass request validation", () => {
  const valid = { tenantSlug: "northline-events", reason: "Incident INC-42: verify the systems register notes", totpCode: "123456" };

  it("accepts the bounds 15 and 480 minutes and defaults to 120", () => {
    expect(breakGlassRequestSchema.parse({ ...valid, durationMinutes: BREAK_GLASS_MIN_MINUTES }).durationMinutes).toBe(15);
    expect(breakGlassRequestSchema.parse({ ...valid, durationMinutes: "480" }).durationMinutes).toBe(BREAK_GLASS_MAX_MINUTES);
    expect(breakGlassRequestSchema.parse(valid).durationMinutes).toBe(BREAK_GLASS_DEFAULT_MINUTES);
  });
  it("rejects durations outside 15 minutes to 8 hours and non-integers", () => {
    expect(breakGlassRequestSchema.safeParse({ ...valid, durationMinutes: 14 }).success).toBe(false);
    expect(breakGlassRequestSchema.safeParse({ ...valid, durationMinutes: 481 }).success).toBe(false);
    expect(breakGlassRequestSchema.safeParse({ ...valid, durationMinutes: 0 }).success).toBe(false);
    expect(breakGlassRequestSchema.safeParse({ ...valid, durationMinutes: 90.5 }).success).toBe(false);
  });
  it("requires a reason of 10 to 1000 characters and a 6-digit code", () => {
    expect(breakGlassRequestSchema.safeParse({ ...valid, reason: "short" }).success).toBe(false);
    expect(breakGlassRequestSchema.safeParse({ ...valid, reason: "x".repeat(1001) }).success).toBe(false);
    expect(breakGlassRequestSchema.safeParse({ ...valid, totpCode: "12345" }).success).toBe(false);
    expect(breakGlassRequestSchema.safeParse({ ...valid, totpCode: "abcdef" }).success).toBe(false);
    expect(breakGlassRequestSchema.parse({ ...valid, totpCode: " 123 456 " }).totpCode).toBe("123456");
    expect(breakGlassRequestSchema.safeParse({ ...valid, tenantSlug: "Not A Slug" }).success).toBe(false);
  });
  it("computes expiry from the duration", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    expect(expiresAtFor(120, now).toISOString()).toBe("2026-11-09T14:00:00.000Z");
  });
});

describe("break-glass rules", () => {
  it("TOTP replay: a counter must be two windows past the last accepted one", () => {
    expect(totpCounterIsFresh(100, null)).toBe(true);
    expect(totpCounterIsFresh(100, 100)).toBe(false);
    expect(totpCounterIsFresh(101, 100)).toBe(false);
    expect(totpCounterIsFresh(102, 100)).toBe(true);
    expect(totpCounter(new Date(30_000 * 1234))).toBe(1234);
  });
  it("revocation: the holder or a superadmin, nobody else", () => {
    const grant = { userId: "u1" };
    expect(canRevokeGrant({ publicUserId: "u1", roles: ["agency_operator"] }, grant)).toBe(true);
    expect(canRevokeGrant({ publicUserId: "u2", roles: ["superadmin"] }, grant)).toBe(true);
    expect(canRevokeGrant({ publicUserId: "u2", roles: ["agency_operator"] }, grant)).toBe(false);
  });
  it("an expired or revoked grant does not satisfy decideTenantAccess", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    const base = { authenticated: true, tenantRoles: [], twoFactorEnabled: true };
    const expired = grantIsActive({ expiresAt: new Date("2026-11-09T11:59:59Z"), revokedAt: null }, now);
    const revoked = grantIsActive({ expiresAt: new Date("2026-11-09T13:00:00Z"), revokedAt: new Date("2026-11-09T11:00:00Z") }, now);
    const live = grantIsActive({ expiresAt: new Date("2026-11-09T13:00:00Z"), revokedAt: null }, now);
    expect(decideTenantAccess({ ...base, agencyRoles: ["superadmin"], hasActiveGrant: expired })).toEqual({ kind: "forbidden", reason: "operator_without_grant" });
    expect(decideTenantAccess({ ...base, agencyRoles: ["agency_operator"], hasActiveGrant: revoked })).toEqual({ kind: "forbidden", reason: "operator_without_grant" });
    expect(decideTenantAccess({ ...base, agencyRoles: ["agency_operator"], hasActiveGrant: live })).toEqual({ kind: "allow", roles: ["agency_operator"], viaGrant: true });
  });
});

describe("integration: fresh TOTP, grants, access logs, revocation", () => {
  type Mods = {
    auth: typeof import("../lib/auth").auth;
    bridge: typeof import("../lib/auth-bridge");
    service: typeof import("../lib/break-glass-service");
    access: typeof import("../lib/content-access");
    db: ReturnType<typeof import("../lib/db").getDb>;
    closeAuthDb: typeof import("../lib/auth-db").closeAuthDb;
    authDb: ReturnType<typeof import("../lib/auth-db").getAuthDb>;
    schema: typeof import("@sbos/db/schema");
    sbos: typeof import("@sbos/db");
    drizzle: typeof import("drizzle-orm");
  };
  let m: Mods;
  let northlineTenantId: string;
  let adminUserId: string;
  let cookie: string;
  let rawTotpSecret: string;
  const PASSWORD = "correct-horse-battery-staple-42";
  const enqueued: Array<{ name: string; payload: unknown }> = [];
  const jobs: JobBackend = {
    async enqueue(name, payload) {
      enqueued.push({ name, payload });
      return `job-${enqueued.length}`;
    }
  };
  const actor = () => ({ authUserId: adminUserId, publicUserId: adminUserId, roles: ["superadmin"] as const });
  const sysOperator = () => m.sbos.operatorContext({ actorType: "system", actorId: "break-glass-test", roles: ["system"] });

  async function ensureDatabase(): Promise<void> {
    const admin = new pg.Client({ connectionString: baseTestUrl });
    await admin.connect();
    try {
      const name = new URL(testUrl).pathname.slice(1);
      const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
  }

  async function rows<T extends Record<string, unknown>>(query: ReturnType<Mods["drizzle"]["sql"]>): Promise<T[]> {
    return m.db.withContext(sysOperator(), async (tx) => (await tx.execute(query)).rows as T[]);
  }

  function cookieFrom(res: Response): string {
    return res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0] ?? "")
      .filter((c) => c.length > 0 && !c.endsWith("="))
      .join("; ");
  }

  /** RFC 4648 base32 (the otpauth URI encodes the raw secret bytes this way). */
  function base32Decode(input: string): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const ch of input.replace(/=+$/, "").toUpperCase()) {
      const v = alphabet.indexOf(ch);
      if (v < 0) throw new Error(`invalid base32 character ${ch}`);
      bits += v.toString(2).padStart(5, "0");
    }
    const bytes: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    return Buffer.from(bytes).toString("utf8");
  }

  /** A code minted with the plugin's own primitive (`auth.api.generateTOTP`) for the enrolled secret. */
  async function currentCode(): Promise<string> {
    const { code } = await m.auth.api.generateTOTP({ body: { secret: rawTotpSecret } });
    return code;
  }

  beforeAll(async () => {
    await ensureDatabase();
    const sbos = await import("@sbos/db");
    await sbos.resetDatabase(testUrl);
    await sbos.runMigrations(testUrl);
    const seedHandle = sbos.createDb({ connectionString: testUrl, max: 2 });
    const seeded = await sbos.seed(seedHandle);
    await seedHandle.close();
    northlineTenantId = seeded.tenantIds["northline-events"]!;
    const [{ auth }, bridge, service, access, { getDb }, { closeAuthDb, getAuthDb }, schema, drizzle] = await Promise.all([
      import("../lib/auth"),
      import("../lib/auth-bridge"),
      import("../lib/break-glass-service"),
      import("../lib/content-access"),
      import("../lib/db"),
      import("../lib/auth-db"),
      import("@sbos/db/schema"),
      import("drizzle-orm")
    ]);
    m = { auth, bridge, service, access, db: getDb(), closeAuthDb, authDb: getAuthDb(), schema, sbos, drizzle };

    // Superadmin with a verified e-mail, the agency organisation, a session cookie and TOTP enrolment.
    const created = await m.auth.api.createUser({ body: { email: "owner@secondbrain.test", password: PASSWORD, name: "Owner", role: "admin", data: { emailVerified: true } } });
    adminUserId = created.user.id;
    await m.auth.api.createOrganization({ body: { name: "Second Brain AI Agency", slug: "second-brain-agency", userId: adminUserId } });
    const signIn = await m.auth.api.signInEmail({ body: { email: "owner@secondbrain.test", password: PASSWORD }, asResponse: true });
    cookie = cookieFrom(signIn);
    const enabled = await m.auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers: new Headers({ cookie }) });
    if (enabled.method !== "totp") throw new Error("expected TOTP enrolment");
    const secretParam = new URL(enabled.totpURI).searchParams.get("secret");
    if (!secretParam) throw new Error("totpURI without secret");
    rawTotpSecret = base32Decode(secretParam);
    // First verification completes enrolment; Better Auth rotates the session, so take the new cookie.
    const verified = await m.auth.api.verifyTOTP({ body: { code: await currentCode() }, headers: new Headers({ cookie }), asResponse: true });
    const rotated = cookieFrom(verified);
    if (rotated.includes("session_token")) cookie = rotated;
  });

  afterAll(async () => {
    m?.service.setTotpVerifierForTests(null);
    await m?.closeAuthDb();
    await m?.db.close();
  });

  it("the enrolled session is a superadmin with MFA enabled", async () => {
    const session = await m.auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.id).toBe(adminUserId);
    expect(session?.user.twoFactorEnabled).toBe(true);
    const principal = await m.bridge.loadPrincipalData({ id: adminUserId, email: "owner@secondbrain.test", name: "Owner" });
    expect(principal.publicUserId).toBe(adminUserId);
    expect(principal.memberships.map((x) => x.roleKey)).toEqual(["superadmin"]);
    expect(principal.activeGrants).toEqual([]);
  });

  it("real TOTP: a code for the enrolled secret verifies once, a wrong code and a replay are refused", async () => {
    const code = await currentCode();
    const headers = new Headers({ cookie });
    const first = await m.service.verifyFreshTotp({ userId: adminUserId, code, headers });
    expect(first).toEqual({ ok: true });

    const replay = await m.service.verifyFreshTotp({ userId: adminUserId, code, headers });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toMatch(/already used/);

    // Pretend the clock moved on so the replay guard is not what refuses this one: the code itself is wrong.
    const wrong = code === "000000" ? "111111" : "000000";
    const bad = await m.service.verifyFreshTotp({ userId: adminUserId, code: wrong, headers, now: new Date(Date.now() + 10 * 60_000) });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).not.toMatch(/already used/);

    // Without a session cookie the plugin has no subject to verify against.
    const noSession = await m.service.verifyFreshTotp({ userId: adminUserId, code, headers: new Headers(), now: new Date(Date.now() + 10 * 60_000) });
    expect(noSession.ok).toBe(false);

    const replayRows = await m.authDb.select().from(m.schema.authBreakGlassTotpReplay);
    expect(replayRows).toHaveLength(1);
    expect(replayRows[0]).toMatchObject({ userId: adminUserId, lastCounter: totpCounter() });
  });

  let grantId: string;
  it("a grant request writes the grant, the audit event and the Pumble notification", async () => {
    m.service.setTotpVerifierForTests(async () => ({ ok: true }));
    // The real-TOTP test above claimed the current time window; the replay guard runs before the stubbed verifier.
    await m.authDb.delete(m.schema.authBreakGlassTotpReplay);
    const before = Date.now();
    const result = await m.service.createBreakGlassGrant({
      actor: actor(),
      request: { tenantSlug: "northline-events", reason: "Incident INC-42: compare the systems register with the intake", durationMinutes: 120, totpCode: "000000" },
      headers: new Headers({ cookie }),
      jobs
    });
    grantId = result.grantId;
    expect(result.tenantId).toBe(northlineTenantId);
    expect(result.expiresAt.getTime() - before).toBeGreaterThanOrEqual(120 * 60_000 - 5_000);
    expect(result.expiresAt.getTime() - before).toBeLessThanOrEqual(120 * 60_000 + 5_000);

    const grant = await rows<{ user_id: string; granted_by: string; reason: string; revoked_at: Date | null }>(
      m.drizzle.sql`SELECT user_id, granted_by, reason, revoked_at FROM client_content_grants WHERE id = ${grantId}::uuid`
    );
    expect(grant).toEqual([{ user_id: adminUserId, granted_by: adminUserId, reason: "Incident INC-42: compare the systems register with the intake", revoked_at: null }]);

    const audit = await rows<{ tenant_id: string; actor_id: string; entity_id: string; metadata: Record<string, unknown> }>(
      m.drizzle.sql`SELECT tenant_id, actor_id, entity_id, metadata FROM audit_events WHERE action = 'break_glass.granted'`
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tenant_id: northlineTenantId, actor_id: adminUserId, entity_id: grantId });
    expect(audit[0]!.metadata).toMatchObject({ tenantSlug: "northline-events", durationMinutes: 120, secondFactor: "totp_fresh" });

    const notice = await rows<{ tenant_id: string; channel: string; recipient_role: string; payload: Record<string, unknown>; state: string }>(
      m.drizzle.sql`SELECT tenant_id, channel, recipient_role, payload, state FROM notifications WHERE template = 'break_glass.granted'`
    );
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatchObject({ tenant_id: northlineTenantId, channel: "pumble", recipient_role: "superadmin", state: "queued" });
    expect(notice[0]!.payload).toMatchObject({ grantId, tenantSlug: "northline-events", userId: adminUserId, expiresAt: result.expiresAt.toISOString() });
    expect(enqueued).toEqual([{ name: "notify.send", payload: { notificationId: expect.any(String), tenantId: northlineTenantId } }]);
  });

  it("the active grant satisfies decideTenantAccess and a second request is refused while it is active", async () => {
    const principal = await m.bridge.loadPrincipalData({ id: adminUserId, email: "owner@secondbrain.test", name: "Owner" });
    expect(principal.activeGrantTenantIds).toEqual([northlineTenantId]);
    expect(principal.activeGrants[0]).toMatchObject({ id: grantId, tenantId: northlineTenantId });
    const decision = decideTenantAccess({ authenticated: true, tenantRoles: [], agencyRoles: ["superadmin"], twoFactorEnabled: true, hasActiveGrant: principal.activeGrantTenantIds.includes(northlineTenantId) });
    expect(decision).toEqual({ kind: "allow", roles: ["superadmin"], viaGrant: true });

    // Two windows later (so the replay guard passes) the open grant itself is what refuses the request.
    const later = new Date(Date.now() + 2 * 60_000);
    await expect(
      m.service.createBreakGlassGrant({ actor: actor(), request: { tenantSlug: "northline-events", reason: "Second request while active", durationMinutes: 15, totpCode: "000000" }, headers: new Headers({ cookie }), jobs, now: later })
    ).rejects.toThrow(/already hold an active grant/);
  });

  it("a refused second factor creates nothing", async () => {
    m.service.setTotpVerifierForTests(async () => ({ ok: false, reason: "invalid authenticator code" }));
    await m.authDb.delete(m.schema.authBreakGlassTotpReplay);
    await expect(
      m.service.createBreakGlassGrant({ actor: actor(), request: { tenantSlug: "harbour-view-hotel", reason: "Should never be granted, code refused", durationMinutes: 60, totpCode: "000000" }, headers: new Headers({ cookie }), jobs })
    ).rejects.toThrow(/second factor not verified/);
    const grants = await rows<{ n: string }>(m.drizzle.sql`SELECT count(*)::text AS n FROM client_content_grants WHERE user_id = ${adminUserId}::uuid`);
    expect(grants[0]?.n).toBe("1");
    m.service.setTotpVerifierForTests(async () => ({ ok: true }));
  });

  it("an access under the grant writes knowledge_access_logs", async () => {
    const ctx = m.sbos.tenantContext({ tenantId: northlineTenantId, actorType: "user", actorId: adminUserId, roles: ["superadmin"] });
    await m.access.logContentAccess(ctx, grantId, "page", "/c/northline-events");
    const logs = await rows<{ actor_type: string; actor_id: string; grant_id: string; resource_type: string; resource_id: string; purpose: string }>(
      m.drizzle.sql`SELECT actor_type, actor_id, grant_id, resource_type, resource_id, purpose FROM knowledge_access_logs WHERE tenant_id = ${northlineTenantId}::uuid`
    );
    expect(logs).toEqual([{ actor_type: "user", actor_id: adminUserId, grant_id: grantId, resource_type: "page", resource_id: "/c/northline-events", purpose: "break_glass" }]);
  });

  it("lists the tenant's grants with the holder's display name", async () => {
    const op = m.sbos.operatorContext({ actorType: "user", actorId: adminUserId, roles: ["superadmin"] });
    const list = await m.service.listTenantGrants(op, northlineTenantId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: grantId, holderName: "Owner", tenantSlug: "northline-events", active: true, revokedAt: null });
    expect(m.service.ownGrantFor(list, adminUserId)?.id).toBe(grantId);
    expect(m.service.ownGrantFor(list, "00000000-0000-0000-0000-000000000009")).toBeNull();
  });

  it("only the holder or a superadmin can revoke; revocation writes audit and notification and ends access", async () => {
    const stranger = { authUserId: adminUserId, publicUserId: "00000000-0000-0000-0000-000000000009", roles: ["agency_operator"] as const };
    await expect(m.service.revokeBreakGlassGrant({ actor: stranger, grantId, jobs })).rejects.toThrow(/only the grant holder or a superadmin/);

    const revoked = await m.service.revokeBreakGlassGrant({ actor: { ...actor(), roles: ["agency_operator"] }, grantId, jobs });
    expect(revoked.active).toBe(false);
    const grant = await rows<{ revoked_at: Date | null }>(m.drizzle.sql`SELECT revoked_at FROM client_content_grants WHERE id = ${grantId}::uuid`);
    expect(grant[0]?.revoked_at).not.toBeNull();

    const audit = await rows<{ metadata: Record<string, unknown> }>(m.drizzle.sql`SELECT metadata FROM audit_events WHERE action = 'break_glass.revoked' AND entity_id = ${grantId}`);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ byHolder: true, revokedBy: adminUserId });
    const notice = await rows<{ payload: Record<string, unknown> }>(m.drizzle.sql`SELECT payload FROM notifications WHERE template = 'break_glass.revoked'`);
    expect(notice).toHaveLength(1);
    expect(notice[0]!.payload).toMatchObject({ grantId, tenantSlug: "northline-events" });
    expect(enqueued.filter((e) => e.name === "notify.send")).toHaveLength(2);

    await expect(m.service.revokeBreakGlassGrant({ actor: actor(), grantId, jobs })).rejects.toThrow(/already revoked/);

    const principal = await m.bridge.loadPrincipalData({ id: adminUserId, email: "owner@secondbrain.test", name: "Owner" });
    expect(principal.activeGrantTenantIds).toEqual([]);
    expect(decideTenantAccess({ authenticated: true, tenantRoles: [], agencyRoles: ["superadmin"], twoFactorEnabled: true, hasActiveGrant: false })).toEqual({ kind: "forbidden", reason: "operator_without_grant" });
  });

  it("an expired grant is not active and cannot be revoked", async () => {
    const ctx = m.sbos.agencyContext({ tenantId: northlineTenantId, actorType: "user", actorId: adminUserId, roles: ["superadmin"] });
    const inserted = await m.db.withContext(ctx, async (tx) =>
      (
        await tx.execute<{ id: string }>(
          m.drizzle.sql`INSERT INTO client_content_grants (tenant_id, user_id, granted_by, reason, expires_at)
            VALUES (${northlineTenantId}::uuid, ${adminUserId}::uuid, ${adminUserId}::uuid, 'Expired grant for the test', now() - interval '1 minute') RETURNING id`
        )
      ).rows[0]!.id
    );
    const principal = await m.bridge.loadPrincipalData({ id: adminUserId, email: "owner@secondbrain.test", name: "Owner" });
    expect(principal.activeGrantTenantIds).toEqual([]);
    await expect(m.service.revokeBreakGlassGrant({ actor: actor(), grantId: inserted, jobs })).rejects.toThrow(/already expired/);
    const op = m.sbos.operatorContext({ actorType: "user", actorId: adminUserId, roles: ["superadmin"] });
    const list = await m.service.listTenantGrants(op, northlineTenantId);
    expect(list.map((g) => g.active)).toEqual([false, false]);
  });
});
