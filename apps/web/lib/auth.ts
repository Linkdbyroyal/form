import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { admin, organization, twoFactor } from "better-auth/plugins";
import { betterAuthSchema } from "@sbos/db/schema";
import * as bridge from "./auth-bridge";
import { getAuthDb } from "./auth-db";
import { sendMail } from "./mailer";

/**
 * Better Auth server configuration (ADR-015).
 * - Email/password with mandatory e-mail verification; public sign-up disabled (invitation-only).
 * - Google and Microsoft only when their environment variables are set.
 * - Organisations map 1:1 to tenants; members are mirrored into `memberships` by the bridge.
 * - twoFactor (TOTP) is enforced for operator roles by `lib/request-context.ts`, not by Better Auth.
 * - All ids are UUIDs so `auth.user.id` can equal `public.users.id`.
 */
export type SocialProviderId = "google" | "microsoft";

export function configuredSocialProviders(): SocialProviderId[] {
  const out: SocialProviderId[] = [];
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) out.push("google");
  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) out.push("microsoft");
  return out;
}

function socialProviders(): NonNullable<BetterAuthOptions["socialProviders"]> {
  const providers: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.google = { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };
  }
  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
    providers.microsoft = {
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      tenantId: process.env.MICROSOFT_TENANT_ID ?? "common"
    };
  }
  return providers;
}

function baseUrl(): string {
  return process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
}

function createAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set (generate with: openssl rand -base64 32)");

  return betterAuth({
    appName: "Second Brain Business OS",
    baseURL: baseUrl(),
    secret,
    database: drizzleAdapter(getAuthDb(), { provider: "pg", schema: betterAuthSchema }),
    advanced: {
      database: { generateId: () => crypto.randomUUID() }
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => {
        await sendMail({
          to: user.email,
          subject: "Second Brain Business OS: reset your password",
          text: `Someone requested a password reset for this account.\n\nSet a new password here (valid for one hour):\n${url}\n\nIf you did not request this, ignore this message.`
        });
      }
    },
    emailVerification: {
      sendOnSignUp: true,
      // A sign-in attempt with an unverified address re-sends the link before the 403 (the sign-in page says so).
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => {
        await sendMail({
          to: user.email,
          subject: "Second Brain Business OS: verify your e-mail address",
          text: `Confirm this e-mail address to activate your account:\n${url}\n\nThe link expires in one hour.`
        });
      }
    },
    socialProviders: socialProviders(),
    databaseHooks: {
      user: {
        create: {
          // Identity bridge: mirror every new auth user into public.users with the same id.
          after: async (user) => {
            await bridge.ensurePublicUser({ id: user.id, email: user.email, name: user.name });
          }
        }
      },
      session: {
        create: {
          // After every sign-in, reconcile memberships so a missed organisation hook converges here.
          after: async (session) => {
            try {
              await bridge.syncMemberships(session.userId);
            } catch (err) {
              console.error("[auth-bridge] membership sync after sign-in failed:", (err as Error).message);
            }
          }
        }
      }
    },
    plugins: [
      organization({
        creatorRole: "owner",
        requireEmailVerificationOnInvitation: true,
        invitationExpiresIn: 60 * 60 * 72,
        // Only superadmins create organisations through the API; the bootstrap script is a system action.
        allowUserToCreateOrganization: async (user) => bridge.isSuperadmin(user.id),
        sendInvitationEmail: async (data) => {
          await sendMail({
            to: data.email,
            subject: `Second Brain Business OS: invitation to ${data.organization.name}`,
            text: `${data.inviter.user.name || data.inviter.user.email} invited you to join ${data.organization.name} as ${data.role}.\n\nAccept the invitation here:\n${baseUrl()}/accept-invitation/${data.id}\n\nThe invitation expires in 72 hours.`
          });
        },
        organizationHooks: {
          beforeCreateOrganization: async ({ organization: org }) => {
            try {
              await bridge.assertOrganizationCanBeCreated(org.slug ?? "");
            } catch (err) {
              throw new APIError("BAD_REQUEST", { message: (err as Error).message });
            }
          },
          afterCreateOrganization: async ({ organization: org, user }) => {
            await bridge.linkOrganizationToTenant({ id: org.id, slug: org.slug, name: org.name });
            await bridge.syncMemberships(user.id);
          },
          afterAddMember: async ({ user }) => {
            await bridge.syncMemberships(user.id);
          },
          afterRemoveMember: async ({ user }) => {
            await bridge.syncMemberships(user.id);
          },
          afterUpdateMemberRole: async ({ user }) => {
            await bridge.syncMemberships(user.id);
          },
          afterAcceptInvitation: async ({ user }) => {
            await bridge.syncMemberships(user.id);
          }
        }
      }),
      twoFactor({ issuer: "Second Brain Business OS" }),
      admin(),
      // Must stay last: lets server actions and route handlers set Better Auth cookies.
      nextCookies()
    ]
  });
}

// Next.js may evaluate server modules more than once in dev; keep one instance per process.
const globalForAuth = globalThis as unknown as { __sbosAuth?: ReturnType<typeof createAuth> };
export const auth: ReturnType<typeof createAuth> = globalForAuth.__sbosAuth ?? (globalForAuth.__sbosAuth = createAuth());

export type Auth = typeof auth;
export type Session = typeof auth.$Infer.Session;
