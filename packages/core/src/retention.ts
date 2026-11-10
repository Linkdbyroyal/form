import { and, eq, isNull, lt, sql, type AnyColumn } from "drizzle-orm";
import { schema, writeAudit, type RequestContext, type Tx } from "@sbos/db";
import { AuthorizationError } from "./errors";

/**
 * Data retention and deletion requests (Milestone 6). Retention policies have a platform default (tenant_id
 * NULL) and per-tenant overrides, each with a floor per data class enforced by the database. The sweep deletes
 * rows older than the effective policy in agency scope only (a restrictive DELETE policy refuses tenant
 * contexts). Deletion requests are decided by an agency reviewer (trigger) and executed by the worker; audit
 * events are never deleted and every execution writes one with the counts.
 */
const { retentionPolicies, retentionSweeps, deletionRequests, runEvents, retrievalAudit, notifications, syncRuns, knowledgeAccessLogs, costEvents, vaultDocuments, vaultRevisions, vaultLinks, kpiObservations } = schema;

export const DATA_CLASSES = ["run_events", "retrieval_audit", "notifications", "sync_runs", "knowledge_access_logs", "cost_events"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];
export const RETENTION_MINIMUM_DAYS: Record<DataClass, number> = { run_events: 30, retrieval_audit: 90, notifications: 30, sync_runs: 30, knowledge_access_logs: 365, cost_events: 400 };

const REVIEWERS = ["agency_reviewer", "superadmin"] as const;
const EXECUTORS = ["system", "superadmin"] as const;

function hasRole(ctx: RequestContext, roles: readonly string[]): boolean {
  return ctx.roles.some((r) => roles.includes(r));
}

export async function effectiveRetention(tx: Tx, _ctx: RequestContext, tenantId: string | null): Promise<Record<DataClass, { days: number; source: "default" | "tenant"; reason: string }>> {
  const rows = await tx.select().from(retentionPolicies).where(tenantId ? sql`${retentionPolicies.tenantId} = ${tenantId} OR ${retentionPolicies.tenantId} IS NULL` : isNull(retentionPolicies.tenantId));
  const out = {} as Record<DataClass, { days: number; source: "default" | "tenant"; reason: string }>;
  for (const dc of DATA_CLASSES) {
    const tenantRow = rows.find((r) => r.dataClass === dc && r.tenantId === tenantId && tenantId !== null);
    const def = rows.find((r) => r.dataClass === dc && r.tenantId === null);
    const pick = tenantRow ?? def;
    out[dc] = pick ? { days: pick.retentionDays, source: tenantRow ? "tenant" : "default", reason: pick.reason } : { days: RETENTION_MINIMUM_DAYS[dc], source: "default", reason: "minimum (no policy row)" };
  }
  return out;
}

/** A tenant admin sets a tenant override; a superadmin in agency scope sets the platform default (tenantId null). */
export async function setRetentionPolicy(tx: Tx, ctx: RequestContext, input: { tenantId: string | null; dataClass: DataClass; retentionDays: number; reason: string }): Promise<void> {
  if (ctx.actorType === "agent") throw new AuthorizationError("agents cannot change retention");
  if (input.tenantId === null) {
    if (ctx.kind !== "agency" || !hasRole(ctx, ["superadmin"])) throw new AuthorizationError("platform defaults are set by a superadmin in agency scope");
  } else {
    if (ctx.kind === "operator" || ctx.tenantId !== input.tenantId) throw new AuthorizationError("a tenant policy is set inside that tenant's context");
    if (!hasRole(ctx, ["client_admin", "superadmin"])) throw new AuthorizationError("a tenant policy is set by the client admin or a superadmin");
  }
  if (input.retentionDays < RETENTION_MINIMUM_DAYS[input.dataClass]) throw new Error(`${input.dataClass} must be kept at least ${RETENTION_MINIMUM_DAYS[input.dataClass]} days`);
  if (input.reason.trim().length < 5) throw new Error("a reason is required");
  await tx
    .insert(retentionPolicies)
    .values({ tenantId: input.tenantId, dataClass: input.dataClass, retentionDays: input.retentionDays, reason: input.reason, setByActorId: ctx.actorId })
    .onConflictDoUpdate({ target: [retentionPolicies.tenantId, retentionPolicies.dataClass], set: { retentionDays: input.retentionDays, reason: input.reason, setByActorId: ctx.actorId } });
  await writeAudit(tx, ctx, { action: "retention_policy.set", entityType: "retention_policy", after: { tenantId: input.tenantId, dataClass: input.dataClass, retentionDays: input.retentionDays }, metadata: { reason: input.reason } });
}

