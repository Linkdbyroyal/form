/**
 * The only abstraction that knows about the queue library (ADR-013). pg-boss implements it in apps/worker;
 * tests use an in-memory implementation. Web and core enqueue through this interface, never directly.
 */
export type JobName = "agent.run" | "agent.resume" | "schedule.tick" | "stall.check" | "notify.send" | "recovery.scan";

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
  "recovery.scan": { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 120 }
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

/** In-memory backend for tests and for the web app when no queue is configured in dev. */
export class MemoryJobBackend implements JobBackend {
  public readonly jobs: Array<{ name: JobName; payload: object; options?: EnqueueOptions }> = [];
  async enqueue<T extends object>(name: JobName, payload: T, options?: EnqueueOptions): Promise<string | null> {
    this.jobs.push({ name, payload, options });
    return `mem-${this.jobs.length}`;
  }
}
