import { CronExpressionParser } from "cron-parser";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { schema, tenantContext, type DbHandle } from "@sbos/db";
import { createRun, createTask, raiseIncident, type JobBackend } from "@sbos/core";
import { log } from "./log";
import { OPERATOR } from "./platform";

const { schedules, agentInstances, agentRuns } = schema;
const TICK = "schedule.tick";

export function nextRun(cron: string, timezone: string, from = new Date()): Date | null {
  try {
    return CronExpressionParser.parse(cron, { currentDate: from, tz: timezone }).next().toDate();
  } catch {
    return null;
  }
}

/**
 * Keeps pg-boss cron schedules in sync with the `schedules` table. pg-boss is the clock; the row is the truth.
 * Runs at startup and every minute. Each pg-boss schedule key is the schedule row id.
 */
export async function reconcileSchedules(handle: DbHandle, boss: PgBoss, jobs: JobBackend): Promise<void> {
  const rows = await handle.withContext(OPERATOR, (tx) => tx.select().from(schedules));
  const existing = await boss.getSchedules(TICK);
  const existingByKey = new Map(existing.map((s) => [s.key, s]));

  for (const row of rows) {
    const key = row.id;
    const next = nextRun(row.cron, row.timezone);
    if (!next) {
      await handle.withContext(tenantContext({ tenantId: row.tenantId, actorType: "system", actorId: "worker:scheduler", roles: ["agent_service"] }), (tx) =>
        raiseIncident(tx, jobs, { tenantId: row.tenantId, kind: "worker_error", severity: "medium", title: `Invalid cron expression on schedule "${row.name}"`, scheduleId: row.id, dedupeKey: `cron:${row.id}` })
      );
      continue;
    }
    if (row.enabled) {
      const current = existingByKey.get(key);
      if (!current || current.cron !== row.cron || current.timezone !== row.timezone) {
        await boss.schedule(TICK, row.cron, { tenantId: row.tenantId, scheduleId: row.id }, { tz: row.timezone, key });
        log("info", "schedule registered", { scheduleId: row.id, cron: row.cron, tz: row.timezone });
      }
    } else if (existingByKey.has(key)) {
      await boss.unschedule(TICK, key);
      log("info", "schedule removed (disabled)", { scheduleId: row.id });
    }
    // next_run_at is display and stall-alarm metadata; write it in tenant scope.
    await handle.withContext(tenantContext({ tenantId: row.tenantId, actorType: "system", actorId: "worker:scheduler", roles: ["agent_service"] }), async (tx) => {
      await tx.update(schedules).set({ nextRunAt: row.enabled ? next : null }).where(eq(schedules.id, row.id));
      await tx.update(agentInstances).set({ nextScheduledRunAt: row.enabled ? next : null }).where(eq(agentInstances.id, row.agentInstanceId));
    });
    existingByKey.delete(key);
  }
  // Schedules in pg-boss whose row disappeared.
  for (const orphan of existingByKey.values()) {
    if (orphan.key) await boss.unschedule(TICK, orphan.key);
  }
}

/** A cron tick: create a task and a run for the schedule's agent instance (misfire policy respected by pg-boss itself). */
export async function handleScheduleTick(handle: DbHandle, jobs: JobBackend, payload: { tenantId: string; scheduleId: string }): Promise<void> {
  const ctx = tenantContext({ tenantId: payload.tenantId, actorType: "system", actorId: "worker:scheduler", roles: ["agent_service"] });
  await handle.withContext(ctx, async (tx) => {
    const [row] = await tx.select().from(schedules).where(and(eq(schedules.id, payload.scheduleId), eq(schedules.tenantId, payload.tenantId)));
    if (!row || !row.enabled) {
      log("info", "tick ignored: schedule missing or disabled", payload);
      return;
    }
    const taskId = await createTask(tx, ctx, {
      tenantId: payload.tenantId,
      agentInstanceId: row.agentInstanceId,
      title: row.name,
      instruction: row.instruction ?? `Scheduled run of "${row.name}"`,
      priority: "medium",
      createdBy: { actorType: "system", actorId: "worker:scheduler" },
      metadata: { scheduleId: row.id }
    });
    await createRun(tx, ctx, jobs, { tenantId: payload.tenantId, agentInstanceId: row.agentInstanceId, trigger: "schedule", triggerRef: row.id, taskId, scheduleId: row.id });
    await tx.update(schedules).set({ lastRunAt: new Date(), nextRunAt: nextRun(row.cron, row.timezone) }).where(eq(schedules.id, row.id));
  });
}

/**
 * Stall alarm: an enabled schedule whose next_run_at + expected_by window has passed without a run is an incident.
 * Silence is never success (spec 4E).
 */
export async function checkStalledSchedules(handle: DbHandle, jobs: JobBackend): Promise<number> {
  const rows = await handle.withContext(OPERATOR, (tx) =>
    tx
      .select({ id: schedules.id, tenantId: schedules.tenantId, name: schedules.name, nextRunAt: schedules.nextRunAt, lastRunAt: schedules.lastRunAt, expectedBySeconds: schedules.expectedBySeconds, cron: schedules.cron, timezone: schedules.timezone })
      .from(schedules)
      .where(eq(schedules.enabled, true))
  );
  let missed = 0;
  for (const s of rows) {
    if (!s.nextRunAt) continue;
    const deadline = new Date(s.nextRunAt.getTime() + s.expectedBySeconds * 1000);
    if (deadline > new Date()) continue;
    const ctx = tenantContext({ tenantId: s.tenantId, actorType: "system", actorId: "worker:stall-check", roles: ["agent_service"] });
    const ran = await handle.withContext(ctx, (tx) =>
      tx.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.scheduleId, s.id), sql`${agentRuns.createdAt} >= ${s.nextRunAt}`)).limit(1)
    );
    if (ran.length > 0) {
      await handle.withContext(ctx, (tx) => tx.update(schedules).set({ nextRunAt: nextRun(s.cron, s.timezone) }).where(eq(schedules.id, s.id)));
      continue;
    }
    missed += 1;
    await handle.withContext(ctx, async (tx) => {
      await raiseIncident(tx, jobs, { tenantId: s.tenantId, kind: "missed_schedule", severity: "high", title: `Scheduled run "${s.name}" did not start`, details: { scheduleId: s.id, expectedAt: s.nextRunAt?.toISOString() }, scheduleId: s.id, dedupeKey: `missed:${s.id}:${s.nextRunAt?.toISOString()}` });
      await tx.update(schedules).set({ nextRunAt: nextRun(s.cron, s.timezone) }).where(eq(schedules.id, s.id));
    });
  }
  return missed;
}