/** Deletes rows older than the effective policy for one tenant (or the platform rows when tenantId is null). Agency scope with system or superadmin only. */
export async function sweepRetention(tx: Tx, ctx: RequestContext, input: { tenantId: string | null; now?: Date; dryRun?: boolean }): Promise<Record<DataClass, number>> {
  if (ctx.kind !== "agency" || ctx.tenantId !== input.tenantId || !hasRole(ctx, EXECUTORS)) throw new AuthorizationError("the retention sweep runs in agency scope pinned to the tenant with the system or superadmin role");
  const now = input.now ?? new Date();
  const policy = await effectiveRetention(tx, ctx, input.tenantId);
  const counts = {} as Record<DataClass, number>;
  const tenantCond = (col: AnyColumn) => (input.tenantId ? eq(col, input.tenantId) : isNull(col));
  for (const dc of DATA_CLASSES) {
    const cutoff = new Date(now.getTime() - policy[dc].days * 86_400_000);
    let deleted = 0;
    if (!input.dryRun) {
      switch (dc) {
        case "run_events": deleted = (await tx.delete(runEvents).where(and(tenantCond(runEvents.tenantId), lt(runEvents.occurredAt, cutoff))).returning({ id: runEvents.id })).length; break;
        case "retrieval_audit": deleted = input.tenantId ? (await tx.delete(retrievalAudit).where(and(eq(retrievalAudit.tenantId, input.tenantId), lt(retrievalAudit.occurredAt, cutoff))).returning({ id: retrievalAudit.id })).length : 0; break;
        case "notifications": deleted = (await tx.delete(notifications).where(and(tenantCond(notifications.tenantId), lt(notifications.createdAt, cutoff))).returning({ id: notifications.id })).length; break;
        case "sync_runs": deleted = input.tenantId ? (await tx.delete(syncRuns).where(and(eq(syncRuns.tenantId, input.tenantId), lt(syncRuns.startedAt, cutoff))).returning({ id: syncRuns.id })).length : 0; break;
        case "knowledge_access_logs": deleted = input.tenantId ? (await tx.delete(knowledgeAccessLogs).where(and(eq(knowledgeAccessLogs.tenantId, input.tenantId), lt(knowledgeAccessLogs.accessedAt, cutoff))).returning({ id: knowledgeAccessLogs.id })).length : 0; break;
        case "cost_events": deleted = (await tx.delete(costEvents).where(and(tenantCond(costEvents.tenantId), lt(costEvents.occurredAt, cutoff))).returning({ id: costEvents.id })).length; break;
      }
    }
    counts[dc] = deleted;
    if (deleted > 0) await tx.insert(retentionSweeps).values({ tenantId: input.tenantId, dataClass: dc, cutoff, deletedCount: deleted });
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0) await writeAudit(tx, ctx, { action: "retention.swept", entityType: "tenant", entityId: input.tenantId, after: counts });
  return counts;
}

// Deletion requests --------------------------------------------------------------------------------

export type DeletionKind = (typeof schema.deletionKind.enumValues)[number];

