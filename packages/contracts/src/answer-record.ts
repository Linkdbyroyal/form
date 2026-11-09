import { z } from "zod";
import { IsoDateTimeSchema, SourceRefSchema, UuidSchema, VerificationStatusSchema } from "./common";

export const AnswerValueSchema = z
  .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
  .describe("Answer value; shape follows the question answer_type");
export type AnswerValue = z.infer<typeof AnswerValueSchema>;

/** A human answer to a QuestionRequest. Answers start as unconfirmed client statements. */
export const AnswerRecordSchema = z.object({
  question_id: UuidSchema,
  tenant_id: UuidSchema,
  answer: AnswerValueSchema,
  answered_by_user_id: z.string().min(1),
  answered_by_role: z.string().min(1),
  answered_at: IsoDateTimeSchema,
  source: SourceRefSchema.optional().describe("Attachment or system record supporting the answer"),
  verification_status: VerificationStatusSchema.default("unconfirmed"),
  notes: z.string().optional(),
  supersedes_answer_id: UuidSchema.optional().describe("Earlier answer this one replaces")
});
export type AnswerRecord = z.infer<typeof AnswerRecordSchema>;
