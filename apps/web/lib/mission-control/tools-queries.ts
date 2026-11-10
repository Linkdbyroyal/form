import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { DESCRIPTORS, isProvider, type ConnectorDescriptor } from "@sbos/connectors";
import { agencyContext, schema, type Tx } from "@sbos/db";
import { getDb } from "../db";
import { getOperatorContext, requireOperatorContext } from "../request-context";

/**
 * Connected Tools reads (M5). The list and the health counters run in OPERATOR context (`sbos_operator`):
 * metadata columns only, so `connections.config`, `sync_runs.error_message` and `connection_phase_changes.reason`
 * are never selected here (Postgres would raise `permission denied`). The credential and webhook references of one
 * connection are read in AGENCY scope pinned to that tenant, the scope the agency actions run in: `secret_ref` and
 * `path_token` are references into the worker's environment, not values, and the operator who registered them needs
 * to see them to configure the vendor. Only descriptors are imported from @sbos/connectors.
 */
const { tenants, systems, connections, connectionPhaseChanges, syncRuns, credentialsMetadata, webhookEndpoints, incidents, kpiObservations } = schema;

const num = (expr: SQL) => sql<number>`${expr}`.mapWith(Number);

async function operatorRead<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().withContext(getOperatorContext(), fn);
}

export type Phase = (typeof schema.connectionPhase.enumValues)[number];
export type ConnectionStatus = (typeof schema.connectionStatus.enumValues)[number];
export const PHASE_VALUES = schema.connectionPhase.enumValues;
export const STATUS_VALUES = schema.connectionStatus.enumValues;

export interface ConnectionRow {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  systemName: string | null;
  provider: string;
  displayName: string;
  phase: string;
  status: string;
  consent: string;
  consentGivenAt: Date | null;
  scopes: string[];
  securityReviewedAt: Date | null;
  securityReviewedBy: string | null;
  lastSyncAt: Date | null;
  syncIntervalMinutes: number;
  pausedReason: string | null;
  createdAt: Date;
  openIncidents: number;
}

const connectionColumns = {
  id: connections.id,
  tenantId: connections.tenantId,
  tenantSlug: tenants.slug,
  tenantName: tenants.name,
  systemName: systems.name,
  provider: connections.provider,
  phase: connections.phase,
  status: connections.status,
  consent: connections.consent,
  consentGivenAt: connections.consentGivenAt,
  scopes: connections.scopes,
  securityReviewedAt: connections.securityReviewedAt,
  securityReviewedBy: connections.securityReviewedBy,
  lastSyncAt: connections.lastSyncAt,
  syncIntervalMinutes: connections.syncIntervalMinutes,
  pausedReason: connections.pausedReason,
  createdAt: connections.createdAt,
  // Incidents the sync service raises carry dedupe_key `connector:<connectionId>:<errorClass>`.
  openIncidents: num(sql`(select count(*) from ${incidents} i where i.state = 'open' and i.dedupe_key like 'connector:' || ${connections.id}::text || ':%')`)
};

function toRow(r: Omit<ConnectionRow, "displayName">): ConnectionRow {
  return { ...r, displayName: isProvider(r.provider) ? DESCRIPTORS[r.provider].displayName : r.provider };
}

