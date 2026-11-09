import { z } from "zod";
import { AgentFeedbackSchema } from "./agent-feedback";
import { AgentRunResultSchema } from "./agent-run-result";
import { AnswerRecordSchema } from "./answer-record";
import { ApprovalRequestSchema } from "./approval-request";
import { DashboardSpecificationSchema } from "./dashboard-specification";
import { EvidenceRecordSchema } from "./evidence-record";
import { ExecutiveBriefingSchema } from "./executive-briefing";
import { FactVerificationRequestSchema } from "./fact-verification-request";
import { FindingSchema } from "./finding";
import { KnowledgeFactSchema } from "./knowledge-fact";
import { KpiDefinitionSchema } from "./kpi-definition";
import { KpiObservationSchema } from "./kpi-observation";
import { MissionControlSummarySchema } from "./mission-control-summary";
import { OpportunitySchema } from "./opportunity";
import { QuestionRequestSchema } from "./question-request";
import { UpgradeProposalSchema } from "./upgrade-proposal";
import { VaultDocumentSchema } from "./vault-document";

export * from "./common";
export * from "./question-request";
export * from "./answer-record";
export * from "./evidence-record";
export * from "./finding";
export * from "./opportunity";
export * from "./approval-request";
export * from "./kpi-definition";
export * from "./kpi-observation";
export * from "./dashboard-specification";
export * from "./executive-briefing";
export * from "./upgrade-proposal";
export * from "./agent-run-result";
export * from "./vault-document";
export * from "./knowledge-fact";
export * from "./fact-verification-request";
export * from "./agent-feedback";
export * from "./mission-control-summary";

/**
 * Semver of this contract set. Additive changes bump minor, breaking changes bump major
 * (and keep the previous schemas under src/v1/ and so on). See README.md.
 */
export const CONTRACTS_VERSION = "0.1.0" as const;

/** Every top-level contract, keyed by contract name. */
export const contractSchemas = {
  QuestionRequest: QuestionRequestSchema,
  AnswerRecord: AnswerRecordSchema,
  EvidenceRecord: EvidenceRecordSchema,
  Finding: FindingSchema,
  Opportunity: OpportunitySchema,
  ApprovalRequest: ApprovalRequestSchema,
  KpiDefinition: KpiDefinitionSchema,
  KpiObservation: KpiObservationSchema,
  DashboardSpecification: DashboardSpecificationSchema,
  ExecutiveBriefing: ExecutiveBriefingSchema,
  UpgradeProposal: UpgradeProposalSchema,
  AgentRunResult: AgentRunResultSchema,
  VaultDocument: VaultDocumentSchema,
  KnowledgeFact: KnowledgeFactSchema,
  FactVerificationRequest: FactVerificationRequestSchema,
  AgentFeedback: AgentFeedbackSchema,
  MissionControlSummary: MissionControlSummarySchema
} as const;

export type ContractName = keyof typeof contractSchemas;

export const contractNames = Object.keys(contractSchemas) as ContractName[];

/** JSON Schema document as produced by Zod 4's z.toJSONSchema(). */
export type JsonSchema = z.core.JSONSchema.BaseSchema;

/**
 * Convert every contract to JSON Schema (draft 2020-12) with Zod 4's built-in converter.
 * Cross-field .refine() rules are not representable in JSON Schema and are documented in
 * the field descriptions instead.
 */
export function toJsonSchemas(): Record<ContractName, JsonSchema> {
  const result = {} as Record<ContractName, JsonSchema>;
  for (const name of contractNames) {
    result[name] = z.toJSONSchema(contractSchemas[name], {
      target: "draft-2020-12",
      unrepresentable: "any"
    });
  }
  return result;
}
