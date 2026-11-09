import { z } from "zod";
import { AgentOutputEnvelopeSchema, MoneyEstimateSchema, UuidSchema } from "./common";

export const InterventionTypeSchema = z
  .enum(["stop", "simplify", "standardize", "integrate", "automate", "keep_human"])
  .describe("Intervention ladder: stop doing it, simplify, standardize, integrate systems, automate, or deliberately keep human");
export type InterventionType = z.infer<typeof InterventionTypeSchema>;

export const EffortSizeSchema = z.enum(["xs", "s", "m", "l", "xl"]).describe("T-shirt size of the implementation effort");
export type EffortSize = z.infer<typeof EffortSizeSchema>;

export const KpiChangeDirectionSchema = z.enum(["up", "down"]);
export type KpiChangeDirection = z.infer<typeof KpiChangeDirectionSchema>;

export const ExpectedKpiChangeSchema = z.object({
  kpi_id: UuidSchema,
  direction: KpiChangeDirectionSchema,
  magnitude: z.string().min(1).describe("Expected size of the change in plain language, for example 10 to 15 percent")
});
export type ExpectedKpiChange = z.infer<typeof ExpectedKpiChangeSchema>;

export const BusinessCaseSchema = z.object({
  effort: EffortSizeSchema,
  dependencies: z.array(z.string()),
  risks: z.array(z.string()),
  estimated_cost: MoneyEstimateSchema.optional(),
  estimated_saving: MoneyEstimateSchema.optional().describe("Estimated yearly saving"),
  expected_kpi_changes: z.array(ExpectedKpiChangeSchema)
});
export type BusinessCase = z.infer<typeof BusinessCaseSchema>;

const ScoreSchema = z.int().min(1).max(5);

export const PriorityScoreSchema = z.object({
  impact: ScoreSchema.describe("1 (negligible) to 5 (transformational)"),
  feasibility: ScoreSchema.describe("1 (very hard) to 5 (trivial)"),
  risk: ScoreSchema.describe("1 (very risky) to 5 (safe)"),
  time_to_value: ScoreSchema.describe("1 (years) to 5 (days)"),
  composite: z.number().describe("Weighted composite of the four scores; weighting is defined by the scoring skill")
});
export type PriorityScore = z.infer<typeof PriorityScoreSchema>;

export const OpportunityStatusSchema = z.enum([
  "proposed",
  "approved",
  "rejected",
  "in_progress",
  "delivered",
  "verified"
]);
export type OpportunityStatus = z.infer<typeof OpportunityStatusSchema>;

/** A proposed intervention built on one or more findings, produced by an agent. */
export const OpportunitySchema = AgentOutputEnvelopeSchema.extend({
  opportunity_id: UuidSchema,
  title: z.string().min(1),
  finding_ids: z.array(UuidSchema),
  intervention_type: InterventionTypeSchema,
  description: z.string().min(1),
  business_case: BusinessCaseSchema,
  priority_score: PriorityScoreSchema,
  status: OpportunityStatusSchema,
  requires_approval: z.boolean().default(true).describe("False only for changes explicitly pre-approved by policy")
});
export type Opportunity = z.infer<typeof OpportunitySchema>;