export async function listConnections(filter: { phase?: Phase | null; status?: ConnectionStatus | null } = {}): Promise<ConnectionRow[]> {
  return operatorRead(async (tx) => {
    const where: SQL[] = [];
    if (filter.phase) where.push(eq(connections.phase, filter.phase));
    if (filter.status) where.push(eq(connections.status, filter.status));
    const rows = await tx
      .select(connectionColumns)
      .from(connections)
      .innerJoin(tenants, eq(tenants.id, connections.tenantId))
      .leftJoin(systems, eq(systems.id, connections.systemId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(tenants.name, connections.provider, connections.createdAt);
    return rows.map(toRow);
  });
}

/** Every connection without filter, for the health counters and the filter counts. */
export async function listAllConnections(): Promise<ConnectionRow[]> {
  return listConnections();
}

export interface SyncRunMeta {
  id: string;
  trigger: string;
  phase: string;
  mode: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  objectsRead: number;
  observationsWritten: number;
  errorClass: string | null;
}

export interface PhaseChangeMeta {
  id: string;
  fromPhase: string | null;
  toPhase: string;
  kind: string;
  consent: string | null;
  scopes: string[];
  actorType: string;
  actorId: string;
  roles: string[];
  reviewOutcome: string | null;
  createdAt: Date;
}

export interface CredentialReference {
  id: string;
  kind: string;
  secretRef: string;
  rotatedAt: Date | null;
  expiresAt: Date | null;
  createdByActorId: string;
  createdAt: Date;
}

export interface WebhookReference {
  id: string;
  pathToken: string;
  secretRef: string;
  signatureState: string;
  lastReceivedAt: Date | null;
  createdByActorId: string;
  createdAt: Date;
}

export interface ConnectionDetail {
  connection: ConnectionRow;
  descriptor: ConnectorDescriptor | null;
  phaseChanges: PhaseChangeMeta[];
  syncRuns: SyncRunMeta[];
  observationsBySyncRun: Map<string, number>;
  credentials: CredentialReference[];
  webhooks: WebhookReference[];
}

export async function getConnectionDetail(id: string): Promise<ConnectionDetail | null> {
  const meta = await operatorRead(async (tx) => {
    const [row] = await tx.select(connectionColumns).from(connections).innerJoin(tenants, eq(tenants.id, connections.tenantId)).leftJoin(systems, eq(systems.id, connections.systemId)).where(eq(connections.id, id));
    if (!row) return null;
    const [phaseChanges, runs] = await Promise.all([
      tx
        .select({ id: connectionPhaseChanges.id, fromPhase: connectionPhaseChanges.fromPhase, toPhase: connectionPhaseChanges.toPhase, kind: connectionPhaseChanges.kind, consent: connectionPhaseChanges.consent, scopes: connectionPhaseChanges.scopes, actorType: connectionPhaseChanges.actorType, actorId: connectionPhaseChanges.actorId, roles: connectionPhaseChanges.roles, reviewOutcome: connectionPhaseChanges.reviewOutcome, createdAt: connectionPhaseChanges.createdAt })
        .from(connectionPhaseChanges)
        .where(eq(connectionPhaseChanges.connectionId, id))
        .orderBy(desc(connectionPhaseChanges.createdAt)),
      tx
        .select({ id: syncRuns.id, trigger: syncRuns.trigger, phase: syncRuns.phase, mode: syncRuns.mode, status: syncRuns.status, startedAt: syncRuns.startedAt, finishedAt: syncRuns.finishedAt, objectsRead: syncRuns.objectsRead, observationsWritten: syncRuns.observationsWritten, errorClass: syncRuns.errorClass })
        .from(syncRuns)
        .where(eq(syncRuns.connectionId, id))
        .orderBy(desc(syncRuns.startedAt))
        .limit(50)
    ]);
    const obs = runs.length === 0 ? [] : await tx.select({ syncRunId: kpiObservations.syncRunId, n: num(sql`count(*)`) }).from(kpiObservations).where(sql`${kpiObservations.syncRunId} in ${runs.map((r) => r.id)}`).groupBy(kpiObservations.syncRunId);
    return { row: toRow(row), phaseChanges, runs, obs };
  });
  if (!meta) return null;
  // References: agency scope pinned to the tenant (same scope as the actions that registered them).
  const op = await requireOperatorContext();
  const pinned = agencyContext({ tenantId: meta.row.tenantId, actorType: "user", actorId: op.actorId, roles: op.roles });
  const refs = await getDb().withContext(pinned, async (tx) => {
    const [credentials, webhooks] = await Promise.all([
      tx.select({ id: credentialsMetadata.id, kind: credentialsMetadata.kind, secretRef: credentialsMetadata.secretRef, rotatedAt: credentialsMetadata.rotatedAt, expiresAt: credentialsMetadata.expiresAt, createdByActorId: credentialsMetadata.createdByActorId, createdAt: credentialsMetadata.createdAt }).from(credentialsMetadata).where(and(eq(credentialsMetadata.tenantId, meta.row.tenantId), eq(credentialsMetadata.connectionId, id))).orderBy(desc(credentialsMetadata.createdAt)),
      tx.select({ id: webhookEndpoints.id, pathToken: webhookEndpoints.pathToken, secretRef: webhookEndpoints.secretRef, signatureState: webhookEndpoints.signatureState, lastReceivedAt: webhookEndpoints.lastReceivedAt, createdByActorId: webhookEndpoints.createdByActorId, createdAt: webhookEndpoints.createdAt }).from(webhookEndpoints).where(and(eq(webhookEndpoints.tenantId, meta.row.tenantId), eq(webhookEndpoints.connectionId, id))).orderBy(desc(webhookEndpoints.createdAt))
    ]);
    return { credentials, webhooks };
  });
  return {
    connection: meta.row,
    descriptor: isProvider(meta.row.provider) ? DESCRIPTORS[meta.row.provider] : null,
    phaseChanges: meta.phaseChanges,
    syncRuns: meta.runs,
    observationsBySyncRun: new Map(meta.obs.filter((o) => o.syncRunId !== null).map((o) => [o.syncRunId as string, o.n])),
    credentials: refs.credentials,
    webhooks: refs.webhooks
  };
}
