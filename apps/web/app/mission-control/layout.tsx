import type { ReactNode } from "react";
import { MISSION_CONTROL_NAV, Shell } from "@/components/shell";

export default function MissionControlLayout({ children }: { children: ReactNode }) {
  return (
    <Shell title="Mission Control" subtitle="Operator console" nav={MISSION_CONTROL_NAV}>
      {children}
    </Shell>
  );
}
