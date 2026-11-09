import { z } from "zod";
import { ClassificationSchema, IsoDateTimeSchema, UuidSchema, VerificationStatusSchema } from "./common";

/** client: a client tenant's vault; agency: the consultancy's own cross-client vault. */
export const VaultScopeSchema = z
  .enum(["client", "agency"])
  .describe("client: tenant-owned vault (tenant_id required); agency: consultancy vault (tenant_id null)");
export type VaultScope = z.infer<typeof VaultScopeSchema>;

/** A markdown document in a knowledge vault. Client-scoped documents must carry a tenant_id. */
export const VaultDocumentSchema = z
  .object({
    document_id: UuidSchema,
    vault_scope: VaultScopeSchema,
    tenant_id: UuidSchema.nullable().describe("Required for client scope; null for agency scope"),
    path: z.string().min(1).describe("Vault-relative path, for example 04_processes_as_is/quote-to-cash.md"),
    title: z.string().min(1),
    frontmatter: z.record(z.string(), z.unknown()).describe("Parsed YAML frontmatter"),
    body_markdown: z.string(),
    tags: z.array(z.string()),
    links_out: z.array(z.string()).describe("Vault-relative paths this document links to"),
    classification: ClassificationSchema,
    verification_status: VerificationStatusSchema,
    version: z.int().min(1),
    created_by: z.string().min(1),
    updated_by: z.string().min(1),
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
    checksum: z.string().min(1).describe("Content hash of body_markdown plus frontmatter")
  })
  .refine((d) => d.vault_scope !== "client" || d.tenant_id !== null, {
    message: "tenant_id is required when vault_scope is client",
    path: ["tenant_id"]
  });
export type VaultDocument = z.infer<typeof VaultDocumentSchema>;
