/**
 * The only abstraction that knows about the queue library (ADR-013). pg-boss implements it in apps/worker;
 * tests use an in-memory implementation. Web and core enqueue through this interface, never directly.
 */
export type JobName = "agent.run" | "agent.resume" | "schedule.tick" | "stall.check" | "notify.send" | "recovery.scan" | "connector.sync" | "sync.tick" | "tech.watch" | "retention.sweep";

export interface EnqueueOptions {
  /** Deduplicate: only one queued/active job with this key at a time. */
  singletonKey?: string;
  startAfterSeconds?: number;
  retryLimit?: number;
  priority?: number;
}

export interface JobBackend {
  enqueue<T extends object>(name: JobName, payload: T, options?: EnqueueOptions): Promise<string | null>;
}

/** Name of the pg-boss queue that receives jobs whose retries are exhausted. */
export const DEAD_LETTER = "dead-letter";

export interface QueuePolicy {
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  expireInSeconds: number;
}

/** Retry and expiry policy per queue, shared by every pg-boss producer (worker and web). */
export const QUEUE_OPTIONS: Record<JobName, QueuePolicy> = {
  "agent.run": { retryLimit: 3, retryDelay: 15, retryBackoff: true, expireInSeconds: 900 },
  "agent.resume": { retryLimit: 3, retryDelay: 15, retryBackoff: true, expireInSeconds: 900 },
  "schedule.tick": { retryLimit: 1, retryDelay: 5, retryBackoff: false, expireInSeconds: 120 },
  "stall.check": { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 120 },
  "notify.send": { retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 60 },
  "recovery.scan": { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 120 },
  "connector.sync": { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 600 },
  "sync.tick": { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 120 },
  "tech.watch": { retryLimit: 1, retryDelay: 300, retryBackoff: false, expireInSeconds: 900 },
  "retention.sweep": { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 1800 }
};

export interface AgentRunJob {
  tenantId: string;
  runId: string;
}

export interface AgentResumeJob {
  tenantId: string;
  runId: string;
  reason: "approval_decided" | "question_answered" | "operator_resume" | "recovery";
}

export interface ScheduleTickJob {
  tenantId: string;
  scheduleId: string;
}

export interface NotifyJob {
  notificationId: string;
  tenantId: string | null;
}

/** pg-boss `send` options derived from a queue policy. Keys are only present when defined: pg-boss rejects an explicit `undefined`. */
export interface BossSendOptions {
  singletonKey?: string;
  startAfter?: number;
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  expireInSeconds: number;
  deadLetter: string;
  priority?: number;
}

export function toBossSendOptions(name: JobName, options?: EnqueueOptions): BossSendOptions {
  const q = QUEUE_OPTIONS[name];
  const out: BossSendOptions = { retryLimit: options?.retryLimit ?? q.retryLimit, retryDelay: q.retryDelay, retryBackoff: q.retryBackoff, expireInSeconds: q.expireInSeconds, deadLetter: DEAD_LETTER };
  if (options?.singletonKey !== undefined) out.singletonKey = options.singletonKey;
  if (options?.startAfterSeconds !== undefined) out.startAfter = options.startAfterSeconds;
  if (options?.priority !== undefined) out.priority = options.priority;
  return out;
}

/** In-memory backend for tests and for the web app when no queue is configured in dev. */
export class MemoryJobBackend implements JobBackend {
  public readonly jobs: Array<{ name: JobName; payload: object; options?: EnqueueOptions }> = [];
  async enqueue<T extends object>(name: JobName, payload: T, options?: EnqueueOptions): Promise<string | null> {
    this.jobs.push({ name, payload, options });
    return `mem-${this.jobs.length}`;
  }
}
