import { z } from "zod";
import { ActorRefSchema, IsoDateTimeSchema, SourceRefSchema, UuidSchema } from "./common";

export const KpiObservationStatusSchema = z.enum(["ok", "missing_data", "stale_data", "error"]);
export type KpiObservationStatus = z.infer<typeof KpiObservationStatusSchema>;

export const KpiLineageSchema = z.object({
  query_or_formula: z.string().min(1).describe("Exact query or formula that produced the value"),
  source_record_ids: z.array(z.string()).describe("Ids of the source records that went into the value")
});
export type KpiLineage = z.infer<typeof KpiLineageSchema>;

/**
 * One measured value of a KPI for a period.
 * Rule: value MUST be null when status is not "ok", and MUST be a number when status is "ok".
 */
export const KpiObservationSchema = z
  .object({
    kpi_id: UuidSchema,
    tenant_id: UuidSchema,
    observed_at: IsoDateTimeSchema,
    period_start: IsoDateTimeSchema,
    period_end: IsoDateTimeSchema,
    value: z
      .number()
      .nullable()
      .describe("Measured value; MUST be null when status is not ok and a number when status is ok"),
    status: KpiObservationStatusSchema,
    source: SourceRefSchema,
    computed_by: ActorRefSchema,
    lineage: KpiLineageSchema
  })
  .refine((o) => (o.status === "ok" ? o.value !== null : o.value === null), {
    message: 'value must be null when status is not "ok" and a number when status is "ok"',
    path: ["value"]
  });
export type KpiObservation = z.infer<typeof KpiObservationSchema>;
