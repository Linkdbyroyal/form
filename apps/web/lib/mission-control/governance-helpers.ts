import type { Tone } from "@/components/ui";
import { DATA_CLASSES, RETENTION_MINIMUM_DAYS, type DataClass } from "@sbos/core";

/**
 * Pure helpers for the Technology Intelligence Center (spec 4D) and the data retention pages (Milestone 6).
 * No I/O, no database; everything here is unit-tested in `test/governance.test.ts`. Reads live in
 * `governance-queries.ts` and `../client/retention-queries.ts`, writes in `governance-actions.ts` and
 * `../client/retention-actions.ts`. The database triggers (`enforce_upgrade_transition`, `enforce_deletion_request`,
 * the retention CHECK constraints) stay the real gate; these helpers only decide what the pages offer.
 */

export const UPGRADE_STATUSES = ["detected", "assessed", "approved", "applied", "rolled_back", "rejected"] as const;
export type UpgradeStatus = (typeof UPGRADE_STATUSES)[number];
export const UPGRADE_KINDS = ["knowledge_update", "skill_update", "code_update"] as const;
export type UpgradeKind = (typeof UPGRADE_KINDS)[number];
export const SECURITY_RISKS = ["none", "low", "medium", "high", "critical"] as const;
export type SecurityRisk = (typeof SECURITY_RISKS)[number];
export const TECH_SOURCE_KINDS = ["official_docs", "changelog", "github_releases", "security_advisory", "standard", "regulation", "test_results"] as const;
export type TechSourceKind = (typeof TECH_SOURCE_KINDS)[number];
export const TECH_FETCH_KINDS = ["github_releases", "rss", "json", "manual"] as const;
export type TechFetchKind = (typeof TECH_FETCH_KINDS)[number];
export const DELETION_KINDS = ["document", "connection_data", "subject_data", "tenant_offboarding"] as const;
export type DeletionKind = (typeof DELETION_KINDS)[number];
export const DELETION_STATES = ["requested", "approved", "rejected", "executing", "completed"] as const;
export type DeletionState = (typeof DELETION_STATES)[number];
export const REVIEWER_ROLES = ["agency_reviewer", "superadmin"] as const;

export const TECH_WATCH_BASE = "/mission-control/tech-watch";
export const GOVERNANCE_BASE = "/mission-control/governance";
export const WORKER_SWEEP_SCHEDULE = "executed by the worker on its weekly schedule (Sundays 03:00 UTC)";
export const WORKER_WATCH_SCHEDULE = "daily at 06:00 UTC";

export function updateHref(id: string): string {
  return `${TECH_WATCH_BASE}/updates/${id}`;
}
export function deletionRequestHref(id: string): string {
  return `${GOVERNANCE_BASE}/requests/${id}`;
}

// Tones ---------------------------------------------------------------------------------------------

const UPGRADE_TONES: Record<UpgradeStatus, Tone> = { detected: "neutral", assessed: "cyan", approved: "indigo", applied: "success", rolled_back: "warning", rejected: "danger" };
const RISK_TONES: Record<SecurityRisk, Tone> = { none: "neutral", low: "neutral", medium: "cyan", high: "warning", critical: "danger" };
const DELETION_TONES: Record<DeletionState, Tone> = { requested: "warning", approved: "indigo", rejected: "danger", executing: "cyan", completed: "success" };
const WATCH_RUN_TONES: Record<string, Tone> = { succeeded: "success", failed: "danger", skipped: "neutral" };
const KIND_TONES: Record<UpgradeKind, Tone> = { knowledge_update: "cyan", skill_update: "indigo", code_update: "warning" };

