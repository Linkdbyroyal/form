import type { BaseCheckpoint, Flow } from "./types";
import { discoveryFlow } from "./discovery";
import { departmentReviewFlow } from "./department-review";
import { processRedesignFlow } from "./process-redesign";
import { ceoIntelligenceFlow } from "./ceo-intelligence";
import { executiveBriefingFlow } from "./executive-briefing";
import { actionVerificationFlow } from "./action-verification";

/** Agent definition key -> flow. Definitions for Finance and Operations map to the shared department review flow. */
const FLOWS: Record<string, Flow<BaseCheckpoint>> = {
  "discovery-interview": discoveryFlow as unknown as Flow<BaseCheckpoint>,
  "finance-agent": departmentReviewFlow as unknown as Flow<BaseCheckpoint>,
  "operations-agent": departmentReviewFlow as unknown as Flow<BaseCheckpoint>,
  "process-redesign": processRedesignFlow as unknown as Flow<BaseCheckpoint>,
  "ceo-intelligence": ceoIntelligenceFlow as unknown as Flow<BaseCheckpoint>,
  "executive-briefing": executiveBriefingFlow as unknown as Flow<BaseCheckpoint>,
  "performance-agent": actionVerificationFlow as unknown as Flow<BaseCheckpoint>
};

export function flowFor(definitionKey: string): Flow<BaseCheckpoint> | null {
  return FLOWS[definitionKey] ?? null;
}

export const FLOW_KEYS = Object.keys(FLOWS);
export type { Flow, FlowRuntime, BaseCheckpoint } from "./types";
