import type { ReactNode } from "react";
import { MISSION_CONTROL_NAV, Shell } from "@/components/shell";
import { requireOperatorContext } from "@/lib/request-context";

export default async function MissionControlLayout({ children }: { children: ReactNode }) {
  // Operator surface: superadmin or agency_operator on the agency tenant with MFA (ADR-015/017).
  await requireOperatorContext();
  return (
    <Shell title="Mission Control" subtitle="Operator console" nav={MISSION_CONTROL_NAV}>
      {children}
    </Shell>
  );
}
