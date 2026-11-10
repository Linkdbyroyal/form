import type { ReactNode } from "react";
import { headers } from "next/headers";
import { AGENCY_STAFF_NAV, MISSION_CONTROL_NAV, Shell } from "@/components/shell";
import { hasOperatorRole } from "@/lib/mission-control/agency-vault-helpers";
import { requireAgencyContext, requireOperatorContext } from "@/lib/request-context";

/** Surfaces open to every agency role (agency scope): the Agency Intelligence Vault (spec 4H) and Tech Watch (spec 4D). */
const AGENCY_PREFIXES = ["/mission-control/agency-vault", "/mission-control/tech-watch"];

export default async function MissionControlLayout({ children }: { children: ReactNode }) {
  // The pathname header is set by proxy.ts on every /mission-control request (it overwrites any client value).
  const pathname = (await headers()).get("x-sbos-pathname") ?? "";
  if (AGENCY_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    // Agency Intelligence Vault and Tech Watch: every agency role, MFA rule unchanged for operators (ADR-015).
    const ctx = await requireAgencyContext();
    const nav = hasOperatorRole(ctx.roles) ? MISSION_CONTROL_NAV : AGENCY_STAFF_NAV;
    return (
      <Shell title={hasOperatorRole(ctx.roles) ? "Mission Control" : "Agency Vault"} subtitle={hasOperatorRole(ctx.roles) ? "Operator console" : "Second Brain intelligence"} nav={nav}>
        {children}
      </Shell>
    );
  }
  // Operator surface: superadmin or agency_operator on the agency tenant with MFA (ADR-015/017).
  await requireOperatorContext();
  return (
    <Shell title="Mission Control" subtitle="Operator console" nav={MISSION_CONTROL_NAV}>
      {children}
    </Shell>
  );
}