export async function requestDeletion(tx: Tx, ctx: RequestContext, input: { tenantId: string; kind: DeletionKind; subjectRef: string; reason: string; userId?: string | null }): Promise<string> {
  if (ctx.kind === "operator" || ctx.tenantId !== input.tenantId) throw new AuthorizationError("a deletion request is made inside the tenant's context");
  if (ctx.actorType === "agent") throw new AuthorizationError("agents cannot request deletions");
  if (!hasRole(ctx, ["client_admin", "superadmin", "agency_reviewer", "agency_operator"])) throw new AuthorizationError("deletion requests come from the client admin or agency staff");
  if (input.reason.trim().length < 10) throw new Error("state the reason or legal basis (at least 10 characters)");
  const [row] = await tx.insert(deletionRequests).values({ tenantId: input.tenantId, kind: input.kind, subjectRef: input.subjectRef.slice(0, 500), reason: input.reason, requestedByActorType: ctx.actorType, requestedByActorId: ctx.actorId, requestedByUserId: input.userId ?? null }).returning({ id: deletionRequests.id });
  if (!row) throw new Error("deletion request insert returned nothing");
  await writeAudit(tx, ctx, { action: "deletion_request.created", entityType: "deletion_request", entityId: row.id, after: { kind: input.kind, subjectRef: input.subjectRef.slice(0, 200) } });
  return row.id;
}

export async function decideDeletion(tx: Tx, ctx: RequestContext, input: { tenantId: string; requestId: string; decision: "approved" | "rejected"; note: string; legalHold?: boolean }): Promise<void> {
  if (ctx.kind !== "agency" || ctx.tenantId !== input.tenantId || !hasRole(ctx, REVIEWERS)) throw new AuthorizationError("deciding a deletion request is an agency reviewer or superadmin decision in agency scope pinned to the tenant");
  if (input.note.trim().length < 5) throw new Error("a review note is required");
  await tx.update(deletionRequests).set({ state: input.decision, reviewNote: input.note, legalHold: input.legalHold ?? false }).where(and(eq(deletionRequests.id, input.requestId), eq(deletionRequests.tenantId, input.tenantId)));
  await writeAudit(tx, ctx, { action: `deletion_request.${input.decision}`, entityType: "deletion_request", entityId: input.requestId, metadata: { note: input.note, legalHold: input.legalHold ?? false } });
}

/**
 * Executes an approved request. `document` deletes one vault document with its revisions and links;
 * `connection_data` deletes the sync runs and the observations they produced for one connection. `subject_data`
 * and `tenant_offboarding` are not automated: they follow the runbook and are completed with a written summary
 * through `completeDeletionManually`. Audit events stay.
 */
