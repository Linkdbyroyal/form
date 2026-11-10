import { and, desc, eq, inArray } from "drizzle-orm";
import { DESCRIPTORS, isProvider, type ConnectorDescriptor } from "@sbos/connectors";
import { schema, type TenantContext } from "@sbos/db";
import { getDb } from "../db";
import { kpiSourceNames } from "./integration-helpers";

/**
 * Integration Center reads (M5). Every function runs in TENANT context, so RLS limits the query to the caller's
 * tenant and content columns (consent reason, masked sync error text) are visible: this is the client's own data.
 * Only descriptors are imported from @sbos/connectors; the web app never runs a sync or reads a secret.
 */
const { systems, connections, connectionPhaseChanges, syncRuns, kpis, users } = schema;

export interface SyncRunView {
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
  /** Masked by the worker before it is stored. */
  errorMessage: string | null;
  note: string | null;
}

export interface PhaseChangeView {
  id: string;
  fromPhase: string | null;
  toPhase: string;
  kind: string;
  consent: string | null;
  scopes: string[];
  actorType: string;
  actorId: string;
  userName: string | null;
  roles: string[];
  reason: string;
  reviewOutcome: string | null;
  createdAt: Date;
}

export interface KpiLinkView {
  id: string;
  key: string;
  name: string;
  sourceSystem: string;
  status: string;
  lastSuccessfulSyncAt: Date | null;
}

export interface ConnectionView {
  id: string;
  systemId: string | null;
  provider: string;
  descriptor: ConnectorDescriptor | null;
  phase: string;
  status: string;
  consent: string;
  consentGivenByName: string | null;
  consentGivenAt: Date | null;
  scopes: string[];
  lastSyncAt: Date | null;
  lastError: string | null;
  syncIntervalMinutes: number;
  securityReviewedAt: Date | null;
  securityReviewedBy: string | null;
  pausedReason: string | null;
  createdAt: Date;
  syncRuns: SyncRunView[];
  phaseChanges: PhaseChangeView[];
  kpis: KpiLinkView[];
}

export interface SystemView {
  id: string;
  name: string;
  vendor: string | null;
  function: string;
  claimStatus: string;
  connections: ConnectionView[];
}

export interface IntegrationCenter {
  systems: SystemView[];
  /** Connections whose system was removed or never set. */
  orphanConnections: ConnectionView[];
  descriptors: ConnectorDescriptor[];
}

