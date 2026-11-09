import { z } from "zod";
import { IsoDateTimeSchema, UuidSchema } from "./common";

export const RefreshFrequencySchema = z.enum(["realtime", "hourly", "daily", "weekly", "monthly", "manual"]);
export type RefreshFrequency = z.infer<typeof RefreshFrequencySchema>;

export const KpiDirectionSchema = z
  .enum(["higher_is_better", "lower_is_better"])
  .describe("Which way is good; thresholds are read relative to this direction");
export type KpiDirection = z.infer<typeof KpiDirectionSchema>;

export const KpiThresholdsSchema = z.object({
  warning: z.number().optional().describe("Value at which the KPI turns to warning"),
  critical: z.number().optional().describe("Value at which the KPI turns to critical"),
  direction: KpiDirectionSchema
});
export type KpiThresholds = z.infer<typeof KpiThresholdsSchema>;

export const KpiReliabilitySchema = z
  .enum(["high", "medium", "low", "unknown"])
  .describe("How much the source data can be trusted");
export type KpiReliability = z.infer<typeof KpiReliabilitySchema>;

export const KpiDefinitionStatusSchema = z.enum(["draft", "active", "stale", "missing_source", "retired"]);
export type KpiDefinitionStatus = z.infer<typeof KpiDefinitionStatusSchema>;

/** Definition of a KPI: what business question it answers and how it is computed. */
export const KpiDefinitionSchema = z.object({
  kpi_id: UuidSchema,
  tenant_id: UuidSchema,
  name: z.string().min(1),
  business_question: z.string().min(1).describe("The question a leader asks that this KPI answers"),
  formula: z.string().min(1).describe("Human-readable formula or query description"),
  unit: z.string().min(1).describe("Unit of the value, for example EUR, percent, hours, count"),
  source_system: z.string().min(1).describe("System the raw data comes from, for example rentman"),
  source_field: z.string().min(1).describe("Field, table or endpoint inside the source system"),
  owner_role: z.string().min(1),
  filters: z.record(z.string(), z.string()).optional().describe("Static filters applied to the source data"),
  refresh_frequency: RefreshFrequencySchema,
  thresholds: KpiThresholdsSchema,
  reliability: KpiReliabilitySchema,
  permission_scope: z.array(z.string()).describe("Scopes a viewer needs to see this KPI"),
  history_retention_days: z.int().min(0),
  last_successful_sync_at: IsoDateTimeSchema.optional(),
  status: KpiDefinitionStatusSchema
});
export type KpiDefinition = z.infer<typeof KpiDefinitionSchema>;
