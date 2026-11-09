import { describe, expect, it } from "vitest";
import { AGENCY_VAULT_FOLDERS } from "@sbos/core";
import { decideAgencyAccess } from "../lib/auth-policy";
import { errorMessage } from "../lib/format";
import {
  buildAgencyFolderTree,
  buildRecordPath,
  canReviewKnowledge,
  collectParameterValues,
  hasOperatorRole,
  knowledgeStateTone,
  moduleForFolder,
  parseJsonObject,
  parseTemplateParameters,
  placeholdersIn,
  promotionStateTone,
  recordActionsFor,
  sanitizeSnippet,
  sourceRefCounts,
  splitList,
  templateParametersToLines
} from "../lib/mission-control/agency-vault-helpers";

/**
 * Milestone 4 Agency Intelligence Vault UI rules. Pure functions only; the database-backed flows are covered by
 * packages/core/test/agency-knowledge.test.ts and the page checks in the handoff notes.
 */

describe("agency access rule", () => {
  it("admits every agency role and rejects client roles and anonymous users", () => {
    expect(decideAgencyAccess({ authenticated: false, agencyRoles: [], twoFactorEnabled: false })).toEqual({ kind: "redirect", to: "/sign-in", reason: "unauthenticated" });
    expect(decideAgencyAccess({ authenticated: true, agencyRoles: ["client_admin"], twoFactorEnabled: true })).toEqual({ kind: "redirect", to: "/sign-in", reason: "not_agency" });
    expect(decideAgencyAccess({ authenticated: true, agencyRoles: ["agency_reviewer"], twoFactorEnabled: false })).toEqual({ kind: "allow", roles: ["agency_reviewer"] });
    expect(decideAgencyAccess({ authenticated: true, agencyRoles: ["agency_consultant", "client_admin"], twoFactorEnabled: false })).toEqual({ kind: "allow", roles: ["agency_consultant"] });
  });
  it("keeps the MFA rule for superadmin and agency_operator exactly as Mission Control applies it", () => {
    expect(decideAgencyAccess({ authenticated: true, agencyRoles: ["superadmin"], twoFactorEnabled: false })).toEqual({ kind: "redirect", to: "/account/security", reason: "mfa_required" });
    expect(decideAgencyAccess({ authenticated: true, agencyRoles: ["agency_operator", "agency_reviewer"], twoFactorEnabled: false })).toEqual({ kind: "redirect", to: "/account/security", reason: "mfa_required" });
    expect(decideAgencyAccess({ authenticated: true, agencyRoles: ["superadmin"], twoFactorEnabled: true })).toEqual({ kind: "allow", roles: ["superadmin"] });
  });
  it("reviewer and operator helpers follow the trigger and ADR-015 role lists", () => {
    expect(canReviewKnowledge(["agency_consultant"])).toBe(false);
    expect(canReviewKnowledge(["agency_reviewer"])).toBe(true);
    expect(canReviewKnowledge(["superadmin"])).toBe(true);
    expect(hasOperatorRole(["agency_reviewer"])).toBe(false);
    expect(hasOperatorRole(["agency_operator"])).toBe(true);
  });
});

describe("folder tree and modules", () => {
  it("lists all 18 agency folders in order with counts, also when empty", () => {
    const tree = buildAgencyFolderTree(new Map());
    expect(tree).toHaveLength(18);
    expect(tree.map((n) => n.folder)).toEqual([...AGENCY_VAULT_FOLDERS]);
    expect(tree[0]).toMatchObject({ folder: "00_second_brain_strategy", label: "second brain strategy", count: 0 });
    const counted = buildAgencyFolderTree({ "06_process_patterns_and_sops": 2, "99_unknown": 1 });
    expect(counted.find((n) => n.folder === "06_process_patterns_and_sops")?.count).toBe(2);
    expect(counted).toHaveLength(19);
    expect(counted[18]).toMatchObject({ folder: "99_unknown", count: 1 });
  });
  it("maps the spec's named modules to folders 04, 05, 08 and 13", () => {
    expect(moduleForFolder("04_discovery_questions_and_assessments")?.label).toBe("Interview Library");
    expect(moduleForFolder("05_industry_blueprints")?.label).toBe("Industry Blueprints");
    expect(moduleForFolder("08_dashboards_kpis_and_design_system")?.label).toBe("Design System");
    expect(moduleForFolder("13_research_updates_and_release_reviews")?.label).toBe("Tech Watch");
    expect(moduleForFolder("06_process_patterns_and_sops")).toBeNull();
    expect(moduleForFolder(null)).toBeNull();
  });
});

describe("record paths", () => {
  it("builds <folder>/<file>.md and refuses bad input", () => {
    expect(buildRecordPath("06_process_patterns_and_sops", "closure-check")).toBe("06_process_patterns_and_sops/closure-check.md");
    expect(buildRecordPath("15_approved_reusable_insights", "/sub/insight.md")).toBe("15_approved_reusable_insights/sub/insight.md");
    expect(() => buildRecordPath("06_finance", "x")).toThrow(/agency vault folders/);
    expect(() => buildRecordPath("06_process_patterns_and_sops", "../x")).toThrow(/\.\./);
    expect(() => buildRecordPath("06_process_patterns_and_sops", "a b")).toThrow(/letters, digits/);
    expect(() => buildRecordPath("06_process_patterns_and_sops", "  ")).toThrow(/required/);
  });
});