export function upgradeStatusTone(status: string): Tone {
  return UPGRADE_TONES[status as UpgradeStatus] ?? "neutral";
}
export function securityRiskTone(risk: string | null | undefined): Tone {
  return risk ? (RISK_TONES[risk as SecurityRisk] ?? "neutral") : "neutral";
}
export function deletionStateTone(state: string): Tone {
  return DELETION_TONES[state as DeletionState] ?? "neutral";
}
export function watchRunTone(status: string): Tone {
  return WATCH_RUN_TONES[status] ?? "neutral";
}
export function upgradeKindTone(kind: string | null | undefined): Tone {
  return kind ? (KIND_TONES[kind as UpgradeKind] ?? "neutral") : "neutral";
}
export function watchModeTone(mode: string): Tone {
  return mode === "live" ? "success" : "warning";
}

// Roles ---------------------------------------------------------------------------------------------

/** Approve, reject, apply, roll back and source approval: the trigger and the services allow agency_reviewer and superadmin. */
export function isReviewer(roles: readonly string[]): boolean {
  return roles.some((r) => (REVIEWER_ROLES as readonly string[]).includes(r));
}
export function isSuperadmin(roles: readonly string[]): boolean {
  return roles.includes("superadmin");
}

// Upgrade lifecycle ---------------------------------------------------------------------------------

/** The exact transition table of `enforce_upgrade_transition`. */
const ALLOWED: ReadonlyArray<readonly [UpgradeStatus, UpgradeStatus]> = [
  ["detected", "assessed"],
  ["detected", "rejected"],
  ["assessed", "approved"],
  ["assessed", "rejected"],
  ["assessed", "detected"],
  ["approved", "applied"],
  ["approved", "rejected"],
  ["applied", "rolled_back"]
];

export function allowedUpgradeTransitions(from: string): UpgradeStatus[] {
  return ALLOWED.filter(([f]) => f === from).map(([, to]) => to);
}

export function isAllowedUpgradeTransition(from: string, to: string): boolean {
  return ALLOWED.some(([f, t]) => f === from && t === to);
}

export type UpgradeAction = "assess" | "approve" | "reject" | "apply" | "rollback";

export interface UpgradeActionOffer {
  action: UpgradeAction;
  label: string;
  /** True when the trigger or the service requires agency_reviewer or superadmin. */
  reviewerOnly: boolean;
  destructive: boolean;
}

/**
 * Which forms the Upgrade Center offers for an update in `status`, mirroring the trigger: assessing is open to every
 * agency role (and to the Technology Intelligence agent, later), deciding, applying and rolling back are reviewer
 * decisions. `assessed -> detected` is allowed by the trigger but has no service; re-assessing overwrites the fields.
 */
export function upgradeActionsFor(status: string): UpgradeActionOffer[] {
  switch (status) {
    case "detected":
      return [
        { action: "assess", label: "Record assessment", reviewerOnly: false, destructive: false },
        { action: "reject", label: "Reject", reviewerOnly: true, destructive: true }
      ];
    case "assessed":
      return [
        { action: "approve", label: "Approve", reviewerOnly: true, destructive: false },
        { action: "reject", label: "Reject", reviewerOnly: true, destructive: true },
        { action: "assess", label: "Re-assess", reviewerOnly: false, destructive: false }
      ];
    case "approved":
      return [
        { action: "apply", label: "Apply with test result", reviewerOnly: true, destructive: false },
        { action: "reject", label: "Reject", reviewerOnly: true, destructive: true }
      ];
    case "applied":
      return [{ action: "rollback", label: "Roll back", reviewerOnly: true, destructive: true }];
    default:
      return [];
  }
}

/** Buttons a user with `roles` may actually use (the trigger still decides; this hides what would be refused). */
export function upgradeActionsForRoles(status: string, roles: readonly string[]): UpgradeActionOffer[] {
  const reviewer = isReviewer(roles);
  return upgradeActionsFor(status).filter((a) => reviewer || !a.reviewerOnly);
}

export interface ArtefactRequirement {
  field: "pullRequestUrl" | "skillVersionId" | "knowledgeRecordId";
  label: string;
  /** What the approval trigger demands, in the words of the trigger. */
  rule: string;
  /** What applying does, so nobody expects the platform to execute anything. */
  applyEffect: string;
}

