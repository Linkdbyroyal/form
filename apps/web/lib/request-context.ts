import { noAccessPath } from "./account-helpers";
import { headers } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { cache } from "react";
import { agencyContext, operatorContext, tenantContext, type AgencyContext, type OperatorContext, type TenantContext } from "@sbos/db";
import { auth, type Session } from "./auth";
import { loadPrincipalData, type PrincipalData, type PrincipalGrant } from "./auth-bridge";
import { decideAgencyAccess, decideOperatorAccess, decideTenantAccess, mfaGate } from "./auth-policy";
import { logContentAccess } from "./content-access";

/**
 * Request-scoped authentication and authorisation (M1-01, ADR-015/017).
 *
 * Flow per request: `getSession()` reads the Better Auth session from the cookies, `getPrincipal()`
 * adds our memberships and content grants (metadata reads through the operator role), and the
 * `require*` functions turn that into a `RequestContext` for `withContext()`, or redirect / 403.
 *
 * `getOperatorContext()` and `getTenantContext()` stay synchronous so `lib/queries.ts` keeps compiling.
 * They return the context that a `require*` call resolved earlier in the same request (React `cache`
 * is request-scoped) and throw when nothing was resolved: fail closed, never a default actor.
 */
export interface Principal {
  userId: string;
  email: string;
  name: string;
  /** Profile picture URL from the auth user, when set (OAuth providers supply one). */
  image: string | null;
  twoFactorEnabled: boolean;
  data: PrincipalData;
  agencyRoles: string[];
  agencyTenantId: string | null;
}

interface Resolved {
  operator: OperatorContext | null;
  agency: AgencyContext | null;
  tenants: Map<string, TenantContext>;
}

const resolved = cache((): Resolved => ({ operator: null, agency: null, tenants: new Map() }));

export const getSession = cache(async (): Promise<Session | null> => {
  return auth.api.getSession({ headers: await headers() });
});

export const getPrincipal = cache(async (): Promise<Principal | null> => {
  const session = await getSession();
  if (!session) return null;
  const { user } = session;
  const data = await loadPrincipalData({ id: user.id, email: user.email, name: user.name });
  const agency = data.memberships.filter((m) => m.kind === "agency");
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    image: user.image ?? null,
    twoFactorEnabled: Boolean(user.twoFactorEnabled),
    data,
    agencyRoles: agency.map((m) => m.roleKey),
    agencyTenantId: agency[0]?.tenantId ?? null
  };
});

async function currentPath(fallback: string): Promise<string> {
  const h = await headers();
  return h.get("x-sbos-pathname") ?? fallback;
}

function signInRedirect(next: string): never {
  redirect(`/sign-in?next=${encodeURIComponent(next)}`);
}

/** Any signed-in user (for /account/*). Redirects to /sign-in otherwise. */
export async function requireSignedIn(): Promise<Principal> {
  const p = await getPrincipal();
  if (!p) signInRedirect(await currentPath("/account/security"));
  return p;
}

/** True when the principal must enable TOTP before using operator surfaces. */
export function principalNeedsMfa(p: Principal): boolean {
  return mfaGate({ roles: p.agencyRoles, twoFactorEnabled: p.twoFactorEnabled }) === "require_mfa";
}

/**
 * Mission Control: superadmin or agency_operator on the agency tenant with MFA satisfied.
 * Otherwise redirect to /sign-in (no session, or no operator role) or /account/security (MFA missing).
 */
export async function requireOperatorContext(): Promise<OperatorContext> {
  const store = resolved();
  if (store.operator) return store.operator;
  const p = await getPrincipal();
  const decision = decideOperatorAccess({ authenticated: p !== null, agencyRoles: p?.agencyRoles ?? [], twoFactorEnabled: p?.twoFactorEnabled ?? false });
  if (decision.kind === "redirect") {
    if (decision.to === "/sign-in") {
      const path = await currentPath("/mission-control");
      if (p) redirect(noAccessPath(path));
      signInRedirect(path);
    }
    redirect(`/account/security?reason=${decision.reason}`);
  }
  const ctx = operatorContext({ actorType: "user", actorId: p!.userId, roles: decision.roles });
  store.operator = ctx;
  return ctx;
}

/**
 * Same gate as `requireOperatorContext()` for API route handlers, which answer with a status code instead of a
 * redirect (an EventSource cannot follow a redirect to the sign-in page). Returns null when the request is not
 * an operator with MFA; the resolved context is cached for `getOperatorContext()` like the redirecting variant.
 */
export async function resolveOperatorContext(): Promise<OperatorContext | null> {
  const store = resolved();
  if (store.operator) return store.operator;
  const p = await getPrincipal();
  const decision = decideOperatorAccess({ authenticated: p !== null, agencyRoles: p?.agencyRoles ?? [], twoFactorEnabled: p?.twoFactorEnabled ?? false });
  if (decision.kind !== "allow" || !p) return null;
  const ctx = operatorContext({ actorType: "user", actorId: p.userId, roles: decision.roles });
  store.operator = ctx;
  return ctx;
}

