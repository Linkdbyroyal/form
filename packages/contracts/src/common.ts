import { z } from "zod";

/** RFC 4122 UUID string. All record identifiers in the platform are UUIDs. */
export const UuidSchema = z.uuid().describe("RFC 4122 UUID");
export type Uuid = z.infer<typeof UuidSchema>;

/** ISO 8601 date-time string in UTC, for example 2026-11-09T08:00:00Z. */
export const IsoDateTimeSchema = z.iso.datetime().describe("ISO 8601 date-time in UTC");
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/** ISO 8601 calendar date (YYYY-MM-DD) without a time component. */
export const IsoDateSchema = z.iso.date().describe("ISO 8601 calendar date (YYYY-MM-DD)");
export type IsoDate = z.infer<typeof IsoDateSchema>;

/** Self-assessed confidence of the producer, 0 (no confidence) to 1 (certain). */
export const ConfidenceSchema = z
  .number()
  .min(0)
  .max(1)
  .describe("Confidence between 0 (none) and 1 (certain)");
export type Confidence = z.infer<typeof ConfidenceSchema>;

/** Human review state of an agent-produced record. */
export const ReviewStatusSchema = z
  .enum(["unreviewed", "in_review", "approved", "rejected", "superseded"])
  .describe("Human review state of the record");
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

/**
 * Epistemic status of a fact or answer.
 * unconfirmed: what the client said; hypothesis: what an agent inferred;
 * evidence_backed: what data shows; verified: a reviewer promoted it;
 * approved_policy: formal company policy; deprecated: no longer valid.
 */
export const VerificationStatusSchema = z
  .enum(["unconfirmed", "hypothesis", "evidence_backed", "verified", "approved_policy", "deprecated"])
  .describe(
    "Epistemic status: unconfirmed (client statement), hypothesis (agent inference), evidence_backed (data shows it), verified (reviewer promoted), approved_policy (formal policy), deprecated"
  );
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

/** Information classification level used for access control and masking. */
export const ClassificationSchema = z
  .enum(["public", "internal", "confidential", "restricted"])
  .describe("Information classification level");
export type Classification = z.infer<typeof ClassificationSchema>;

/** Generic priority ladder reused by questions, help requests and similar records. */
export const PriorityLevelSchema = z
  .enum(["critical", "high", "medium", "low"])
  .describe("Priority level");
export type PriorityLevel = z.infer<typeof PriorityLevelSchema>;

/** Kind of principal acting in the system. */
export const ActorTypeSchema = z.enum(["user", "agent", "system"]).describe("Kind of acting principal");
export type ActorType = z.infer<typeof ActorTypeSchema>;

/** Reference to the principal that performed an action. */
export const ActorRefSchema = z.object({
  actor_type: ActorTypeSchema,
  actor_id: z.string().min(1).describe("User id, agent id or system component name")
});
export type ActorRef = z.infer<typeof ActorRefSchema>;

/** Loose reference to any platform entity by type and id. */
export const EntityRefSchema = z.object({
  type: z.string().min(1).describe("Entity type, for example process, department, system, person"),
  id: UuidSchema
});
export type EntityRef = z.infer<typeof EntityRefSchema>;

/** Monetary amount that is always an estimate; is_estimate is fixed to true on purpose. */
export const MoneyEstimateSchema = z.object({
  amount: z.number().describe("Amount in the given currency"),
  currency: z.string().length(3).describe("ISO 4217 currency code, for example EUR, USD, ANG"),
  is_estimate: z.literal(true).describe("Always true: estimates must never be presented as actuals")
});
export type MoneyEstimate = z.infer<typeof MoneyEstimateSchema>;

/** Reference to a record produced under one of the contracts in this package. */
export const OutputRefSchema = z.object({
  contract: z.string().min(1).describe("Contract name, for example Finding or Opportunity"),
  ref_id: UuidSchema.describe("Primary id of the referenced record")
});
export type OutputRef = z.infer<typeof OutputRefSchema>;

/** Who is acting, for which tenant, with which roles and scopes. */
export const PermissionsContextSchema = z.object({
  tenant_id: UuidSchema,
  actor_type: ActorTypeSchema,
  actor_id: z.string().min(1),
  roles: z.array(z.string()).describe("Role names granted to the actor"),
  scopes: z.array(z.string()).describe("Permission scopes granted to the actor"),
  cross_tenant_content_authorized: z
    .boolean()
    .default(false)
    .describe("True only when the actor may see content from more than one client tenant")
});
export type PermissionsContext = z.infer<typeof PermissionsContextSchema>;

/** Where a piece of information came from. */
export const SourceRefSchema = z.object({
  source_id: UuidSchema,
  system: z.string().min(1).describe("Originating system, for example rentman, interview, document"),
  locator: z.string().optional().describe("URL, file path or record id inside the source system"),
  retrieved_at: IsoDateTimeSchema.optional(),
  checksum: z.string().optional().describe("Content hash of the retrieved source, for change detection")
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

/**
 * Envelope that every agent-produced contract extends.
 * Provenance, confidence and review state are mandatory so that nothing an agent
 * produced is shown or stored without knowing where it came from.
 */
export const AgentOutputEnvelopeSchema = z.object({
  tenant_id: UuidSchema,
  source_ids: z.array(UuidSchema).describe("Evidence or source records backing this output"),
  confidence: ConfidenceSchema,
  generated_at: IsoDateTimeSchema,
  review_status: ReviewStatusSchema,
  permissions_context: PermissionsContextSchema,
  agent_id: z.string().optional().describe("Agent that produced the output"),
  run_id: UuidSchema.optional().describe("Agent run that produced the output"),
  skill_version: z.string().optional().describe("Version of the skill used by the agent"),
  uncertainties: z.array(z.string()).optional().describe("Plain-language list of what the agent is unsure about")
});
export type AgentOutputEnvelope = z.infer<typeof AgentOutputEnvelopeSchema>;
