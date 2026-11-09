import { PgBoss } from "pg-boss";
import { DEAD_LETTER, QUEUE_OPTIONS, toBossSendOptions, type EnqueueOptions, type JobBackend, type JobName } from "@sbos/core";
import { requireEnv } from "./env";

/**
 * pg-boss producer for the web app (ADR-013). The web only enqueues; it never works jobs and never
 * supervises or schedules (that is the worker's job, ADR-012). One instance per server process,
 * started lazily on first use and cached on globalThis because Next.js may evaluate modules twice in dev.
 * Queue policies are shared with the worker through `QUEUE_OPTIONS` in @sbos/core.
 */
class WebJobBackend implements JobBackend {
  constructor(private readonly boss: PgBoss) {}

  async enqueue<T extends object>(name: JobName, payload: T, options?: EnqueueOptions): Promise<string | null> {
    // pg-boss asserts on an explicit `priority: undefined`, so only defined keys are passed.
    return this.boss.send(name, payload, toBossSendOptions(name, options));
  }
}

const globalForBoss = globalThis as unknown as { __sbosBoss?: Promise<PgBoss> };

async function startBoss(): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: requireEnv("DATABASE_URL"), schema: "pgboss", supervise: false, schedule: false, max: 2 });
  boss.on("error", (err) => console.error("[jobs] pg-boss error:", (err as Error).message));
  await boss.start();
  // The worker normally creates the queues at its start; make sure they exist when the web app enqueues first.
  if (!(await boss.getQueue(DEAD_LETTER))) await boss.createQueue(DEAD_LETTER);
  for (const [name, q] of Object.entries(QUEUE_OPTIONS)) {
    if (await boss.getQueue(name)) continue;
    await boss.createQueue(name, { retryLimit: q.retryLimit, retryDelay: q.retryDelay, retryBackoff: q.retryBackoff, expireInSeconds: q.expireInSeconds, deadLetter: DEAD_LETTER });
  }
  return boss;
}

/** Returns the shared JobBackend. The first call starts pg-boss; a failed start is retried on the next call. */
export async function getJobs(): Promise<JobBackend> {
  if (!globalForBoss.__sbosBoss) {
    globalForBoss.__sbosBoss = startBoss().catch((err: unknown) => {
      globalForBoss.__sbosBoss = undefined;
      throw err;
    });
  }
  return new WebJobBackend(await globalForBoss.__sbosBoss);
}
