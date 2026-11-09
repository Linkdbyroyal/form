import { z } from "zod";
import {
  ClassificationSchema,
  EntityRefSchema,
  IsoDateTimeSchema,
  SourceRefSchema,
  UuidSchema,
  VerificationStatusSchema
} from "./common";

export const EvidenceKindSchema = z.enum([
  "document",
  "system_record",
  "interview_answer",
  "screenshot",
  "metric",
  "observation"
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

/** A captured piece of evidence that findings, facts and approvals can point to. */
export const EvidenceRecordSchema = z.object({
  evidence_id: UuidSchema,
  tenant_id: UuidSchema,
  kind: EvidenceKindSchema,
  summary: z.string().min(1).describe("Short human-readable summary of what the evidence shows"),
  source: SourceRefSchema,
  captured_at: IsoDateTimeSchema,
  classification: ClassificationSchema,
  verification_status: VerificationStatusSchema,
  checksum: z.string().optional().describe("Content hash of the captured artifact"),
  related_entity: z.array(EntityRefSchema).describe("Entities this evidence is about")
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
