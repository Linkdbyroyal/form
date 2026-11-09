import type { z } from "zod";
import type { DbHandle, TenantContext, Tx } from "@sbos/db";
import type { JobBackend } from "@sbos/core";
import type { AgentRuntime, ToolGateway, TenantSnapshot } from "@sbos/agents";
import type { WorkerEnv } from "../env";

export interface LoadedRun {
  run: { id: string; taskId: string | null; scheduleId: string | null; state: string; attempt: number; checkpoint: unknown };
  instance: { id: string; serviceIdentity: string; model: string | null; definitionId: string; state: string; config: unknown };
  definition: { id: string; key: string; name: string; department: string | null; defaultModel: string; allowedTools: string[] };
  skill: { id: string; version: string; skillMd: string; allowedTools: string[] };
  tenant: { id: string; slug: string; name: string; industry: string | null; locale: string; kind: string };
}

/** Everything a flow step may use. Steps open their own transactions through `tx()`; model calls happen outside transactions. */
export interface FlowRuntime extends LoadedRun {
  handle: DbHandle;
  env: WorkerEnv;
  jobs: JobBackend;
  ctx: TenantContext;
  gateway: ToolGateway;
  simulated: boolean;
  model: string;
  runCapUsd: number;
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Creates the model runtime; in simulated mode `fixture` produces the output. */
  runtime(fixture: () => unknown): AgentRuntime;
  /** Runs a structured model call with budget pre-check, cost recording and a `model_call` event. */
  generate<T>(input: { schema: z.ZodType<T>; prompt: string; fixture: () => unknown; summary: string; maxOutputTokens?: number }): Promise<{ object: T; simulated: boolean; model: string }>;
  event(kind: string, summary: string, payload?: Record<string, unknown>, classification?: "public" | "internal" | "confidential" | "restricted"): Promise<void>;
  saveCheckpoint(cp: Record<string, unknown>, summary: string): Promise<void>;
  /** Assembles the tenant snapshot (facts through retrieval audit). */
  snapshot(): Promise<TenantSnapshot>;
}

export interface BaseCheckpoint {
  step: string;
  [key: string]: unknown;
}

export type StepOutcome<C extends BaseCheckpoint> = { kind: "next"; checkpoint: C } | { kind: "suspend"; checkpoint: C; reason: string };

export interface Flow<C extends BaseCheckpoint = BaseCheckpoint> {
  key: string;
  initial: () => C;
  steps: Record<string, (rt: FlowRuntime, cp: C) => Promise<StepOutcome<C>>>;
  /** Called when `cp.step === "done"`. Returns the neutral summary and output references for AgentRunResult. */
  finalize: (rt: FlowRuntime, cp: C) => Promise<{ summary: string; outputs: Array<{ contract: string; ref_id: string }> }>;
}