/**
 * Agency Intelligence Vault (spec 4H): any agency role (superadmin, agency_operator, agency_reviewer,
 * agency_consultant) on the agency tenant. Client roles are rejected. The MFA rule for superadmin and
 * agency_operator is the same as for Mission Control. The returned context runs as `sbos_app` in agency scope
 * without a tenant, which is the only scope that can read agency knowledge bodies (RLS, migration 0007).
 */
export async function requireAgencyContext(): Promise<AgencyContext> {
  const store = resolved();
  if (store.agency) return store.agency;
  const p = await getPrincipal();
  const decision = decideAgencyAccess({ authenticated: p !== null, agencyRoles: p?.agencyRoles ?? [], twoFactorEnabled: p?.twoFactorEnabled ?? false });
  if (decision.kind === "redirect") {
    if (decision.to === "/sign-in") {
      const path = await currentPath("/agency");
      if (p) redirect(noAccessPath(path));
      signInRedirect(path);
    }
    redirect(`/account/security?reason=${decision.reason}`);
  }
  const ctx = agencyContext({ tenantId: null, actorType: "user", actorId: p!.userId, roles: decision.roles });
  store.agency = ctx;
  return ctx;
}

export interface ResolvedTenant {
  ctx: TenantContext;
  tenantId: string;
  slug: string;
  viaGrant: boolean;
  /** The break-glass grant this access runs under, when `viaGrant` is true. */
  grant: PrincipalGrant | null;
}

/**
 * Client workspace: a membership on the tenant, or an operator (superadmin / agency_operator) with an active
 * content grant (break-glass). An operator without a grant gets a 403, not tenant content. Unknown slug:
 * null (caller renders 404). Under a grant, the first resolution in a request writes one
 * `knowledge_access_logs` row (resource_type `page`, resource_id = pathname) as ADR-017 requires.
 */
export async function requireTenantContext(slug: string): Promise<ResolvedTenant | null> {
  const p = await getPrincipal();
  if (!p) signInRedirect(await currentPath(`/c/${slug}`));
  const tenant = await findTenantBySlugForPrincipal(p, slug);
  if (!tenant) return null;
  const tenantRoles = p.data.memberships.filter((m) => m.tenantId === tenant.id).map((m) => m.roleKey);
  const decision = decideTenantAccess({
    authenticated: true,
    tenantRoles,
    agencyRoles: p.agencyRoles,
    twoFactorEnabled: p.twoFactorEnabled,
    hasActiveGrant: p.data.activeGrantTenantIds.includes(tenant.id)
  });
  if (decision.kind === "redirect") {
    if (decision.to === "/sign-in") redirect(noAccessPath(`/c/${slug}`));
    redirect("/account/security?reason=mfa_required");
  }
  if (decision.kind === "forbidden") forbidden();
  const ctx = tenantContext({ tenantId: tenant.id, actorType: "user", actorId: p.userId, roles: decision.roles });
  const store = resolved();
  const firstInRequest = !store.tenants.has(tenant.id);
  store.tenants.set(tenant.id, ctx);
  const grant = decision.viaGrant ? (p.data.activeGrants.find((g) => g.tenantId === tenant.id) ?? null) : null;
  if (decision.viaGrant && firstInRequest) {
    await logContentAccess(ctx, grant?.id ?? null, "page", await currentPath(`/c/${slug}`), "break_glass");
  }
  return { ctx, tenantId: tenant.id, slug: tenant.slug, viaGrant: decision.viaGrant, grant };
}

async function findTenantBySlugForPrincipal(p: Principal, slug: string): Promise<{ id: string; slug: string } | null> {
  const member = p.data.memberships.find((m) => m.slug === slug);
  if (member) return { id: member.tenantId, slug: member.slug };
  // Not a member: only agency staff may even resolve the slug (break-glass path). Metadata read.
  if (p.agencyRoles.length === 0) return null;
  const { tenantBySlug } = await import("./auth-bridge");
  const t = await tenantBySlug(slug);
  return t ? { id: t.id, slug: t.slug } : null;
}

/** Synchronous accessor for `lib/queries.ts`. Requires `requireOperatorContext()` earlier in the request. */
export function getOperatorContext(): OperatorContext {
  const ctx = resolved().operator;
  if (!ctx) throw new Error("Operator context not resolved for this request: call requireOperatorContext() first");
  return ctx;
}

/** Synchronous accessor for `lib/queries.ts`. Requires `requireTenantContext(slug)` earlier in the request. */
export function getTenantContext(tenantId: string): TenantContext {
  const ctx = resolved().tenants.get(tenantId);
  if (!ctx) throw new Error(`Tenant context not resolved for tenant ${tenantId}: call requireTenantContext(slug) first`);
  return ctx;
}