/** Per-kind artefact the approval trigger demands. */
export function artefactRequirement(kind: string): ArtefactRequirement | null {
  switch (kind) {
    case "code_update":
      return { field: "pullRequestUrl", label: "Pull request", rule: "a code update is approved only with a pull request (tests run there, a human merges)", applyEffect: "Applying records the merged pull request. The platform never deploys code; a human merges the pull request and CI runs the tests." };
    case "skill_update":
      return { field: "skillVersionId", label: "New skill version", rule: "a skill update is approved only with a new immutable skill version", applyEffect: "Applying moves the stable release channel of the skill to this version and keeps the previous version for rollback. Running agent instances stay pinned to their version and are never re-pinned." };
    case "knowledge_update":
      return { field: "knowledgeRecordId", label: "Agency knowledge record", rule: "a knowledge update is approved only with an agency knowledge record", applyEffect: "Applying records the published agency record; the record must be published at that moment." };
    default:
      return null;
  }
}

/** Fields the assessment trigger requires to be filled; returns the missing labels. */
export function missingAssessmentFields(input: { kind?: string | null; securityRisk?: string | null; potentialBenefit?: string | null; compatibilityNotes?: string | null; migrationPlan?: string | null; rollbackPlan?: string | null }): string[] {
  const missing: string[] = [];
  if (!input.kind) missing.push("kind");
  if (!input.securityRisk) missing.push("security risk");
  if (!input.potentialBenefit?.trim()) missing.push("potential benefit");
  if (!input.compatibilityNotes?.trim()) missing.push("compatibility notes");
  if (!input.migrationPlan?.trim()) missing.push("migration plan");
  if (!input.rollbackPlan?.trim()) missing.push("rollback plan");
  return missing;
}

// Validation ----------------------------------------------------------------------------------------

const AGENT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SOURCE_KEY_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const GITHUB_PR_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+(\/[^\s]*)?$/;

