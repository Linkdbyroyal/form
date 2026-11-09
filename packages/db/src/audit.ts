import { createHash } from "node:crypto";
import { auditEvents } from "./schema/core";
import type { Tx } from "./client";
import type { RequestContext } from "./context";

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

export function stableHash(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Writes one append-only audit row inside the current transaction. */
export async function writeAudit(tx: Tx, ctx: RequestContext, input: AuditInput): Promise<void> {
  const tenantId = ctx.kind === "operator" ? null : ctx.tenantId;
  await tx.insert(auditEvents).values({
    tenantId,
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    beforeHash: stableHash(input.before),
    afterHash: stableHash(input.after),
    metadata: { roles: [...ctx.roles], ...(input.metadata ?? {}) }
  });
}
