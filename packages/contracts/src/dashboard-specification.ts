import { z } from "zod";
import { ReviewStatusSchema, UuidSchema } from "./common";

export const DashboardAudienceRoleSchema = z.enum([
  "ceo",
  "cfo",
  "coo",
  "team_lead",
  "consultant",
  "auditor",
  "custom"
]);
export type DashboardAudienceRole = z.infer<typeof DashboardAudienceRoleSchema>;

export const LocaleSchema = z.enum(["en", "nl", "pap"]).describe("UI language: English, Dutch, Papiamentu");
export type Locale = z.infer<typeof LocaleSchema>;

/** Render-safe whitelist of widget types. The UI refuses anything outside this list. */
export const WidgetTypeSchema = z
  .enum([
    "kpi_tile",
    "trend_line",
    "bar",
    "table",
    "action_list",
    "briefing",
    "risk_list",
    "data_gap_list",
    "text_note"
  ])
  .describe("Render-safe widget type whitelist");
export type WidgetType = z.infer<typeof WidgetTypeSchema>;

export const WidgetSizeSchema = z.enum(["s", "m", "l"]);
export type WidgetSize = z.infer<typeof WidgetSizeSchema>;

export const DashboardWidgetSchema = z.object({
  widget_id: UuidSchema,
  type: WidgetTypeSchema,
  kpi_ids: z.array(UuidSchema),
  priority: z.int().describe("Lower renders first"),
  reason: z.string().min(1).describe("Why this widget is on the dashboard for this audience"),
  size: WidgetSizeSchema,
  config: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Widget-specific primitive options; never markup or code")
});
export type DashboardWidget = z.infer<typeof DashboardWidgetSchema>;

/** Dashboard layout for one audience role. Widget ids must be unique within a dashboard. */
export const DashboardSpecificationSchema = z
  .object({
    dashboard_id: UuidSchema,
    tenant_id: UuidSchema,
    audience_role: DashboardAudienceRoleSchema,
    title: z.string().min(1),
    locale: LocaleSchema.default("en"),
    widgets: z.array(DashboardWidgetSchema),
    generated_by: z.string().optional().describe("Agent id that generated the specification"),
    version: z.int().min(1),
    review_status: ReviewStatusSchema
  })
  .refine((d) => new Set(d.widgets.map((w) => w.widget_id)).size === d.widgets.length, {
    message: "widget_id values must be unique within a dashboard",
    path: ["widgets"]
  });
export type DashboardSpecification = z.infer<typeof DashboardSpecificationSchema>;