/** Comma, space or newline separated agent keys, lowercase, de-duplicated. Throws on a key the registry could never hold. */
export function parseAgentKeys(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,\s]+/)) {
    const v = part.trim().toLowerCase();
    if (!v) continue;
    if (!AGENT_KEY_RE.test(v)) throw new Error(`agent key "${part.trim()}" must be lowercase letters, digits, dashes or underscores`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

export function isSourceKey(value: string): boolean {
  return SOURCE_KEY_RE.test(value);
}

export function isHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/** The pull_request_url CHECK only demands a github.com https url; the form asks for a real pull request path. */
export function isGithubPullRequestUrl(value: string): boolean {
  return GITHUB_PR_RE.test(value);
}

export const CHECK_INTERVAL_MIN = 1;
export const CHECK_INTERVAL_MAX = 720;

export function isValidCheckInterval(hours: number): boolean {
  return Number.isInteger(hours) && hours >= CHECK_INTERVAL_MIN && hours <= CHECK_INTERVAL_MAX;
}

// Retention -----------------------------------------------------------------------------------------

export const RETENTION_MAX_DAYS = 3650;

export const DATA_CLASS_LABELS: Record<DataClass, { label: string; description: string }> = {
  run_events: { label: "Run events", description: "Agent run traces: steps, tool calls, notes. Needed for incident analysis." },
  retrieval_audit: { label: "Retrieval audit", description: "Which documents and facts an agent read for an answer (lineage)." },
  notifications: { label: "Notifications", description: "Delivered or failed notification rows (subject and recipient reference)." },
  sync_runs: { label: "Sync runs", description: "Connector sync runs with masked error text and object counts." },
  knowledge_access_logs: { label: "Knowledge access logs", description: "Break-glass access history: who read tenant content under which grant." },
  cost_events: { label: "Cost events", description: "Model and tool cost per run, kept for the financial years." }
};

export function dataClassLabel(dc: string): string {
  return DATA_CLASS_LABELS[dc as DataClass]?.label ?? dc.replaceAll("_", " ");
}

export function isDataClass(value: string): value is DataClass {
  return (DATA_CLASSES as readonly string[]).includes(value);
}

/** Client-side mirror of the database CHECK (`retention_days >= retention_minimum_days(data_class)` and `<= 3650`). Returns the refusal text or null. */
export function validateRetentionDays(dataClass: string, days: number): string | null {
  if (!isDataClass(dataClass)) return `unknown data class "${dataClass}"`;
  if (!Number.isInteger(days)) return "retention days must be a whole number";
  const floor = RETENTION_MINIMUM_DAYS[dataClass];
  if (days < floor) return `${dataClassLabel(dataClass)} must be kept at least ${floor} days (platform floor)`;
  if (days > RETENTION_MAX_DAYS) return `retention cannot exceed ${RETENTION_MAX_DAYS} days`;
  return null;
}

export function retentionFloor(dataClass: string): number | null {
  return isDataClass(dataClass) ? RETENTION_MINIMUM_DAYS[dataClass] : null;
}

// Deletion requests ---------------------------------------------------------------------------------

export interface DeletionKindInfo {
  label: string;
  subjectLabel: string;
  help: string;
  /** Executed by the worker, or completed by a superadmin after the runbook. */
  automated: boolean;
}

export const DELETION_KIND_INFO: Record<DeletionKind, DeletionKindInfo> = {
  document: { label: "Document", subjectLabel: "Vault document path", help: "The exact path of the document in your Knowledge Vault, for example 19_history_and_archive/former-employee.md. The document, its revisions and its links are deleted; audit events stay.", automated: true },
  connection_data: { label: "Connection data", subjectLabel: "Connection id", help: "The id of the connection (Integration Center). Its sync runs and the KPI observations they produced are deleted; the connection itself and its consent history stay.", automated: true },
  subject_data: { label: "Subject data (person)", subjectLabel: "Person description", help: "Describe the person without copying more personal data than needed, for example 'former employee J., left 2026-03'. Not automated: the agency follows the runbook (answers, facts, documents) and records a written summary.", automated: false },
  tenant_offboarding: { label: "Tenant off-boarding", subjectLabel: "Confirmation", help: "Type the workspace slug to confirm. Not automated: the agency follows the off-boarding runbook (export, deletion per table, confirmation to the client) and records a written summary.", automated: false }
};

export function subjectRefHelp(kind: string): string {
  return DELETION_KIND_INFO[kind as DeletionKind]?.help ?? "Describe what must be deleted.";
}

export function deletionKindLabel(kind: string): string {
  return DELETION_KIND_INFO[kind as DeletionKind]?.label ?? kind.replaceAll("_", " ");
}

export function isAutomatedDeletion(kind: string): boolean {
  return DELETION_KIND_INFO[kind as DeletionKind]?.automated ?? false;
}

/** Mirrors `enforce_deletion_request`: which decisions a request in `state` still admits. */
export function deletionDecisionsFor(state: string): Array<"approved" | "rejected"> {
  switch (state) {
    case "requested":
      return ["approved", "rejected"];
    case "approved":
      return ["rejected"];
    default:
      return [];
  }
}

/** `summary` of a completed request rendered as rows: counts per table, or the manual note. */
export function summaryRows(summary: unknown): Array<{ key: string; value: string }> {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return [];
  const entries = Object.entries(summary as Record<string, unknown>);
  if (entries.length === 0) return [];
  return entries.map(([key, v]) => ({ key, value: typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "yes" : "no") : typeof v === "string" ? v : JSON.stringify(v) }));
}

/** What the request shows as its execution state, with the worker schedule where it applies. */
export function executionNote(kind: string, state: string): string {
  if (state === "completed") return isAutomatedDeletion(kind) ? "executed by the worker; counts below" : "completed manually by a superadmin after the runbook; summary below";
  if (state === "approved") return isAutomatedDeletion(kind) ? `approved, waiting: ${WORKER_SWEEP_SCHEDULE}` : "approved, waiting for manual completion by a superadmin (runbook)";
  if (state === "executing") return "executing now";
  if (state === "rejected") return "rejected; nothing is deleted";
  return "waiting for an agency reviewer's decision";
}
