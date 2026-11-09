import type { ExecutiveBriefing } from "@sbos/contracts";

/**
 * Data the dashboard renderer receives next to the validated specification. Everything is plain JSON
 * (dates as ISO strings) so server components can hand parts of it to the client chart components.
 */
export interface KpiLatestRow {
  kpiId: string;
  key: string;
  name: string;
  unit: string;
  kpiStatus: string;
  sourceSystem: string;
  sourceField: string;
  formula: string;
  ownerRole: string;
  direction: string;
  warningThreshold: string | null;
  criticalThreshold: string | null;
  lastSuccessfulSyncAt: string | null;
  /** Latest observation, or nulls when the KPI has none. */
  status: string | null;
  value: string | null;
  observedAt: string | null;
}

export interface ObservationPoint {
  observedAt: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  value: string | null;
}

export interface ActionTaskLite {
  id: string;
  title: string;
  state: string;
  ownerRole: string | null;
  ownerName: string | null;
  dueAt: string | null;
  verificationNote: string | null;
}

export interface FindingLite {
  id: string;
  title: string;
  severity: string;
  claim: string;
  department: string;
  state: string;
  ownerRole: string;
}

export interface BriefingLite {
  id: string;
  briefingDate: string;
  simulated: boolean;
  content: ExecutiveBriefing;
}

export interface DashboardData {
  slug: string;
  kpis: KpiLatestRow[];
  /** Observation history per KPI id, oldest first. */
  history: Record<string, ObservationPoint[]>;
  tasks: ActionTaskLite[];
  findings: FindingLite[];
  briefing: BriefingLite | null;
}
