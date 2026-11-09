import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { schema, type Tx } from "@sbos/db";
import { RunFailure } from "./errors";

const { budgets, costEvents } = schema;

export interface BudgetCheck {
  ok: boolean;
  warnings: string[];
  blockedBy?: { scope: string; capUsdMonth: number; spentUsdMonth: number };
  runCapUsd: number;
}

function monthStart(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Checks platform, tenant and agent-instance caps against month-to-date cost events.
 * Platform rows are only visible in agency/operator scope, so the caller passes the platform cap it read earlier
 * (the worker reads it once per cycle with an operator context).
 */
export async function checkBudget(tx: Tx, input: { tenantId: string; agentInstanceId: string; platform: { capUsdMonth: number; spentUsdMonth: number; hardStop: boolean; runCapUsd: number } | null }): Promise<BudgetCheck> {
  const since = monthStart();
  const warnings: string[] = [];
  let runCapUsd = input.platform?.runCapUsd ?? 0.5;

  if (input.platform && input.platform.spentUsdMonth >= input.platform.capUsdMonth) {
    if (input.platform.hardStop) return { ok: false, warnings, blockedBy: { scope: "platform", capUsdMonth: input.platform.capUsdMonth, spentUsdMonth: input.platform.spentUsdMonth }, runCapUsd };
    warnings.push("platform cap exceeded (soft)");
  } else if (input.platform && input.platform.spentUsdMonth >= input.platform.capUsdMonth * 0.8) {
    warnings.push("platform budget above 80%");
  }

  const rows = await tx.select().from(budgets).where(eq(budgets.tenantId, input.tenantId));
  const [tenantSpent] = await tx.select({ v: sql<number>`coalesce(sum(${costEvents.costUsd}), 0)`.mapWith(Number) }).from(costEvents).where(and(eq(costEvents.tenantId, input.tenantId), gte(costEvents.occurredAt, since)));
  const [instanceSpent] = await tx.select({ v: sql<number>`coalesce(sum(${costEvents.costUsd}), 0)`.mapWith(Number) }).from(costEvents).where(and(eq(costEvents.agentInstanceId, input.agentInstanceId), gte(costEvents.occurredAt, since)));

  for (const b of rows) {
    const cap = Number(b.capUsdMonth);
    const spent = b.scope === "tenant" ? (tenantSpent?.v ?? 0) : b.scope === "agent_instance" && b.agentInstanceId === input.agentInstanceId ? (instanceSpent?.v ?? 0) : null;
    if (spent === null) continue;
    runCapUsd = Math.min(runCapUsd, Number(b.runCapUsd));
    if (spent >= cap) {
      if (b.hardStop) return { ok: false, warnings, blockedBy: { scope: b.scope, capUsdMonth: cap, spentUsdMonth: spent }, runCapUsd };
      warnings.push(`${b.scope} cap exceeded (soft)`);
    } else if (spent >= cap * Number(b.warnRatio)) {
      warnings.push(`${b.scope} budget above ${Math.round(Number(b.warnRatio) * 100)}%`);
    }
  }
  return { ok: true, warnings, runCapUsd };
}

export async function recordCost(tx: Tx, input: { tenantId: string; runId: string; agentInstanceId: string; taskId?: string | null; model: string; tokensInput: number; tokensOutput: number; costUsd: number; simulated: boolean }): Promise<void> {
  await tx.insert(costEvents).values({
    tenantId: input.tenantId,
    runId: input.runId,
    agentInstanceId: input.agentInstanceId,
    taskId: input.taskId ?? null,
    model: input.model,
    tokensInput: input.tokensInput,
    tokensOutput: input.tokensOutput,
    costUsd: String(input.costUsd),
    simulated: input.simulated
  });
}

/** Operator-scope read of the platform budget and month-to-date spend across all tenants. */
export async function readPlatformBudget(tx: Tx): Promise<{ capUsdMonth: number; spentUsdMonth: number; hardStop: boolean; runCapUsd: number } | null> {
  const [b] = await tx.select().from(budgets).where(and(eq(budgets.scope, "platform"), isNull(budgets.tenantId)));
  if (!b) return null;
  const [spent] = await tx.select({ v: sql<number>`coalesce(sum(${costEvents.costUsd}), 0)`.mapWith(Number) }).from(costEvents).where(gte(costEvents.occurredAt, monthStart()));
  return { capUsdMonth: Number(b.capUsdMonth), spentUsdMonth: spent?.v ?? 0, hardStop: b.hardStop, runCapUsd: Number(b.runCapUsd) };
}

export function assertWithinRunCap(projectedUsd: number, runCapUsd: number): void {
  if (projectedUsd > runCapUsd) {
    throw new RunFailure("budget", `projected run cost ${projectedUsd.toFixed(4)} USD exceeds run cap ${runCapUsd.toFixed(4)} USD`, { projectedUsd, runCapUsd });
  }
}
