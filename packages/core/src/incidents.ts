import { schema, type Tx } from "@sbos/db";
import type { JobBackend } from "./job-backend";
import { queueNotification } from "./notifications";

const { incidents } = schema;

export type IncidentKind = (typeof schema.incidentKind.enumValues)[number];
export type Severity = (typeof schema.riskLevel.enumValues)[number];

export interface RaiseIncidentInput {
  tenantId: string | null;
  kind: IncidentKind;
  severity?: Severity;
  title: string;
  details?: Record<string, unknown>;
  runId?: string | null;
  scheduleId?: string | null;
  agentInstanceId?: string | null;
  dedupeKey?: string | null;
  notify?: boolean;
}

/** Raises an incident (deduplicated while open) and queues a notification for high severity. Details carry identifiers only. */
export async function raiseIncident(tx: Tx, jobs: JobBackend, input: RaiseIncidentInput): Promise<string | null> {
  const [row] = await tx
    .insert(incidents)
    .values({
      tenantId: input.tenantId,
      kind: input.kind,
      severity: input.severity ?? "medium",
      title: input.title,
      details: input.details ?? {},
      runId: input.runId ?? null,
      scheduleId: input.scheduleId ?? null,
      agentInstanceId: input.agentInstanceId ?? null,
      dedupeKey: input.dedupeKey ?? null
    })
    .onConflictDoNothing()
    .returning({ id: incidents.id });
  if (!row) return null; // duplicate open incident
  const severity = input.severity ?? "medium";
  if (input.notify ?? (severity === "high" || severity === "critical")) {
    await queueNotification(tx, jobs, {
      tenantId: input.tenantId,
      channel: "pumble",
      template: "incident.raised",
      subject: `[${severity}] ${input.kind}: ${input.title}`,
      payload: { incidentId: row.id, kind: input.kind, severity, tenantId: input.tenantId, runId: input.runId ?? null }
    });
  }
  return row.id;
}
