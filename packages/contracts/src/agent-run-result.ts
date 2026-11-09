import { z } from "zod";
import {
  AgentOutputEnvelopeSchema,
  IsoDateTimeSchema,
  OutputRefSchema,
  PriorityLevelSchema,
  UuidSchema
} from "./common";

export const AgentRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out"
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const TokenUsageSchema = z.object({
  input: z.int().min(0),
  output: z.int().min(0),
  cost_usd: z.number().min(0).optional()
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const RunCheckpointSchema = z.object({
  checkpoint_id: UuidSchema,
  at: IsoDateTimeSchema,
  note: z.string().min(1).describe("What state was reached at this checkpoint")
});
export type RunCheckpoint = z.infer<typeof RunCheckpointSchema>;

export const RunErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean()
});
export type RunError = z.infer<typeof RunErrorSchema>;

export const HelpRequestKindSchema = z
  .enum(["missing_data", "contradiction", "connection_error", "policy_decision", "business_approval"])
  .describe("Why the agent needs a human");
export type HelpRequestKind = z.infer<typeof HelpRequestKindSchema>;

export const HelpRequestSchema = z.object({
  kind: HelpRequestKindSchema,
  message: z.string().min(1),
  owner_role: z.string().min(1).describe("Role expected to resolve the request"),
  urgency: PriorityLevelSchema,
  deadline: IsoDateTimeSchema.optional()
});
export type HelpRequest = z.infer<typeof HelpRequestSchema>;

/** Outcome of one agent run. The envelope run_id is optional; the run_id here is required. */
export const AgentRunResultSchema = AgentOutputEnvelopeSchema.extend({
  run_id: UuidSchema,
  agent_id: z.string().min(1),
  task_id: UuidSchema.optional(),
  status: AgentRunStatusSchema,
  started_at: IsoDateTimeSchema,
  finished_at: IsoDateTimeSchema.optional(),
  summary: z.string().min(1),
  outputs: z.array(OutputRefSchema).describe("Records produced by the run, by contract name and id"),
  tools_used: z.array(z.string()),
  token_usage: TokenUsageSchema,
  checkpoints: z.array(RunCheckpointSchema),
  error: RunErrorSchema.optional(),
  help_requests: z.array(HelpRequestSchema)
});
export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;
