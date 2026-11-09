import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import type { AnswerValue } from "@sbos/core";

/**
 * Pure helpers for the Knowledge Vault UI (M2-03, M2-06, M2-07, M2-11). No I/O, no database: everything
 * here is unit-tested in `test/vault-ui.test.ts`. Data access lives in `vault-queries.ts` and
 * `vault-actions.ts`.
 */

// Folder taxonomy -------------------------------------------------------------------------------------

/**
 * The 20 standard folders of a client vault (spec taxonomy `00_company_profile` to `19_history_and_archive`).
 * Folder names 04, 05, 06, 13 and 17 match the paths already written by the Discovery agent and the core
 * tests; the remaining labels follow the spec's chapter order. The browser shows all 20, also when empty.
 */
export const VAULT_FOLDERS: readonly string[] = [
  "00_company_profile",
  "01_strategy_and_goals",
  "02_departments_and_roles",
  "03_systems_and_integrations",
  "04_processes_as_is",
  "05_processes_to_be",
  "06_finance",
  "07_operations",
  "08_hr_and_people",
  "09_sales_marketing_customer",
  "10_decisions_and_approvals",
  "11_projects_automations",
  "12_kpis_and_reports",
  "13_interviews_and_open_questions",
  "14_findings_and_evidence",
  "15_meetings_and_communications",
  "16_agent_worklogs_and_handoffs",
  "17_policies_and_security",
  "18_sources_and_attachments",
  "19_history_and_archive",
];

export const FOLDER_RE = /^(0\d|1\d)_[a-z0-9_]+$/;
/** Same rule as `writeVaultDocument` in @sbos/core: `<NN_folder>/<name>.md`. */
export const DOC_PATH_RE = /^(0\d|1\d)_[a-z0-9_]+\/[A-Za-z0-9._/-]+\.md$/;

export interface FolderNode {
  folder: string;
  /** Human label: the folder name without its numeric prefix, underscores replaced. */
  label: string;
  count: number;
  /** False for a folder found in document paths that is not one of the 20 standard folders. */
  standard: boolean;
}

export function folderOf(path: string): string {
  return path.split("/")[0] ?? "";
}

export function folderLabel(folder: string): string {
  return folder.replace(/^\d\d_/, "").replaceAll("_", " ");
}

/** All 20 standard folders in order (count 0 when empty), followed by any non-standard folders found in `paths`. */
export function buildFolderTree(paths: readonly string[]): FolderNode[] {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const f = folderOf(p);
    if (!f) continue;
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const nodes: FolderNode[] = VAULT_FOLDERS.map((folder) => ({ folder, label: folderLabel(folder), count: counts.get(folder) ?? 0, standard: true }));
  const extra = [...counts.keys()].filter((f) => !VAULT_FOLDERS.includes(f)).sort();
  for (const folder of extra) nodes.push({ folder, label: folderLabel(folder), count: counts.get(folder) ?? 0, standard: false });
  return nodes;
}

// Roles -----------------------------------------------------------------------------------------------

export const CLIENT_ROLES = ["client_admin", "department_manager", "client_employee"] as const;
export type ClientRole = (typeof CLIENT_ROLES)[number];

/** The first client role in the request context, in order of authority. Null for operators under a grant. */
export function clientRole(roles: readonly string[]): ClientRole | null {
  for (const r of CLIENT_ROLES) if (roles.includes(r)) return r;
  return null;
}

/** Who may answer a question: the recipient role itself, or the client admin. */
export function canAnswerQuestion(roles: readonly string[], recipientRole: string): boolean {
  return roles.includes("client_admin") || roles.includes(recipientRole);
}

export function canSeeDrafts(roles: readonly string[]): boolean {
  return roles.includes("client_admin");
}

/** Editing and restoring documents: client_admin and department_manager. client_employee reads only. */
export function canEditDocuments(roles: readonly string[]): boolean {
  return roles.includes("client_admin") || roles.includes("department_manager");
}

/** Fact verification decisions: the database trigger allows client_admin, agency_reviewer and superadmin. */
export function canReviewFacts(roles: readonly string[]): boolean {
  return roles.includes("client_admin") || roles.includes("agency_reviewer") || roles.includes("superadmin");
}

export function canDecideProposals(roles: readonly string[]): boolean {
  return roles.includes("client_admin") || roles.includes("department_manager");
}

export function canManageVaultSettings(roles: readonly string[]): boolean {
  return roles.includes("client_admin");
}

// Answer parsing --------------------------------------------------------------------------------------

export const ANSWER_TYPES = ["text", "number", "boolean", "single_choice", "multi_choice", "date", "file", "system_reference"] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];

export interface RawAnswerInput {
  /** All values submitted under the name `value` (a checkbox group submits several). */
  values: string[];
}

/**
 * Turns the submitted form value(s) into the typed `AnswerValue` that `answerQuestion` stores.
 * Throws a plain Error with a user-facing message when the input does not fit the answer type.
 */