export async function executeDeletionRequest(tx: Tx, ctx: RequestContext, input: { tenantId: string; requestId: string }): Promise<Record<string, number>> {
  if (ctx.kind !== "agency" || ctx.tenantId !== input.tenantId || !hasRole(ctx, EXECUTORS)) throw new AuthorizationError("deletion runs in agency scope pinned to the tenant with the system or superadmin role");
  const [req] = await tx.select().from(deletionRequests).where(and(eq(deletionRequests.id, input.requestId), eq(deletionRequests.tenantId, input.tenantId)));
  if (!req) throw new Error("deletion request not found");
  if (req.state !== "approved") throw new Error(`deletion request is ${req.state}; only approved requests are executed`);
  if (req.kind === "subject_data" || req.kind === "tenant_offboarding") throw new Error(`${req.kind} is not automated; follow the runbook and complete the request with a summary`);
  await tx.update(deletionRequests).set({ state: "executing" }).where(eq(deletionRequests.id, req.id));
  const summary: Record<string, number> = {};
  if (req.kind === "document") {
    const [doc] = await tx.select({ id: vaultDocuments.id }).from(vaultDocuments).where(and(eq(vaultDocuments.tenantId, input.tenantId), eq(vaultDocuments.path, req.subjectRef)));
    if (doc) {
      summary.vault_links = (await tx.delete(vaultLinks).where(and(eq(vaultLinks.tenantId, input.tenantId), sql`${vaultLinks.fromDocumentId} = ${doc.id} OR ${vaultLinks.toDocumentId} = ${doc.id}`)).returning({ id: vaultLinks.id })).length;
      summary.vault_revisions = (await tx.delete(vaultRevisions).where(and(eq(vaultRevisions.tenantId, input.tenantId), eq(vaultRevisions.documentId, doc.id))).returning({ id: vaultRevisions.id })).length;
      summary.vault_documents = (await tx.delete(vaultDocuments).where(eq(vaultDocuments.id, doc.id)).returning({ id: vaultDocuments.id })).length;
    } else {
      summary.vault_documents = 0;
    }
  } else if (req.kind === "connection_data") {
    const runs = await tx.select({ id: syncRuns.id }).from(syncRuns).where(and(eq(syncRuns.tenantId, input.tenantId), eq(syncRuns.connectionId, req.subjectRef)));
    const ids = runs.map((r) => r.id);
    summary.kpi_observations = ids.length ? (await tx.delete(kpiObservations).where(and(eq(kpiObservations.tenantId, input.tenantId), sql`${kpiObservations.syncRunId} = ANY(${sql.raw(`ARRAY[${ids.map((i) => `'${i}'`).join(",")}]::uuid[]`)})`)).returning({ id: kpiObservations.id })).length : 0;
    summary.sync_runs = ids.length ? (await tx.delete(syncRuns).where(and(eq(syncRuns.tenantId, input.tenantId), eq(syncRuns.connectionId, req.subjectRef))).returning({ id: syncRuns.id })).length : 0;
  }
  await tx.update(deletionRequests).set({ state: "completed", summary }).where(eq(deletionRequests.id, req.id));
  await writeAudit(tx, ctx, { action: "deletion_request.executed", entityType: "deletion_request", entityId: req.id, after: { kind: req.kind, ...summary } });
  return summary;
}

export async function completeDeletionManually(tx: Tx, ctx: RequestContext, input: { tenantId: string; requestId: string; summary: string }): Promise<void> {
  if (ctx.kind !== "agency" || ctx.tenantId !== input.tenantId || !hasRole(ctx, ["superadmin"])) throw new AuthorizationError("manual completion is a superadmin action in agency scope pinned to the tenant");
  if (input.summary.trim().length < 20) throw new Error("describe what was deleted or corrected and where (at least 20 characters)");
  const [req] = await tx.select({ state: deletionRequests.state }).from(deletionRequests).where(and(eq(deletionRequests.id, input.requestId), eq(deletionRequests.tenantId, input.tenantId)));
  if (!req) throw new Error("deletion request not found");
  if (req.state !== "approved") throw new Error(`deletion request is ${req.state}`);
  await tx.update(deletionRequests).set({ state: "executing" }).where(eq(deletionRequests.id, input.requestId));
  await tx.update(deletionRequests).set({ state: "completed", summary: { manual: true, note: input.summary } }).where(eq(deletionRequests.id, input.requestId));
  await writeAudit(tx, ctx, { action: "deletion_request.completed_manually", entityType: "deletion_request", entityId: input.requestId, metadata: { summary: input.summary } });
}

/** Approved, automatable requests across tenants (operator or agency view) for the worker. */
export async function approvedDeletionRequests(tx: Tx, ctx: RequestContext): Promise<Array<{ id: string; tenantId: string; kind: DeletionKind }>> {
  if (ctx.kind === "tenant") throw new AuthorizationError("listed across tenants by the worker");
  const rows = await tx.select({ id: deletionRequests.id, tenantId: deletionRequests.tenantId, kind: deletionRequests.kind }).from(deletionRequests).where(and(eq(deletionRequests.state, "approved"), sql`${deletionRequests.kind} IN ('document', 'connection_data')`));
  return rows;
}
