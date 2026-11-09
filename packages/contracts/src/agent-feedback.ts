import { z } from "zod";
import { IsoDateTimeSchema, OutputRefSchema, UuidSchema } from "./common";

export const FeedbackKindSchema = z.enum(["correction", "approval", "rejection", "clarification", "instruction"]);
export type FeedbackKind = z.infer<typeof FeedbackKindSchema>;

/** Human feedback on an agent output or run. */
export const AgentFeedbackSchema = z.object({
  feedback_id: UuidSchema,
  tenant_id: UuidSchema,
  run_id: UuidSchema.optional(),
  task_id: UuidSchema.optional(),
  agent_id: z.string().min(1),
  given_by_user_id: z.string().min(1),
  kind: FeedbackKindSchema,
  message: z.string().min(1),
  applies_to_output_ref: OutputRefSchema.optional().describe("The specific output the feedback is about"),
  should_update_skill: z
    .boolean()
    .default(false)
    .describe("True when the feedback should be folded into the agent skill, not just this output"),
  created_at: IsoDateTimeSchema
});
export type AgentFeedback = z.infer<typeof AgentFeedbackSchema>;
