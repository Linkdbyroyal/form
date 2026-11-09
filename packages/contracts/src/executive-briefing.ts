import { z } from "zod";
import { AgentOutputEnvelopeSchema, ConfidenceSchema, IsoDateSchema, UuidSchema } from "./common";

export const BriefingItemSchema = z.object({
  text: z.string().min(1),
  source_ids: z.array(UuidSchema).describe("Evidence backing this item"),
  confidence: ConfidenceSchema
});
export type BriefingItem = z.infer<typeof BriefingItemSchema>;

const BriefingItemsSchema = z.array(BriefingItemSchema);

/** Fixed section set of a briefing; every key is required so the UI can render a stable layout. */
export const BriefingSectionsSchema = z.object({
  what_changed: BriefingItemsSchema,
  what_matters_today: BriefingItemsSchema,
  decisions_needed: BriefingItemsSchema,
  tasks_delegated: BriefingItemsSchema,
  risks: BriefingItemsSchema,
  opportunities: BriefingItemsSchema,
  data_gaps: BriefingItemsSchema,
  impact_of_prior_improvements: BriefingItemsSchema
});
export type BriefingSections = z.infer<typeof BriefingSectionsSchema>;

/** Daily executive briefing produced by an agent. */
export const ExecutiveBriefingSchema = AgentOutputEnvelopeSchema.extend({
  briefing_id: UuidSchema,
  briefing_date: IsoDateSchema.describe("Calendar date the briefing is for"),
  sections: BriefingSectionsSchema,
  top_priorities: z.array(z.string().min(1)).min(1).max(7).describe("Between 1 and 7 priorities, most important first")
});
export type ExecutiveBriefing = z.infer<typeof ExecutiveBriefingSchema>;
