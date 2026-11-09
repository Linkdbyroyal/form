import { z } from "zod";
import { AgentOutputEnvelopeSchema, IsoDateTimeSchema, UuidSchema } from "./common";

export const UpgradeKindSchema = z
  .enum(["knowledge_update", "skill_update", "code_update"])
  .describe("What is being upgraded: vault knowledge, an agent skill, or a code dependency");
export type UpgradeKind = z.infer<typeof UpgradeKindSchema>;

export const SecurityRiskSchema = z
  .enum(["none", "low", "medium", "high", "critical"])
  .describe("Security impact of applying or not applying the upgrade");
export type SecurityRisk = z.infer<typeof SecurityRiskSchema>;

export const UpgradeStatusSchema = z.enum(["detected", "assessed", "approved", "applied", "rolled_back", "rejected"]);
export type UpgradeStatus = z.infer<typeof UpgradeStatusSchema>;

/** A detected upgrade to knowledge, a skill or code, with its assessment and plans. */
export const UpgradeProposalSchema = AgentOutputEnvelopeSchema.extend({
  upgrade_id: UuidSchema,
  kind: UpgradeKindSchema,
  subject: z.string().min(1).describe("Package, skill or agent name being upgraded"),
  current_version: z.string().min(1),
  proposed_version: z.string().min(1),
  source_url: z.url().describe("Where the upgrade was announced or published"),
  published_at: IsoDateTimeSchema,
  detected_at: IsoDateTimeSchema,
  relevant_agent_ids: z.array(z.string()).describe("Agents affected by the upgrade"),
  potential_benefit: z.string().min(1),
  compatibility_notes: z.string().min(1),
  security_risk: SecurityRiskSchema,
  migration_plan: z.string().min(1),
  test_result: z.string().optional().describe("Outcome of the trial run, if performed"),
  rollback_plan: z.string().min(1),
  reviewer: z.string().optional(),
  status: UpgradeStatusSchema
});
export type UpgradeProposal = z.infer<typeof UpgradeProposalSchema>;
