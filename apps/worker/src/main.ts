import { createServer } from "node:http";
import { PgBoss } from "pg-boss";
import { createDb, tenantContext } from "@sbos/db";
import { raiseIncident } from "@sbos/core";
import { runConnectionSync } from "@sbos/connectors";
import { enqueueDueSyncs, markStale } from "./connectors";
import { runTechWatch } from "./tech-watch";
import { runRetentionSweep } from "./retention";
import { BossJobBackend, DEAD_LETTER, ensureQueues } from "./boss-backend";
import { readEnv } from "./env";
import { executeRun, failRunFromDeadLetter, recoverExpiredLeases } from "./executor";
import { log } from "./log";
import { markNotificationFailed, sendNotification } from "./notify";
import { platformBudget } from "./platform";
import { checkStalledSchedules, handleScheduleTick, reconcileSchedules } from "./schedules";

/**
 * Second Brain OS worker: the only process that executes agents (ADR-012). Runs forever on our infrastructure,
 * driven by pg-boss schedules and jobs stored in PostgreSQL. No developer session is involved.
 */
async function main(): Promise<void> {
  const env = readEnv();
  const handle = createDb({ connectionString: env.databaseUrl, max: 8 });
  const boss = new PgBoss({ connectionString: env.databaseUrl, schema: "pgboss", supervise: true, schedule: true });
  const jobs = new BossJobBackend(boss);
  const state = { startedAt: new Date(), lastStallCheckAt: null as Date | null, lastReconcileAt: null as Date | null, runsStarted: 0, runsFailed: 0, syncsRun: 0, mode: env.forceSimulated || !env.anthropicApiKey ? "simulated" : "live" };

  boss.on("error", (err) => log("error", "pg-boss error", { error: (err as Error).message }));
  await boss.start();
  await ensureQueues(boss);
  log("info", "worker started", { mode: state.mode, model: env.defaultModel, concurrency: env.concurrency });

  // Recovery first: anything left running by a previous instance is re-queued from its checkpoint.
  const recovered = await recoverExpiredLeases(handle, jobs);
  if (recovered > 0) log("warn", "recovered interrupted runs", { count: recovered });

  await boss.work<{ tenantId: string; runId: string }>("agent.run", { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    state.runsStarted += 1;
    const platform = await platformBudget(handle);
    try {
      await executeRun(handle, env, jobs, platform, { tenantId: job.data.tenantId, runId: job.data.runId, resume: false });
    } catch (err) {
      state.runsFailed += 1;
      throw err;
    }
  });

  await boss.work<{ tenantId: string; runId: string; reason: string }>("agent.resume", { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    const platform = await platformBudget(handle);
    await executeRun(handle, env, jobs, platform, { tenantId: job.data.tenantId, runId: job.data.runId, resume: true });
  });

  await boss.work<{ tenantId: string; scheduleId: string }>("schedule.tick", { batchSize: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
    if (!job) return;
    await handleScheduleTick(handle, jobs, job.data);
  });

  await boss.work<{ notificationId: string }>("notify.send", { batchSize: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
    if (!job) return;
    await sendNotification(handle, env, job.data.notificationId);
  });

  // Integrations (M5): one sync job per due connection; the metadata phase never leaves the platform.
  await boss.work<{ tenantId: string; connectionId: string; trigger: "schedule" | "manual" | "test" }>("connector.sync", { batchSize: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
    if (!job) return;
    const result = await runConnectionSync(handle, jobs, { tenantId: job.data.tenantId, connectionId: job.data.connectionId, trigger: job.data.trigger });
    log(result.status === "failed" ? "warn" : "info", "connector sync finished", { connectionId: job.data.connectionId, status: result.status, mode: result.mode, observations: result.observationsWritten, networkCalls: result.networkCalls });
    state.syncsRun++;
  });
  await boss.work("sync.tick", { batchSize: 1, pollingIntervalSeconds: 15 }, async () => {
    const queued = await enqueueDueSyncs(handle, jobs);
    if (queued > 0) log("info", "connector syncs queued", { queued });
    const stale = await markStale(handle, jobs);
    if (stale.connections > 0) log("warn", "stale connections marked", stale);
  });

  // Technology Intelligence (M6): approved sources only, detection only; retention: weekly sweep and approved deletions.
  await boss.work("tech.watch", { batchSize: 1, pollingIntervalSeconds: 30 }, async () => {
    const r = await runTechWatch(handle, env);
    log("info", "tech watch finished", r);
  });
  await boss.work("retention.sweep", { batchSize: 1, pollingIntervalSeconds: 30 }, async () => {
    const r = await runRetentionSweep(handle);
    log("info", "retention sweep finished", r);
  });

  await boss.work("stall.check", { batchSize: 1, pollingIntervalSeconds: 10 }, async () => {
    const missed = await checkStalledSchedules(handle, jobs);
    const recoveredNow = await recoverExpiredLeases(handle, jobs);
    state.lastStallCheckAt = new Date();
    if (missed || recoveredNow) log("warn", "stall check found issues", { missed, recovered: recoveredNow });
  });

  // Dead-letter consumer: every exhausted job becomes a failed run or failed notification plus an incident.
  await boss.work<Record<string, unknown>>(DEAD_LETTER, { batchSize: 1, pollingIntervalSeconds: 10 }, async ([job]) => {
    if (!job) return;
    const data = job.data;
    if (typeof data.runId === "string" && typeof data.tenantId === "string") {
      await failRunFromDeadLetter(handle, jobs, data.tenantId, data.runId, "job retries exhausted");
    } else if (typeof data.notificationId === "string") {
      await markNotificationFailed(handle, data.notificationId);
    } else if (typeof data.connectionId === "string" && typeof data.tenantId === "string") {
      const ctx = tenantContext({ tenantId: data.tenantId, actorType: "system", actorId: "worker:dead-letter", roles: ["system"] });
      await handle.withContext(ctx, (tx) => raiseIncident(tx, jobs, { tenantId: data.tenantId as string, kind: "worker_error", severity: "high", title: "Connector sync failed after retries", details: { connectionId: data.connectionId }, dedupeKey: `connector-dead-letter:${data.connectionId}` }));
    } else if (typeof data.scheduleId === "string" && typeof data.tenantId === "string") {
      const ctx = tenantContext({ tenantId: data.tenantId, actorType: "system", actorId: "worker:dead-letter", roles: ["agent_service"] });
      await handle.withContext(ctx, (tx) => raiseIncident(tx, jobs, { tenantId: data.tenantId as string, kind: "worker_error", severity: "high", title: "Schedule tick failed after retries", details: { scheduleId: data.scheduleId }, scheduleId: data.scheduleId as string, dedupeKey: `tick:${data.scheduleId}` }));
    }
    log("warn", "dead-letter job handled", { data: Object.keys(data) });
  });

  // Internal clocks.
  await boss.schedule("stall.check", "*/5 * * * *", {}, { tz: "UTC", key: "stall-check" });
  await boss.schedule("sync.tick", "*/5 * * * *", {}, { tz: "UTC", key: "sync-tick" });
  await boss.schedule("tech.watch", "0 6 * * *", {}, { tz: "UTC", key: "tech-watch" });
  await boss.schedule("retention.sweep", "0 3 * * 0", {}, { tz: "UTC", key: "retention-sweep" });
  await reconcileSchedules(handle, boss, jobs);
  state.lastReconcileAt = new Date();
  const reconcileTimer = setInterval(() => {
    reconcileSchedules(handle, boss, jobs)
      .then(() => (state.lastReconcileAt = new Date()))
      .catch((err) => log("error", "reconcile failed", { error: (err as Error).message }));
  }, 60_000);

  // Health endpoint for the platform (Railway health check, Compose healthcheck).
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      const body = { status: "ok", mode: state.mode, startedAt: state.startedAt.toISOString(), lastStallCheckAt: state.lastStallCheckAt?.toISOString() ?? null, lastReconcileAt: state.lastReconcileAt?.toISOString() ?? null, runsStarted: state.runsStarted, runsFailed: state.runsFailed, syncsRun: state.syncsRun };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(env.port, () => log("info", "health endpoint listening", { port: env.port }));

  const shutdown = async (signal: string) => {
    log("info", "shutting down", { signal });
    clearInterval(reconcileTimer);
    server.close();
    await boss.stop({ graceful: true, timeout: 30_000 });
    await handle.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log("error", "worker crashed", { error: (err as Error).message });
  process.exit(1);
});
