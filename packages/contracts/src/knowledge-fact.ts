import { z } from "zod";
import {
  ClassificationSchema,
  ConfidenceSchema,
  EntityRefSchema,
  IsoDateTimeSchema,
  UuidSchema,
  VerificationStatusSchema
} from "./common";
import { VaultScopeSchema } from "./vault-document";

/** An atomic, sourced statement of knowledge. Client-scoped facts must carry a tenant_id. */
export const KnowledgeFactSchema = z
  .object({
    fact_id: UuidSchema,
    vault_scope: VaultScopeSchema,
    tenant_id: UuidSchema.nullable().describe("Required for client scope; null for agency scope"),
    statement: z.string().min(1).describe("One self-contained sentence"),
    subject_entity: EntityRefSchema.optional().describe("Entity the statement is about"),
    source_ids: z.array(UuidSchema).min(1).describe("At least one source or evidence id"),
    origin_system: z.string().min(1).describe("System or channel the fact was learned from"),
    observed_at: IsoDateTimeSchema,
    responsible_role: z.string().min(1).describe("Role accountable for keeping the fact current"),
    verification_status: VerificationStatusSchema,
    confidence: ConfidenceSchema,
    classification: ClassificationSchema,
    version: z.int().min(1),
    access_policy: z.array(z.string()).describe("Roles or scopes allowed to read the fact"),
    superseded_by: UuidSchema.optional().describe("Newer fact that replaces this one"),
    contradicts: z.array(UuidSchema).optional().describe("Fact ids this fact is in conflict with")
  })
  .refine((f) => f.vault_scope !== "client" || f.tenant_id !== null, {
    message: "tenant_id is required when vault_scope is client",
    path: ["tenant_id"]
  });
export type KnowledgeFact = z.infer<typeof KnowledgeFactSchema>;
