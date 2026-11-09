import sanitizeHtml from "sanitize-html";
import type { Tone } from "@/components/ui";
import { AGENCY_VAULT_FOLDERS, CLIENT_VAULT_FOLDERS } from "@sbos/core";
import type { schema } from "@sbos/db";

/**
 * Pure helpers for the Agency Intelligence Vault UI (spec 4H, Milestone 4). No I/O, no database; everything
 * here is unit-tested in `test/agency-vault.test.ts`. Data access lives in `agency-vault-queries.ts`, writes in
 * `agency-vault-actions.ts`.
 */

export type KnowledgeState = "draft" | "in_review" | "approved" | "published" | "deprecated" | "archived";
export type PromotionState = "nominated" | "in_review" | "approved" | "rejected" | "withdrawn" | "published";
export type AdoptionState = "active" | "superseded" | "rolled_back" | "revoked";

export const KNOWLEDGE_STATES: readonly KnowledgeState[] = ["draft", "in_review", "approved", "published", "deprecated", "archived"];
export const RECORD_KINDS = ["method_template", "process_pattern", "interview_set", "sop", "dashboard_template", "kpi_definition", "skill_note", "blueprint", "reusable_insight", "research_note", "decision", "other"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
export const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"] as const;
/** Origins a person may pick on the create form. `abstracted_from_client` exists only through the promotion flow. */
export const CREATABLE_ORIGINS = ["own", "public_license"] as const;
export const PROMOTION_DECISIONS = ["approve", "reject", "needs_changes"] as const;
export const CONSENT_STATUSES = ["pending", "granted", "not_required", "revoked"] as const;
export const AGENCY_ROLES = ["superadmin", "agency_operator", "agency_reviewer", "agency_consultant"] as const;
export const REVIEWER_ROLES = ["agency_reviewer", "superadmin"] as const;
export const OPERATOR_ROLES = ["superadmin", "agency_operator"] as const;

// Tones ---------------------------------------------------------------------------------------------

const KNOWLEDGE_TONES: Record<KnowledgeState, Tone> = { draft: "neutral", in_review: "warning", approved: "cyan", published: "success", deprecated: "danger", archived: "neutral" };
const PROMOTION_TONES: Record<PromotionState, Tone> = { nominated: "warning", in_review: "cyan", approved: "indigo", rejected: "danger", withdrawn: "neutral", published: "success" };
const ADOPTION_TONES: Record<AdoptionState, Tone> = { active: "success", superseded: "neutral", rolled_back: "warning", revoked: "danger" };
const RISK_TONES: Record<string, Tone> = { low: "neutral", medium: "warning", high: "danger" };
const CONSENT_TONES: Record<string, Tone> = { pending: "warning", granted: "success", not_required: "cyan", revoked: "danger" };
const EVAL_TONES: Record<string, Tone> = { pass: "success", fail: "danger", not_run: "neutral" };
const EVENT_TONES: Record<string, Tone> = { release: "success", rollback: "warning", deprecate: "danger", reinstate: "cyan", archive: "neutral", consent_review: "indigo" };

export function knowledgeStateTone(state: string): Tone {
  return KNOWLEDGE_TONES[state as KnowledgeState] ?? "neutral";
}
export function promotionStateTone(state: string): Tone {
  return PROMOTION_TONES[state as PromotionState] ?? "neutral";
}
export function adoptionStateTone(state: string): Tone {
  return ADOPTION_TONES[state as AdoptionState] ?? "neutral";
}
export function riskTone(value: string): Tone {
  return RISK_TONES[value] ?? "neutral";
}
export function consentTone(value: string): Tone {
  return CONSENT_TONES[value] ?? "neutral";
}
export function evalResultTone(value: string): Tone {
  return EVAL_TONES[value] ?? "neutral";
}
export function deprecationEventTone(value: string): Tone {
  return EVENT_TONES[value] ?? "neutral";
}

// Roles ---------------------------------------------------------------------------------------------

/** Review, approve, publish, deprecate, release and rollback buttons: the database trigger allows agency_reviewer and superadmin. */
export function canReviewKnowledge(roles: readonly string[]): boolean {
  return roles.some((r) => (REVIEWER_ROLES as readonly string[]).includes(r));
}

/** Mission Control operators (ADR-015). Used to decide whether the full operator navigation applies. */
export function hasOperatorRole(roles: readonly string[]): boolean {
  return roles.some((r) => (OPERATOR_ROLES as readonly string[]).includes(r));
}

export function isAgencyRole(role: string): boolean {
  return (AGENCY_ROLES as readonly string[]).includes(role);
}

// Lifecycle -----------------------------------------------------------------------------------------

export interface RecordAction {
  /** Target state for `transitionKnowledgeRecord`, or a deprecation kind for `deprecateKnowledgeRecord`. */
  action: "in_review" | "draft" | "approved" | "published" | "deprecate" | "reinstate" | "archive";
  label: string;
  reviewerOnly: boolean;
  destructive: boolean;
}

/** Mirrors the `enforce_knowledge_transition` trigger: which buttons a record in `state` offers. */
export function recordActionsFor(state: string): RecordAction[] {
  switch (state) {
    case "draft":
      return [{ action: "in_review", label: "Submit for review", reviewerOnly: false, destructive: false }];
    case "in_review":
      return [
        { action: "approved", label: "Approve", reviewerOnly: true, destructive: false },
        { action: "draft", label: "Return to draft", reviewerOnly: false, destructive: false }
      ];
    case "approved":
      return [
        { action: "published", label: "Publish", reviewerOnly: true, destructive: false },
        { action: "draft", label: "Return to draft", reviewerOnly: true, destructive: false }
      ];
    case "published":
      return [{ action: "deprecate", label: "Deprecate", reviewerOnly: true, destructive: true }];
    case "deprecated":
      return [
        { action: "reinstate", label: "Reinstate", reviewerOnly: true, destructive: false },
        { action: "archive", label: "Archive", reviewerOnly: true, destructive: true }
      ];
    default:
      return [];
  }
}

// Folders and modules -------------------------------------------------------------------------------

export interface AgencyFolderNode {
  folder: string;
  label: string;
  count: number;
}

export function agencyFolderLabel(folder: string): string {
  return folder.replace(/^\d\d_/, "").replaceAll("_", " ");
}

/** All 18 agency folders in order with record counts (0 when empty). Unknown folders in `counts` are appended. */
export function buildAgencyFolderTree(counts: ReadonlyMap<string, number> | Record<string, number>): AgencyFolderNode[] {
  const map = counts instanceof Map ? counts : new Map(Object.entries(counts));
  const nodes: AgencyFolderNode[] = AGENCY_VAULT_FOLDERS.map((folder) => ({ folder, label: agencyFolderLabel(folder), count: map.get(folder) ?? 0 }));
  for (const [folder, count] of [...map.entries()].sort()) {
    if (!(AGENCY_VAULT_FOLDERS as readonly string[]).includes(folder)) nodes.push({ folder, label: agencyFolderLabel(folder), count });
  }
  return nodes;
}

/** The spec's named modules that are views on one agency folder each. */
export const AGENCY_MODULES = [
  { key: "interviews", label: "Interview Library", folder: "04_discovery_questions_and_assessments" },
  { key: "blueprints", label: "Industry Blueprints", folder: "05_industry_blueprints" },
  { key: "design", label: "Design System", folder: "08_dashboards_kpis_and_design_system" },
  { key: "techwatch", label: "Tech Watch", folder: "13_research_updates_and_release_reviews" }
] as const;

export function moduleForFolder(folder: string | null): (typeof AGENCY_MODULES)[number] | null {
  if (!folder) return null;
  return AGENCY_MODULES.find((m) => m.folder === folder) ?? null;
}

// Paths ---------------------------------------------------------------------------------------------

const FILE_NAME_RE = /^[A-Za-z0-9._/-]+$/;

/** Builds `<folder>/<file>.md` from the create form; the folder must be one of the 18 agency folders. */
export function buildRecordPath(folder: string, fileName: string): string {
  if (!(AGENCY_VAULT_FOLDERS as readonly string[]).includes(folder)) throw new Error(`"${folder}" is not one of the ${AGENCY_VAULT_FOLDERS.length} agency vault folders`);
  let name = fileName.trim().replace(/^\/+/, "");
  if (!name) throw new Error("file name is required");
  if (name.includes("..")) throw new Error("file name must not contain ..");
  if (!name.endsWith(".md")) name = `${name}.md`;
  if (!FILE_NAME_RE.test(name)) throw new Error("file name may contain letters, digits, dots, dashes, underscores and slashes only");
  return `${folder}/${name}`;
}

export function isClientFolder(folder: string): boolean {
  return (CLIENT_VAULT_FOLDERS as readonly string[]).includes(folder);
}

// Template parameters -------------------------------------------------------------------------------

const PARAM_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const TRUE_WORDS = new Set(["required", "yes", "true", "1", "y"]);
const FALSE_WORDS = new Set(["", "optional", "no", "false", "0", "n"]);

/**
 * Parses one parameter per line: `key | label | required | default`. Label defaults to the key; the third field
 * accepts required/optional (also yes/no, true/false); the default is free text. Keys must match the `{{key}}`
 * placeholder rule of `renderTemplate` (lowercase, digits, underscores).
 */
export function parseTemplateParameters(text: string): schema.TemplateParameter[] {
  const out: schema.TemplateParameter[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([^|]*)(?:\|([^|]*))?(?:\|([^|]*))?(?:\|(.*))?$/.exec(line);
    const key = (m?.[1] ?? "").trim();
    const label = (m?.[2] ?? "").trim();
    const requiredRaw = (m?.[3] ?? "").trim();
    const def = (m?.[4] ?? "").trim();
    if (!PARAM_KEY_RE.test(key)) throw new Error(`parameter key "${key}" must be lowercase letters, digits or underscores and start with a letter`);
    if (seen.has(key)) throw new Error(`parameter key ${key} appears twice`);
    const word = requiredRaw.toLowerCase();
    let required: boolean;
    if (TRUE_WORDS.has(word)) required = true;
    else if (FALSE_WORDS.has(word)) required = false;
    else throw new Error(`parameter ${key}: the third field must be required or optional, got "${requiredRaw}"`);
    seen.add(key);
    const p: schema.TemplateParameter = { key, label: (label || key).slice(0, 120), required };
    if (def) p.default = def.slice(0, 500);
    out.push(p);
  }
  return out;
}

/** Inverse of `parseTemplateParameters`, for prefilled forms. */
export function templateParametersToLines(parameters: readonly schema.TemplateParameter[]): string {
  return parameters.map((p) => `${p.key} | ${p.label} | ${p.required ? "required" : "optional"}${p.default !== undefined ? ` | ${p.default}` : ""}`).join("\n");
}

/** Reads `param_<key>` form fields for the declared parameters. Empty optional values fall back to the default inside `renderTemplate`. */
export function collectParameterValues(parameters: readonly schema.TemplateParameter[], read: (name: string) => string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const p of parameters) {
    const v = read(`param_${p.key}`).trim();
    if (v) values[p.key] = v;
    else if (p.required && p.default === undefined) throw new Error(`parameter "${p.key}" (${p.label}) is required`);
  }
  return values;
}

