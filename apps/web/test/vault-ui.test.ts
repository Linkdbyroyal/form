import { describe, expect, it } from "vitest";
import {
  buildFolderTree,
  buildWriteModePolicy,
  canAnswerQuestion,
  canEditDocuments,
  canReviewFacts,
  clientRole,
  diffSummary,
  frontmatterToLines,
  lineDiff,
  parseAnswerValue,
  parseFrontmatterInput,
  renderMarkdown,
  VAULT_FOLDERS
} from "../lib/client/vault-helpers";

/**
 * M2-03 / M2-06 / M2-11 UI helpers. Pure functions only; the database-backed flows are covered by
 * packages/core/test/knowledge.test.ts and the page checks in the handoff notes.
 */

describe("folder tree", () => {
  it("lists all 20 standard folders in order, with counts, also when empty", () => {
    const tree = buildFolderTree([]);
    expect(tree).toHaveLength(20);
    expect(tree[0]).toMatchObject({ folder: "00_company_profile", count: 0, standard: true, label: "company profile" });
    expect(tree[19]).toMatchObject({ folder: "19_history_and_archive", count: 0 });
    expect(VAULT_FOLDERS.every((f) => /^(0\d|1\d)_[a-z0-9_]+$/.test(f))).toBe(true);
  });
  it("counts documents per folder and appends non-standard folders after the 20", () => {
    const tree = buildFolderTree(["04_processes_as_is/a.md", "04_processes_as_is/sub/b.md", "06_finance/invoicing.md", "99_custom/x.md"]);
    expect(tree.find((n) => n.folder === "04_processes_as_is")?.count).toBe(2);
    expect(tree.find((n) => n.folder === "06_finance")?.count).toBe(1);
    expect(tree.find((n) => n.folder === "00_company_profile")?.count).toBe(0);
    expect(tree).toHaveLength(21);
    expect(tree[20]).toMatchObject({ folder: "99_custom", count: 1, standard: false });
  });
});

describe("roles", () => {
  it("picks the highest client role and applies the answer, edit and review rules", () => {
    expect(clientRole(["client_employee", "client_admin"])).toBe("client_admin");
    expect(clientRole(["department_manager"])).toBe("department_manager");
    expect(clientRole(["superadmin"])).toBeNull();
    expect(canAnswerQuestion(["client_employee"], "department_manager")).toBe(false);
    expect(canAnswerQuestion(["department_manager"], "department_manager")).toBe(true);
    expect(canAnswerQuestion(["client_admin"], "department_manager")).toBe(true);
    expect(canEditDocuments(["client_employee"])).toBe(false);
    expect(canEditDocuments(["department_manager"])).toBe(true);
    expect(canReviewFacts(["department_manager"])).toBe(false);
    expect(canReviewFacts(["client_admin"])).toBe(true);
  });
});

describe("answer parsing per answer_type", () => {
  it("text, file and system_reference keep the string", () => {
    expect(parseAnswerValue("text", { values: ["  yes, manually  "] })).toBe("yes, manually");
    expect(parseAnswerValue("file", { values: ["Dropbox/report.pdf"] })).toBe("Dropbox/report.pdf");
    expect(parseAnswerValue("system_reference", { values: ["Rentman project 4512"] })).toBe("Rentman project 4512");
    expect(() => parseAnswerValue("text", { values: [""] })).toThrow(/required/);
  });
  it("number accepts decimal commas and rejects non-numbers", () => {
    expect(parseAnswerValue("number", { values: ["12"] })).toBe(12);
    expect(parseAnswerValue("number", { values: ["3,5"] })).toBe(3.5);
    expect(() => parseAnswerValue("number", { values: ["twelve"] })).toThrow(/not a number/);
  });
  it("boolean maps yes/no", () => {
    expect(parseAnswerValue("boolean", { values: ["yes"] })).toBe(true);
    expect(parseAnswerValue("boolean", { values: ["no"] })).toBe(false);
    expect(() => parseAnswerValue("boolean", { values: ["maybe"] })).toThrow(/yes or no/);
  });
  it("single_choice and multi_choice are limited to the offered options", () => {
    const options = ["Rentman", "QuickBooks", "Excel"];
    expect(parseAnswerValue("single_choice", { values: ["Rentman"] }, options)).toBe("Rentman");
    expect(() => parseAnswerValue("single_choice", { values: ["Xero"] }, options)).toThrow(/not one of/);
    expect(parseAnswerValue("multi_choice", { values: ["Rentman", "Excel", "Rentman"] }, options)).toEqual(["Rentman", "Excel"]);
    expect(() => parseAnswerValue("multi_choice", { values: [] }, options)).toThrow(/at least one/);
    expect(() => parseAnswerValue("multi_choice", { values: ["Rentman", "Xero"] }, options)).toThrow(/Xero/);
  });
  it("date requires YYYY-MM-DD", () => {
    expect(parseAnswerValue("date", { values: ["2026-03-01"] })).toBe("2026-03-01");
    expect(() => parseAnswerValue("date", { values: ["01/03/2026"] })).toThrow(/YYYY-MM-DD/);
    expect(() => parseAnswerValue("date", { values: ["2026-13-45"] })).toThrow(/valid date/);
  });
  it("unknown answer types fall back to text", () => {
    expect(parseAnswerValue("something_new", { values: ["free text"] })).toBe("free text");
  });
});