describe("lifecycle buttons mirror the transition trigger", () => {
  it("offers only the transitions the database allows from each state", () => {
    expect(recordActionsFor("draft").map((a) => a.action)).toEqual(["in_review"]);
    expect(recordActionsFor("in_review").map((a) => a.action)).toEqual(["approved", "draft"]);
    expect(recordActionsFor("approved").map((a) => a.action)).toEqual(["published", "draft"]);
    expect(recordActionsFor("published").map((a) => a.action)).toEqual(["deprecate"]);
    expect(recordActionsFor("deprecated").map((a) => a.action)).toEqual(["reinstate", "archive"]);
    expect(recordActionsFor("archived")).toEqual([]);
  });
  it("marks approve, publish, deprecate, reinstate and archive as reviewer-only", () => {
    const reviewerOnly = ["draft", "in_review", "approved", "published", "deprecated"].flatMap((s) => recordActionsFor(s)).filter((a) => a.reviewerOnly).map((a) => a.action);
    expect(reviewerOnly).toEqual(["approved", "published", "draft", "deprecate", "reinstate", "archive"]);
    expect(recordActionsFor("draft")[0]?.reviewerOnly).toBe(false);
  });
  it("has a tone for every state", () => {
    expect(knowledgeStateTone("published")).toBe("success");
    expect(knowledgeStateTone("deprecated")).toBe("danger");
    expect(knowledgeStateTone("whatever")).toBe("neutral");
    expect(promotionStateTone("approved")).toBe("indigo");
  });
});

describe("template parameter lines", () => {
  it("parses key | label | required | default, with defaults for label and optional", () => {
    const params = parseTemplateParameters("project_system | Project system | required\nfinance_owner | Finance owner | required | finance\ninvoice_days | Invoice within (days) | optional | 2\n\nbare_key\n# comment\nwith_pipe | Pipe default | no | a | b");
    expect(params).toEqual([
      { key: "project_system", label: "Project system", required: true },
      { key: "finance_owner", label: "Finance owner", required: true, default: "finance" },
      { key: "invoice_days", label: "Invoice within (days)", required: false, default: "2" },
      { key: "bare_key", label: "bare_key", required: false },
      { key: "with_pipe", label: "Pipe default", required: false, default: "a | b" }
    ]);
    expect(templateParametersToLines(params.slice(0, 3))).toBe("project_system | Project system | required\nfinance_owner | Finance owner | required | finance\ninvoice_days | Invoice within (days) | optional | 2");
    expect(parseTemplateParameters(templateParametersToLines(params))).toEqual(params);
  });
  it("refuses bad keys, duplicates and unknown required words", () => {
    expect(() => parseTemplateParameters("Project | x")).toThrow(/parameter key/);
    expect(() => parseTemplateParameters("a | A\na | B")).toThrow(/twice/);
    expect(() => parseTemplateParameters("a | A | maybe")).toThrow(/required or optional/);
  });
  it("collects param_<key> values, applies defaults through the service and refuses a missing required value", () => {
    const params = parseTemplateParameters("project_system | P | required\nfinance_owner | F | required | finance\nnotes | N | optional");
    const read = (name: string) => ({ param_project_system: "Rentman", param_finance_owner: "", param_notes: "" })[name] ?? "";
    expect(collectParameterValues(params, read)).toEqual({ project_system: "Rentman" });
    expect(() => collectParameterValues(params, () => "")).toThrow(/project_system.*required/);
  });
  it("lists placeholders in a body once, in order", () => {
    expect(placeholdersIn("a {{x}} b {{ y }} c {{x}}")).toEqual(["x", "y"]);
    expect(placeholdersIn("none")).toEqual([]);
  });
});

describe("small parsers", () => {
  it("splits lists and parses JSON objects", () => {
    expect(splitList("a, b,,a\nc")).toEqual(["a", "b", "c"]);
    expect(parseJsonObject("", "input")).toEqual({});
    expect(parseJsonObject('{"a": 1}', "input")).toEqual({ a: 1 });
    expect(() => parseJsonObject("[1]", "input")).toThrow(/JSON object/);
    expect(() => parseJsonObject("{", "input")).toThrow(/valid JSON/);
  });
  it("renders source_refs as counts only", () => {
    expect(sourceRefCounts({ finding_ids: ["f1", "f2"], finding_count: 3, evidence: { a: 1 }, note: "x", empty: null })).toEqual([
      { key: "finding_ids", count: 2 },
      { key: "finding_count", count: 3 },
      { key: "evidence", count: 1 },
      { key: "note", count: 1 },
      { key: "empty", count: 0 }
    ]);
    expect(JSON.stringify(sourceRefCounts({ finding_ids: ["secret-id"] }))).not.toContain("secret-id");
    expect(sourceRefCounts(null)).toEqual([]);
  });
  it("keeps only <b> markers in a search snippet", () => {
    expect(sanitizeSnippet("closure <b>invoice</b> <script>alert(1)</script> <b onclick=\"x\">y</b>")).toBe("closure <b>invoice</b>  <b>y</b>");
  });
  it("shows the Postgres cause instead of drizzle's Failed query wrapper", () => {
    const cause = new Error("knowledge record transition draft -> published is not allowed");
    const wrapped = new Error("Failed query: update agency_knowledge_records set state = $1", { cause });
    expect(errorMessage(wrapped)).toBe(cause.message);
    expect(errorMessage(new Error("plain"))).toBe("plain");
    expect(errorMessage(new Error("Failed query: x"))).toBe("Failed query: x");
  });
});
