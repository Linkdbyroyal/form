import { z } from "zod";
import { ActorRefSchema, IsoDateTimeSchema, UuidSchema } from "./common";

export const FactVerificationStatusSchema = z.enum(["open", "verified", "rejected", "merged"]);
export type FactVerificationStatus = z.infer<typeof FactVerificationStatusSchema>;

export const FactVerificationOutcomeSchema = z
  .enum(["verified", "rejected", "merged"])
  .describe("verified: fact promoted; rejected: fact deprecated; merged: fact merged into another");
export type FactVerificationOutcome = z.infer<typeof FactVerificationOutcomeSchema>;

export const FactVerificationResolutionSchema = z.object({
  decided_by: z.string().min(1),
  decided_at: IsoDateTimeSchema,
  outcome: FactVerificationOutcomeSchema,
  note: z.string().optional()
});
export type FactVerificationResolution = z.infer<typeof FactVerificationResolutionSchema>;

/** Request to a reviewer to resolve a contested or unverified fact. */
export const FactVerificationRequestSchema = z.object({
  request_id: UuidSchema,
  tenant_id: UuidSchema.nullable().describe("Null for agency-vault facts"),
  fact_id: UuidSchema,
  conflicting_fact_ids: z.array(UuidSchema),
  raised_by: ActorRefSchema,
  reason: z.string().min(1),
  evidence_ids: z.array(UuidSchema),
  requested_reviewer_role: z.string().min(1),
  status: FactVerificationStatusSchema,
  resolution: FactVerificationResolutionSchema.optional()
});
export type FactVerificationRequest = z.infer<typeof FactVerificationRequestSchema>;
