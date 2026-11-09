import { z } from "zod";
import { IsoDateTimeSchema, PriorityLevelSchema, UuidSchema } from "./common";

export const MissionControlScopeSchema = z.enum(["all_clients", "single_client"]);
export type MissionControlScope = z.infer<typeof MissionControlScopeSchema>;

export const AgentStateSchema = z.enum(["active", "idle", "running", "paused", "blocked", "error"]);
export type AgentState = z.infer<typeof AgentStateSchema>;

export const AgentStatusSchema = z.object({
  agent_id: z.string().min(1),
  tenant_id: UuidSchema,
  name: z.string().min(1),
  state: AgentStateSchema,
  current_task_id: UuidSchema.optional(),
  department: z.string().optional(),
  priority: PriorityLevelSchema.optional(),
  last_run_at: IsoDateTimeSchema.optional(),
  next_scheduled_run_at: IsoDateTimeSchema.optional()
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

const Count = z.int().min(0);

export const MissionControlCountersSchema = z.object({
  runs_succeeded_24h: Count,
  runs_failed_24h: Count,
  retries_24h: Count,
  approvals_pending: Count,
  tasks_without_owner: Count,
  schedules_missed: Count,
  incidents_open: Count
});
export type MissionControlCounters = z.infer<typeof MissionControlCountersSchema>;

export const BudgetSummarySchema = z.object({
  spent_usd_mtd: z.number().min(0).describe("Spend month to date in USD"),
  cap_usd: z.number().min(0).optional().describe("Monthly cap in USD, if one is set")
});
export type BudgetSummary = z.infer<typeof BudgetSummarySchema>;

/**
 * Operational overview for Mission Control.
 * This summary carries metadata only and must never include document content, fact
 * statements or any other client knowledge; it is safe to show across tenants.
 */
export const MissionControlSummarySchema = z
  .object({
    generated_at: IsoDateTimeSchema,
    scope: MissionControlScopeSchema,
    tenant_id: UuidSchema.optional().describe("Set when scope is single_client"),
    agents: z.array(AgentStatusSchema),
    counters: MissionControlCountersSchema,
    budget: BudgetSummarySchema,
    content_masked: z
      .boolean()
      .describe(
        "True when the viewer lacks cross-client content authorization. Regardless of this flag the summary must never include document content."
      )
  })
  .describe("Metadata-only operational summary; must never include document content");
export type MissionControlSummary = z.infer<typeof MissionControlSummarySchema>;