/** `{{key}}` placeholders used in a body, in order of first appearance. Lets the create-template form warn about undeclared ones. */
export function placeholdersIn(body: string): string[] {
  const found: string[] = [];
  for (const m of body.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)) {
    const key = m[1]!;
    if (!found.includes(key)) found.push(key);
  }
  return found;
}

// Small parsers -------------------------------------------------------------------------------------

/** Comma or newline separated list, trimmed, de-duplicated, empty entries dropped. */
export function splitList(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,\n]/)) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** A JSON object from a textarea; empty text is `{}`. Arrays and scalars are refused. */
export function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

/**
 * `source_refs` of a promotion request rendered as counts only (spec 4H: the review shows that evidence exists,
 * never the client's identifiers). Arrays count their items, objects their keys, numbers are taken as a count.
 */
export function sourceRefCounts(refs: unknown): Array<{ key: string; count: number }> {
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) return [];
  return Object.entries(refs as Record<string, unknown>).map(([key, v]) => {
    if (Array.isArray(v)) return { key, count: v.length };
    if (typeof v === "number" && Number.isFinite(v)) return { key, count: Math.max(0, Math.trunc(v)) };
    if (v && typeof v === "object") return { key, count: Object.keys(v as object).length };
    return { key, count: v === null || v === undefined || v === "" ? 0 : 1 };
  });
}

/** A `ts_headline` snippet keeps only its <b> match markers; everything else is escaped or dropped. */
export function sanitizeSnippet(snippet: string): string {
  return sanitizeHtml(snippet, { allowedTags: ["b"], allowedAttributes: {}, disallowedTagsMode: "discard" });
}

export function recordHref(id: string): string {
  return `/mission-control/agency-vault/records/${id}`;
}

/** Short actor label: `user:abcdef12` style for UUIDs, the raw id otherwise. */
export function shortActor(actorId: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actorId) ? actorId.slice(0, 8) : actorId.length > 40 ? `${actorId.slice(0, 40)}…` : actorId;
}
