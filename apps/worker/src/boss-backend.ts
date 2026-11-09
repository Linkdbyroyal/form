import { PgBoss } from "pg-boss";
import { DEAD_LETTER, QUEUE_OPTIONS, type EnqueueOptions, type JobBackend, type JobName } from "@sbos/core";

// Queue policies live in @sbos/core so the web app enqueues with the same retry and expiry settings.
export { DEAD_LETTER, QUEUE_OPTIONS };

/** pg-boss implementation of JobBackend (ADR-013). */
export class BossJobBackend implements JobBackend {
  constructor(private readonly boss: PgBoss) {}

  async enqueue<T extends object>(name: JobName, payload: T, options?: EnqueueOptions): Promise<string | null> {
    const q = QUEUE_OPTIONS[name];
    // pg-boss validates option types strictly and rejects explicit `undefined`, so only set keys that have values.
    const sendOptions: Record<string, unknown> = {
      retryLimit: options?.retryLimit ?? q.retryLimit,
      retryDelay: q.retryDelay,
      retryBackoff: q.retryBackoff,
      expireInSeconds: q.expireInSeconds,
      deadLetter: DEAD_LETTER
    };
    if (options?.singletonKey) sendOptions.singletonKey = options.singletonKey;
    if (options?.startAfterSeconds !== undefined) sendOptions.startAfter = options.startAfterSeconds;
    if (options?.priority !== undefined) sendOptions.priority = options.priority;
    return this.boss.send(name, payload, sendOptions as Parameters<PgBoss["send"]>[2]);
  }
}

export async function ensureQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(DEAD_LETTER);
  for (const [name, q] of Object.entries(QUEUE_OPTIONS)) {
    await boss.createQueue(name, { retryLimit: q.retryLimit, retryDelay: q.retryDelay, retryBackoff: q.retryBackoff, expireInSeconds: q.expireInSeconds, deadLetter: DEAD_LETTER });
  }
}
