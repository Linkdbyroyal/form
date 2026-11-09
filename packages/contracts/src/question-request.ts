import { z } from "zod";
import { ConfidenceSchema, IsoDateTimeSchema, PriorityLevelSchema, SourceRefSchema, UuidSchema } from "./common";

export const QuestionAnswerTypeSchema = z
  .enum(["text", "number", "boolean", "single_choice", "multi_choice", "date", "file", "system_reference"])
  .describe("Expected answer shape; choice types require options");
export type QuestionAnswerType = z.infer<typeof QuestionAnswerTypeSchema>;

export const QuestionStatusSchema = z.enum(["draft", "open", "answered", "skipped", "superseded"]);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

/** Discovery Engine question record: one question asked of a role to close an evidence gap. */
export const QuestionRequestSchema = z.object({
  question_id: UuidSchema,
  tenant_id: UuidSchema,
  department: z.string().min(1).describe("Department the question is about, for example finance, operations"),
  recipient_role: z.string().min(1).describe("Role that should answer, for example cfo, warehouse_lead"),
  question_text: z.string().min(1),
  reason: z.string().min(1).describe("Why the answer is needed"),
  evidence_gap: z.string().min(1).describe("What evidence is missing that this question would provide"),
  priority: PriorityLevelSchema,
  answer_type: QuestionAnswerTypeSchema,
  options: z.array(z.string()).optional().describe("Allowed answers for single_choice and multi_choice"),
  source: SourceRefSchema.optional().describe("What triggered the question"),
  status: QuestionStatusSchema,
  next_action: z.string().optional().describe("What happens once the question is answered"),
  confidence: ConfidenceSchema.describe("Confidence that this question is relevant and well-targeted"),
  round_id: UuidSchema.optional().describe("Discovery round the question belongs to"),
  depends_on: z.array(UuidSchema).describe("Question ids that must be answered first"),
  asked_by_agent_id: z.string().optional(),
  created_at: IsoDateTimeSchema
});
export type QuestionRequest = z.infer<typeof QuestionRequestSchema>;