export function parseAnswerValue(answerType: string, input: RawAnswerInput, options: readonly string[] = []): AnswerValue {
  const first = (input.values[0] ?? "").trim();
  switch (answerType) {
    case "text":
    case "file":
    case "system_reference": {
      if (!first) throw new Error("an answer is required");
      if (first.length > 4000) throw new Error("answer is too long (max 4000 characters)");
      return first;
    }
    case "number": {
      if (!first) throw new Error("a number is required");
      const n = Number(first.replace(",", "."));
      if (!Number.isFinite(n)) throw new Error(`"${first}" is not a number`);
      return n;
    }
    case "boolean": {
      if (first === "yes" || first === "true") return true;
      if (first === "no" || first === "false") return false;
      throw new Error("choose yes or no");
    }
    case "single_choice": {
      if (!first) throw new Error("choose one option");
      if (options.length && !options.includes(first)) throw new Error(`"${first}" is not one of the offered options`);
      return first;
    }
    case "multi_choice": {
      const chosen = [...new Set(input.values.map((v) => v.trim()).filter(Boolean))];
      if (chosen.length === 0) throw new Error("choose at least one option");
      const unknown = options.length ? chosen.filter((c) => !options.includes(c)) : [];
      if (unknown.length) throw new Error(`"${unknown[0]}" is not one of the offered options`);
      return chosen;
    }
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(first)) throw new Error("a date in the form YYYY-MM-DD is required");
      if (Number.isNaN(new Date(`${first}T00:00:00Z`).getTime())) throw new Error(`"${first}" is not a valid date`);
      return first;
    }
    default:
      // Unknown answer types fall back to free text so a question is never unanswerable.
      if (!first) throw new Error("an answer is required");
      return first;
  }
}

// Frontmatter -----------------------------------------------------------------------------------------

/**
 * Parses the frontmatter textarea: JSON when it starts with `{`, otherwise `key: value` lines. Values that
 * parse as JSON (numbers, booleans, arrays, quoted strings) are typed; everything else stays a string.
 */
export function parseFrontmatterInput(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("frontmatter JSON must be an object");
    return parsed as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line === "---") continue;
    const idx = line.indexOf(":");
    if (idx <= 0) throw new Error(`frontmatter line "${line}" is not key: value`);
    const key = line.slice(0, idx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) throw new Error(`invalid frontmatter key "${key}"`);
    const value = line.slice(idx + 1).trim();
    out[key] = coerceScalar(value);
  }
  return out;
}

function coerceScalar(value: string): unknown {
  if (value === "") return "";
  if (/^(true|false|null|-?\d+(\.\d+)?|\[.*\]|".*"|\{.*\})$/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/** Inverse of `parseFrontmatterInput` for the edit form: one `key: value` line per entry. */
export function frontmatterToLines(fm: Record<string, unknown>): string {
  return Object.entries(fm)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}

/** Flat key/value rows for the frontmatter table. Nested values are shown as JSON. */
export function frontmatterRows(fm: unknown): Array<{ key: string; value: string }> {
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) return [];
  return Object.entries(fm as Record<string, unknown>).map(([key, v]) => ({ key, value: typeof v === "string" ? v : JSON.stringify(v) }));
}

// Line diff -------------------------------------------------------------------------------------------

export type DiffOp = { kind: "same" | "add" | "del"; text: string };

/** Minimal LCS line diff: `del` lines come from `before`, `add` lines from `after`. O(n*m), fine for vault documents. */
export function lineDiff(before: string, after: string): DiffOp[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++]! });
  while (j < m) out.push({ kind: "add", text: b[j++]! });
  return out;
}

export function diffSummary(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "add") added++;
    else if (op.kind === "del") removed++;
  }
  return { added, removed };
}

// Markdown --------------------------------------------------------------------------------------------

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "blockquote", "pre", "code", "em", "strong", "del", "ul", "ol", "li", "a", "table", "thead", "tbody", "tr", "th", "td", "img", "input", "span", "sup", "sub"],
  allowedAttributes: {
    a: ["href", "title", "rel", "target"],
    img: ["src", "alt", "title"],
    th: ["align"],
    td: ["align"],
    code: ["class"],
    input: ["type", "checked", "disabled"]
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["https"] },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  // Only checkbox inputs from task lists survive, and never interactive ones.
  exclusiveFilter: (frame) => frame.tag === "input" && frame.attribs.type !== "checkbox"
};

/**
 * Renders vault Markdown to HTML for a server component. `[[wikilinks]]` become links to the document page
 * under `linkBase` (for example `/c/<slug>/vault`). marked runs without its (removed) sanitiser; the output
 * goes through a strict allow-list, so `<script>`, event handlers and `javascript:` URLs never reach the page.
 */
export function renderMarkdown(markdown: string, opts: { linkBase?: string } = {}): string {
  const base = opts.linkBase ?? "";
  const withLinks = markdown.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, target: string, text?: string) => {
    const raw = target.trim();
    const path = raw.endsWith(".md") ? raw : `${raw}.md`;
    const label = (text ?? raw).trim();
    const href = base ? `${base}/${path.split("/").map(encodeURIComponent).join("/")}` : path;
    return `[${label}](${href})`;
  });
  const html = marked.parse(withLinks, { async: false, gfm: true, breaks: false }) as string;
  return sanitizeHtml(html, {
    ...SANITIZE_OPTIONS,
    // Relative links (our own document routes) are allowed; sanitize-html only checks absolute schemes.
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: "noopener", ...(attribs.href?.startsWith("http") ? { target: "_blank" } : {}) } })
    }
  });
}

// Misc ------------------------------------------------------------------------------------------------

export function truncate(text: string, max = 240): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}...`;
}

export const WRITE_MODES = ["auto_draft", "proposal_required"] as const;
export type WriteModeValue = (typeof WRITE_MODES)[number];

/** Builds the `vault.agent_write_mode` policy object from form values; folders left at "inherit" are omitted. */
export function buildWriteModePolicy(input: { default: string; folders: Record<string, string> }): Record<string, WriteModeValue> {
  const def = input.default === "proposal_required" ? "proposal_required" : "auto_draft";
  const out: Record<string, WriteModeValue> = { default: def };
  for (const [folder, mode] of Object.entries(input.folders)) {
    if (!FOLDER_RE.test(folder)) continue;
    if (mode === "auto_draft" || mode === "proposal_required") out[folder] = mode;
  }
  return out;
}
