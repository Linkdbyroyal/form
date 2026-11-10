import { desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { schema, type TenantContext } from "@sbos/db";
import { DATA_CLASSES, effectiveRetention, RETENTION_MINIMUM_DAYS, type DataClass } from "@sbos/core";
import { getDb } from "../db";

/**
 * Data & Retention reads for the client workspace (Milestone 6). Every function runs in TENANT context: RLS
 * returns the tenant's own override rows plus the platform defaults (policy `retention_policies_defaults_read`),
 * the tenant's deletion requests with their review notes and summaries (its own data), and the retention sweeps
 * the worker recorded for this tenant. Nothing here deletes; the sweep and the requests are executed by the worker.
 */
const { retentionPolicies, retentionSweeps, deletionRequests, users } = schema;

export interface RetentionClassView {
  dataClass: DataClass;
  label: string;
  days: number;
  source: "default" | "tenant";
  reason: string;
  floor: number;
  /** The tenant override row, when one exists. */
  override: { days: number; reason: string; setByActorId: string; updatedAt: Date } | null;
  /** The platform default row, for comparison. */
  platformDefault: { days: number; reason: string } | null;
}

export interface DeletionRequestView {
  id: string;
  kind: string;
  subjectRef: string;
  reason: string;
  state: string;
  legalHold: boolean;
  requestedByActorType: string;
  requestedByActorId: string;
  requestedByName: string | null;
  reviewerActorId: string | null;
  reviewNote: string | null;
  decidedAt: Date | null;
  executedAt: Date | null;
  summary: Record<string, unknown>;
  createdAt: Date;
}

export interface SweepView {
  id: string;
  dataClass: string;
  cutoff: Date;
  deletedCount: number;
  ranAt: Date;
}

export interface RetentionCenter {
  classes: RetentionClassView[];
  requests: DeletionRequestView[];
  sweeps: SweepView[];
}

export async function getRetentionCenter(ctx: TenantContext): Promise<RetentionCenter> {
  return getDb().withContext(ctx, async (tx) => {
    const effective = await effectiveRetention(tx, ctx, ctx.tenantId);
    const rows = await tx.select().from(retentionPolicies).where(or(eq(retentionPolicies.tenantId, ctx.tenantId), isNull(retentionPolicies.tenantId)));
    const classes: RetentionClassView[] = DATA_CLASSES.map((dc) => {
      const override = rows.find((r) => r.dataClass === dc && r.tenantId === ctx.tenantId);
      const def = rows.find((r) => r.dataClass === dc && r.tenantId === null);
      return {
        dataClass: dc,
        label: dc.replaceAll("_", " "),
        days: effective[dc].days,
        source: effective[dc].source,
        reason: effective[dc].reason,
        floor: RETENTION_MINIMUM_DAYS[dc],
        override: override ? { days: override.retentionDays, reason: override.reason, setByActorId: override.setByActorId, updatedAt: override.updatedAt } : null,
        platformDefault: def ? { days: def.retentionDays, reason: def.reason } : null
      };
    });
    const reqs = await tx.select().from(deletionRequests).where(eq(deletionRequests.tenantId, ctx.tenantId)).orderBy(desc(deletionRequests.createdAt)).limit(100);
    const userIds = [...new Set(reqs.map((r) => r.requestedByUserId).filter((v): v is string => Boolean(v)))];
    const names = userIds.length === 0 ? [] : await tx.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, userIds));
    const nameById = new Map(names.map((u) => [u.id, u.displayName]));
    const requests: DeletionRequestView[] = reqs.map((r) => ({
      id: r.id,
      kind: r.kind,
      subjectRef: r.subjectRef,
      reason: r.reason,
      state: r.state,
      legalHold: r.legalHold,
      requestedByActorType: r.requestedByActorType,
      requestedByActorId: r.requestedByActorId,
      requestedByName: r.requestedByUserId ? (nameById.get(r.requestedByUserId) ?? null) : null,
      reviewerActorId: r.reviewerActorId,
      reviewNote: r.reviewNote,
      decidedAt: r.decidedAt,
      executedAt: r.executedAt,
      summary: r.summary,
      createdAt: r.createdAt
    }));
    const sweeps = await tx.select({ id: retentionSweeps.id, dataClass: retentionSweeps.dataClass, cutoff: retentionSweeps.cutoff, deletedCount: retentionSweeps.deletedCount, ranAt: retentionSweeps.ranAt }).from(retentionSweeps).where(eq(retentionSweeps.tenantId, ctx.tenantId)).orderBy(desc(retentionSweeps.ranAt)).limit(50);
    return { classes, requests, sweeps };
  });
}

/** Counts per state for the header; cheap and tenant-scoped. */
export async function countDeletionRequests(ctx: TenantContext): Promise<Map<string, number>> {
  return getDb().withContext(ctx, async (tx) => {
    const rows = await tx.select({ state: deletionRequests.state, n: sql<number>`count(*)`.mapWith(Number) }).from(deletionRequests).where(eq(deletionRequests.tenantId, ctx.tenantId)).groupBy(deletionRequests.state);
    return new Map(rows.map((r) => [r.state, r.n]));
  });
}
