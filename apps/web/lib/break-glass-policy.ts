import { z } from "zod";

/**
 * Break-glass rules without I/O (ADR-017, ticket M1-18). Validation, limits and the revocation rule
 * live here so they are unit-tested directly and shared by the server actions and the service.
 */
export const BREAK_GLASS_MIN_MINUTES = 15;
export const BREAK_GLASS_MAX_MINUTES = 8 * 60;
export const BREAK_GLASS_DEFAULT_MINUTES = 120;

/** Options offered by the duration select; every value is inside the bounds above. */
export const BREAK_GLASS_DURATION_OPTIONS: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 15, label: "15 minutes" },
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 120, label: "2 hours (default)" },
  { minutes: 240, label: "4 hours" },
  { minutes: 480, label: "8 hours (maximum)" }
];

/** TOTP period the Better Auth twoFactor plugin is configured with (plugin default). */
export const TOTP_PERIOD_SECONDS = 30;

export const breakGlassRequestSchema = z.object({
  tenantSlug: z.string().regex(/^[a-z0-9-]{1,64}$/, "tenant slug must be lowercase letters, digits and dashes"),
  reason: z.string().trim().min(10, "reason must be at least 10 characters").max(1000, "reason must be at most 1000 characters"),
  durationMinutes: z.coerce
    .number()
    .int("duration must be whole minutes")
    .min(BREAK_GLASS_MIN_MINUTES, `duration must be at least ${BREAK_GLASS_MIN_MINUTES} minutes`)
    .max(BREAK_GLASS_MAX_MINUTES, `duration must be at most ${BREAK_GLASS_MAX_MINUTES} minutes (8 hours)`)
    .default(BREAK_GLASS_DEFAULT_MINUTES),
  totpCode: z
    .string()
    .trim()
    .transform((v) => v.replace(/\s+/g, ""))
    .pipe(z.string().regex(/^\d{6}$/, "authenticator code must be 6 digits"))
});
export type BreakGlassRequest = z.infer<typeof breakGlassRequestSchema>;
export type BreakGlassRequestInput = z.input<typeof breakGlassRequestSchema>;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const breakGlassRevokeSchema = z.object({ grantId: z.string().regex(UUID_RE, "grantId must be a UUID") });

/** Formats a zod failure as one short line for `?error=`. */
export function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join("; ");
}

/** A grant may be revoked early by its holder or by a superadmin (ADR-017). */
export function canRevokeGrant(actor: { publicUserId: string; roles: readonly string[] }, grant: { userId: string }): boolean {
  return grant.userId === actor.publicUserId || actor.roles.includes("superadmin");
}

/** RFC 6238 time counter: the 30-second window a TOTP code belongs to. */
export function totpCounter(now: Date = new Date(), period: number = TOTP_PERIOD_SECONDS): number {
  return Math.floor(now.getTime() / 1000 / period);
}

/**
 * Replay rule. Better Auth accepts a code from the current window and its direct neighbours (window 1),
 * so a code verified in window c would still pass in window c+1. A new verification therefore needs a
 * counter at least two windows past the last accepted one; that is at most 60 seconds of waiting.
 */
export function totpCounterIsFresh(counter: number, lastCounter: number | null): boolean {
  return lastCounter === null || counter >= lastCounter + 2;
}

export function expiresAtFor(durationMinutes: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + durationMinutes * 60_000);
}
