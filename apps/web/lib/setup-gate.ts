import { timingSafeEqual } from "node:crypto";

/** Minimum length of SBOS_SETUP_TOKEN; shorter values disable the route as if unset. */
export const SETUP_TOKEN_MIN_LENGTH = 32;

export type SetupDecision =
  | { allowed: true }
  | { allowed: false; status: 404 | 401 | 409; reason: string };

/**
 * Access rule for the one-time deployment route POST /api/setup (first superadmin on a fresh database).
 * Pure, so it is unit tested without a database:
 * - no configured token (or a short one): the route does not exist (404) and nothing is revealed;
 * - wrong or missing bearer token: 401 (constant-time comparison);
 * - an admin user already exists: 409, the route is closed for good even with a valid token.
 */
export function decideSetupAccess(input: { configuredToken: string | undefined; authorization: string | null; adminExists: boolean }): SetupDecision {
  const configured = input.configuredToken ?? "";
  if (configured.length < SETUP_TOKEN_MIN_LENGTH) return { allowed: false, status: 404, reason: "setup route is not enabled" };
  const presented = /^Bearer\s+(.+)$/i.exec(input.authorization ?? "")?.[1]?.trim() ?? "";
  const a = Buffer.from(configured);
  const b = Buffer.from(presented);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { allowed: false, status: 401, reason: "invalid setup token" };
  if (input.adminExists) return { allowed: false, status: 409, reason: "an admin user already exists; the setup route is closed. Use invitations from Mission Control." };
  return { allowed: true };
}

export interface SetupBody {
  email: string;
  password: string;
  name?: string;
}

/** Validates the JSON body without a schema library: three string fields, nothing else is read. */
export function parseSetupBody(raw: unknown): { ok: true; body: SetupBody } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "body must be a JSON object" };
  const o = raw as Record<string, unknown>;
  if (typeof o.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email.trim())) return { ok: false, error: "email is required" };
  if (typeof o.password !== "string" || o.password.length < 12) return { ok: false, error: "password must be at least 12 characters" };
  if (o.name !== undefined && (typeof o.name !== "string" || o.name.length > 120)) return { ok: false, error: "name must be a string of at most 120 characters" };
  return { ok: true, body: { email: o.email.trim().toLowerCase(), password: o.password, name: typeof o.name === "string" ? o.name : undefined } };
}
