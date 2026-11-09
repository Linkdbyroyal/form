import { z } from "zod";
import { AgentOutputEnvelopeSchema, MoneyEstimateSchema, UuidSchema } from "./common";

export const FindingSeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingUrgencySchema = z
  .enum(["immediate", "short_term", "medium_term", "long_term"])
  .describe("How soon action is needed: immediate (days), short_term (weeks), medium_term (quarter), long_term (year or more)");
export type FindingUrgency = z.infer<typeof FindingUrgencySchema>;

export const ClaimTypeSchema = z
  .enum(["client_statement", "data_observation", "hypothesis"])
  .describe("Where the claim comes from: the client said it, data shows it, or the agent inferred it");
export type ClaimType = z.infer<typeof ClaimTypeSchema>;

export const FindingStatusSchema = z.enum(["open", "validated", "dismissed", "resolved"]);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

export const FindingImpactSchema = z.object({
  description: z.string().min(1).describe("Business impact in plain language"),
  estimated_annual_cost: MoneyEstimateSchema.optional().describe("Estimated yearly cost of the problem")
});
export type FindingImpact = z.infer<typeof FindingImpactSchema>;

/** An observed problem or notable fact about a process, produced by an agent. */
export const FindingSchema = AgentOutputEnvelopeSchema.extend({
  finding_id: UuidSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  department: z.string().min(1),
  process_id: UuidSchema.optional().describe("Process the finding belongs to, if known"),
  severity: FindingSeveritySchema,
  impact: FindingImpactSchema,
  urgency: FindingUrgencySchema,
  owner_role: z.string().min(1).describe("Role accountable for acting on the finding"),
  evidence_ids: z.array(UuidSchema),
  claim_type: ClaimTypeSchema,
  status: FindingStatusSchema
});
export type Finding = z.infer<typeof FindingSchema>;
