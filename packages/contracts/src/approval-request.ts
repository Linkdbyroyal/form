import { z } from "zod";
import { ActorRefSchema, IsoDateTimeSchema, UuidSchema } from "./common";

export const ApprovalSubjectTypeSchema = z.enum([
  "opportunity",
  "action",
  "vault_change",
  "knowledge_promotion",
  "integration_write",
  "agent_instruction_change",
  "other"
]);
export type ApprovalSubjectType = z.infer<typeof ApprovalSubjectTypeSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "expired", "withdrawn"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/** Human-in-the-loop gate for an action, change or promotion that needs sign-off. */
export const ApprovalRequestSchema = z.object({
  approval_id: UuidSchema,
  tenant_id: UuidSchema,
  subject: z.object({
    type: ApprovalSubjectTypeSchema,
    id: UuidSchema
  }),
  requested_by: ActorRefSchema,
  approver_role: z.string().min(1).describe("Role that must decide"),
  risk_level: RiskLevelSchema,
  summary: z.string().min(1),
  rationale: z.string().min(1).describe("Why the requester believes this should be approved"),
  evidence_ids: z.array(UuidSchema),
  blocking: z.boolean().describe("True when the action is technically blocked until approved"),
  status: ApprovalStatusSchema,
  decided_by: z.string().optional(),
  decided_at: IsoDateTimeSchema.optional(),
  decision_note: z.string().optional(),
  expires_at: IsoDateTimeSchema.optional().describe("After this moment the request becomes expired"),
  created_at: IsoDateTimeSchema
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
