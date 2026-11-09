/** Shared, read-only view of a tenant that flows feed to the model. Assembled by the worker inside the tenant context. */
export interface TenantSnapshot {
  tenantId: string;
  company: { name: string; industry: string | null; locale: string; kind: string };
  departments: Array<{ key: string; name: string; headRole: string | null }>;
  systems: Array<{ name: string; vendor: string | null; function: string; claimStatus: string; apiCapabilities: string[]; sourceOfTruthFor: string[] }>;
  questions: Array<{ id: string; department: string; question_text: string; state: string }>;
  answers: Array<{ question_text: string; answer_text: string; department: string; answered_by_role: string; fact_id: string | null; source_id: string | null }>;
  facts: Array<{ id: string; statement: string; verification: string; subject_key: string | null }>;
  findings: Array<{ id: string; title: string; department: string; severity: string; claim: string; state: string }>;
  opportunities: Array<{ id: string; title: string; intervention: string; state: string }>;
  kpis: Array<{ id: string; key: string; name: string; unit: string; status: string; latest_status: string | null; latest_value: string | null; source_system: string }>;
  actionTasks: Array<{ id: string; title: string; state: string; owner_role: string | null; due_at: string | null }>;
  openIncidents: number;
}

export function formatList<T>(items: T[], render: (t: T) => string, empty = "(none)"): string {
  return items.length === 0 ? empty : items.map((i) => `- ${render(i)}`).join("\n");
}