export async function getIntegrationCenter(ctx: TenantContext): Promise<IntegrationCenter> {
  return getDb().withContext(ctx, async (tx) => {
    const systemRows = await tx.select({ id: systems.id, name: systems.name, vendor: systems.vendor, function: systems.function, claimStatus: systems.claimStatus }).from(systems).where(eq(systems.tenantId, ctx.tenantId)).orderBy(systems.name);
    const connRows = await tx
      .select({
        id: connections.id,
        systemId: connections.systemId,
        provider: connections.provider,
        phase: connections.phase,
        status: connections.status,
        consent: connections.consent,
        consentGivenByUserId: connections.consentGivenByUserId,
        consentGivenAt: connections.consentGivenAt,
        scopes: connections.scopes,
        lastSyncAt: connections.lastSyncAt,
        lastError: connections.lastError,
        syncIntervalMinutes: connections.syncIntervalMinutes,
        securityReviewedAt: connections.securityReviewedAt,
        securityReviewedBy: connections.securityReviewedBy,
        pausedReason: connections.pausedReason,
        createdAt: connections.createdAt
      })
      .from(connections)
      .where(eq(connections.tenantId, ctx.tenantId))
      .orderBy(connections.createdAt);
    const connIds = connRows.map((c) => c.id);
    const [runRows, changeRows, kpiRows] = connIds.length === 0
      ? [[], [], []]
      : await Promise.all([
          tx
            .select({ id: syncRuns.id, connectionId: syncRuns.connectionId, trigger: syncRuns.trigger, phase: syncRuns.phase, mode: syncRuns.mode, status: syncRuns.status, startedAt: syncRuns.startedAt, finishedAt: syncRuns.finishedAt, objectsRead: syncRuns.objectsRead, observationsWritten: syncRuns.observationsWritten, errorClass: syncRuns.errorClass, errorMessage: syncRuns.errorMessage, details: syncRuns.details })
            .from(syncRuns)
            .where(and(eq(syncRuns.tenantId, ctx.tenantId), inArray(syncRuns.connectionId, connIds)))
            .orderBy(desc(syncRuns.startedAt))
            .limit(200),
          tx
            .select({ id: connectionPhaseChanges.id, connectionId: connectionPhaseChanges.connectionId, fromPhase: connectionPhaseChanges.fromPhase, toPhase: connectionPhaseChanges.toPhase, kind: connectionPhaseChanges.kind, consent: connectionPhaseChanges.consent, scopes: connectionPhaseChanges.scopes, actorType: connectionPhaseChanges.actorType, actorId: connectionPhaseChanges.actorId, userName: users.displayName, roles: connectionPhaseChanges.roles, reason: connectionPhaseChanges.reason, reviewOutcome: connectionPhaseChanges.reviewOutcome, createdAt: connectionPhaseChanges.createdAt })
            .from(connectionPhaseChanges)
            .leftJoin(users, eq(users.id, connectionPhaseChanges.userId))
            .where(and(eq(connectionPhaseChanges.tenantId, ctx.tenantId), inArray(connectionPhaseChanges.connectionId, connIds)))
            .orderBy(desc(connectionPhaseChanges.createdAt)),
          tx.select({ id: kpis.id, key: kpis.key, name: kpis.name, sourceSystem: kpis.sourceSystem, status: kpis.status, lastSuccessfulSyncAt: kpis.lastSuccessfulSyncAt }).from(kpis).where(eq(kpis.tenantId, ctx.tenantId)).orderBy(kpis.name)
        ]);
    const consentUserIds = [...new Set(connRows.map((c) => c.consentGivenByUserId).filter((v): v is string => v !== null))];
    const consentUsers = consentUserIds.length === 0 ? [] : await tx.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, consentUserIds));
    const userName = new Map(consentUsers.map((u) => [u.id, u.displayName]));
    const systemName = new Map(systemRows.map((s) => [s.id, s.name]));

    const views: ConnectionView[] = connRows.map((c) => {
      const descriptor = isProvider(c.provider) ? DESCRIPTORS[c.provider] : null;
      const names = kpiSourceNames(c.systemId ? (systemName.get(c.systemId) ?? null) : null, descriptor, c.provider);
      return {
        id: c.id,
        systemId: c.systemId,
        provider: c.provider,
        descriptor,
        phase: c.phase,
        status: c.status,
        consent: c.consent,
        consentGivenByName: c.consentGivenByUserId ? (userName.get(c.consentGivenByUserId) ?? null) : null,
        consentGivenAt: c.consentGivenAt,
        scopes: c.scopes,
        lastSyncAt: c.lastSyncAt,
        lastError: c.lastError,
        syncIntervalMinutes: c.syncIntervalMinutes,
        securityReviewedAt: c.securityReviewedAt,
        securityReviewedBy: c.securityReviewedBy,
        pausedReason: c.pausedReason,
        createdAt: c.createdAt,
        syncRuns: runRows
          .filter((r) => r.connectionId === c.id)
          .slice(0, 10)
          .map((r) => ({ id: r.id, trigger: r.trigger, phase: r.phase, mode: r.mode, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, objectsRead: r.objectsRead, observationsWritten: r.observationsWritten, errorClass: r.errorClass, errorMessage: r.errorMessage, note: typeof (r.details as { note?: unknown }).note === "string" ? ((r.details as { note: string }).note) : null })),
        phaseChanges: changeRows.filter((p) => p.connectionId === c.id).map((p) => ({ id: p.id, fromPhase: p.fromPhase, toPhase: p.toPhase, kind: p.kind, consent: p.consent, scopes: p.scopes, actorType: p.actorType, actorId: p.actorId, userName: p.userName, roles: p.roles, reason: p.reason, reviewOutcome: p.reviewOutcome, createdAt: p.createdAt })),
        kpis: kpiRows.filter((k) => names.includes(k.sourceSystem))
      };
    });

    return {
      systems: systemRows.map((s) => ({ ...s, connections: views.filter((v) => v.systemId === s.id) })),
      orphanConnections: views.filter((v) => v.systemId === null || !systemName.has(v.systemId)),
      descriptors: Object.values(DESCRIPTORS)
    };
  });
}