describe("frontmatter", () => {
  it("parses key: value lines with typed scalars and round-trips through frontmatterToLines", () => {
    const fm = parseFrontmatterInput('tags: ["finance", "process"]\nowner: finance manager\nreviewed: true\npriority: 2\n');
    expect(fm).toEqual({ tags: ["finance", "process"], owner: "finance manager", reviewed: true, priority: 2 });
    expect(parseFrontmatterInput(frontmatterToLines(fm))).toEqual(fm);
  });
  it("accepts a JSON object and rejects arrays and malformed lines", () => {
    expect(parseFrontmatterInput('{"a": 1}')).toEqual({ a: 1 });
    expect(() => parseFrontmatterInput("[1, 2]")).toThrow();
    expect(() => parseFrontmatterInput("no colon here")).toThrow(/key: value/);
    expect(parseFrontmatterInput("")).toEqual({});
  });
});

describe("line diff", () => {
  it("marks added, removed and unchanged lines and counts them", () => {
    const ops = lineDiff("a\nb\nc", "a\nx\nc\nd");
    expect(ops).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "x" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" }
    ]);
    expect(diffSummary(ops)).toEqual({ added: 2, removed: 1 });
  });
  it("identical inputs produce only same ops", () => {
    expect(lineDiff("one\ntwo", "one\ntwo").every((o) => o.kind === "same")).toBe(true);
  });
});

describe("markdown rendering", () => {
  it("renders headings, lists and wikilinks to document routes", () => {
    const html = renderMarkdown("# Title\n\n- item\n\nSee [[04_processes_as_is/quote-to-cash|the process]] and [[06_finance/invoicing]].", { linkBase: "/c/northline/vault" });
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li>item</li>");
    expect(html).toContain('href="/c/northline/vault/04_processes_as_is/quote-to-cash.md"');
    expect(html).toContain(">the process</a>");
    expect(html).toContain('href="/c/northline/vault/06_finance/invoicing.md"');
  });
  it("strips script tags, event handlers and javascript: URLs", () => {
    const html = renderMarkdown('Hello <script>alert(1)</script> <img src="x" onerror="alert(1)"> [bad](javascript:alert(1)) <a href="https://ok.example" onclick="evil()">ok</a>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://ok.example"');
    expect(html).toContain('target="_blank"');
  });
  it("drops iframes, style blocks and non-https images", () => {
    const html = renderMarkdown('<iframe src="https://x"></iframe>\n\n<style>body{}</style>\n\n![a](http://insecure.example/i.png)\n\n![b](https://secure.example/i.png)');
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<style");
    expect(html).not.toContain('src="http://insecure.example');
    expect(html).toContain('src="https://secure.example/i.png"');
  });
});

describe("write mode policy", () => {
  it("keeps the default and only valid folder overrides", () => {
    const value = buildWriteModePolicy({ default: "proposal_required", folders: { "06_finance": "auto_draft", "17_policies_and_security": "proposal_required", "04_processes_as_is": "inherit", "bad folder": "auto_draft" } });
    expect(value).toEqual({ default: "proposal_required", "06_finance": "auto_draft", "17_policies_and_security": "proposal_required" });
    expect(buildWriteModePolicy({ default: "nonsense", folders: {} })).toEqual({ default: "auto_draft" });
  });
});
