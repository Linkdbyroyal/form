import { describe, expect, it } from "vitest";
import { WidgetTypeSchema } from "@sbos/contracts";
import { parseDashboardSpecification, WIDGET_TYPES } from "../components/dashboard/spec";
import { WIDGET_RENDERERS } from "../components/dashboard/widgets";
import { deriveKpiState, formatKpiValue, maturityScore, thresholdLevel } from "../lib/client/kpi-state";
import { parseDepartments, parseSystems } from "../lib/mission-control/onboarding-parse";

/**
 * M3-03 / M3-10 UI rules. Pure functions and the widget registry only; the database-backed flows are
 * covered by packages/core/test and apps/worker demo-flow-check, the pages by the handoff route checks.
 */

const validSpec = {
  dashboard_id: "9dc040dc-697e-456a-b090-bfe0d35ed55c",
  tenant_id: "019e0ae7-66fe-4d22-8226-660af92274d0",
  audience_role: "ceo",
  title: "CEO Dashboard",
  locale: "en",
  version: 1,
  review_status: "unreviewed",
  widgets: [
    { widget_id: "5bf45100-fa43-4bfb-816c-39db751507fb", type: "data_gap_list", kpi_ids: [], priority: 1, reason: "show gaps", size: "l" },
    { widget_id: "c8efdea5-49e8-4505-b3c1-69c4a9021cf1", type: "kpi_tile", kpi_ids: ["8a9f4d50-b5f4-4ffc-83c0-a3ad4e7ad2ef"], priority: 2, reason: "internal KPI", size: "s" }
  ]
};

describe("widget whitelist", () => {
  it("renders exactly the nine contract widget types, nothing more, nothing less", () => {
    const contractTypes = [...WidgetTypeSchema.options].sort();
    expect(contractTypes).toHaveLength(9);
    expect(Object.keys(WIDGET_RENDERERS).sort()).toEqual(contractTypes);
    expect([...WIDGET_TYPES].sort()).toEqual(contractTypes);
    for (const t of contractTypes) expect(typeof WIDGET_RENDERERS[t as keyof typeof WIDGET_RENDERERS]).toBe("function");
  });
  it("has no renderer for an unknown type", () => {
    expect((WIDGET_RENDERERS as Record<string, unknown>)["iframe"]).toBeUndefined();
    expect((WIDGET_RENDERERS as Record<string, unknown>)["html"]).toBeUndefined();
  });
});

describe("specification gate", () => {
  it("accepts a valid specification and keeps widget order data intact", () => {
    const r = parseDashboardSpecification(validSpec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.widgets).toHaveLength(2);
  });
  it("refuses an unknown widget type", () => {
    const r = parseDashboardSpecification({ ...validSpec, widgets: [{ ...validSpec.widgets[0], type: "iframe" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join("\n")).toMatch(/widgets\.0\.type/);
  });
  it("refuses duplicate widget ids, markup in config and a missing reason", () => {
    const dup = parseDashboardSpecification({ ...validSpec, widgets: [validSpec.widgets[0], { ...validSpec.widgets[1], widget_id: validSpec.widgets[0]!.widget_id }] });
    expect(dup.ok).toBe(false);
    const markup = parseDashboardSpecification({ ...validSpec, widgets: [{ ...validSpec.widgets[0], config: { text: { html: "<script>" } } }] });
    expect(markup.ok).toBe(false);
    const noReason = parseDashboardSpecification({ ...validSpec, widgets: [{ ...validSpec.widgets[0], reason: "" }] });
    expect(noReason.ok).toBe(false);
  });
  it("refuses garbage and non-objects with a message, never throws", () => {
    expect(parseDashboardSpecification(null).ok).toBe(false);
    expect(parseDashboardSpecification("x").ok).toBe(false);
    const r = parseDashboardSpecification({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/not rendered/);
  });
});

describe("KPI state derivation", () => {
  const base = { direction: "lower_is_better", warningThreshold: "3", criticalThreshold: "8" };
  it("maps observation statuses to render states and never produces a number for a non-ok status", () => {
    expect(deriveKpiState({ ...base, status: null, value: null })).toMatchObject({ state: "missing", value: null, label: "Missing data" });
    expect(deriveKpiState({ ...base, status: "missing_data", value: null })).toMatchObject({ state: "missing", value: null });
    expect(deriveKpiState({ ...base, status: "stale_data", value: null })).toMatchObject({ state: "stale", value: null, label: "Stale data" });
    expect(deriveKpiState({ ...base, status: "error", value: null })).toMatchObject({ state: "error", value: null, label: "Error" });
    expect(deriveKpiState({ ...base, status: "something_else", value: "5" })).toMatchObject({ state: "error", value: null });
    expect(deriveKpiState({ ...base, status: "ok", value: null })).toMatchObject({ state: "error" });
  });
  it("colours by direction: lower_is_better crosses at or above, higher_is_better at or below", () => {
    expect(deriveKpiState({ ...base, status: "ok", value: "2" })).toMatchObject({ state: "ok", value: 2, level: "normal" });
    expect(deriveKpiState({ ...base, status: "ok", value: "3" })).toMatchObject({ level: "warning" });
    expect(deriveKpiState({ ...base, status: "ok", value: "9" })).toMatchObject({ level: "critical" });
    const higher = { direction: "higher_is_better", warningThreshold: "80", criticalThreshold: "50" };
    expect(deriveKpiState({ ...higher, status: "ok", value: "95" })).toMatchObject({ level: "normal" });
    expect(deriveKpiState({ ...higher, status: "ok", value: "80" })).toMatchObject({ level: "warning" });
    expect(deriveKpiState({ ...higher, status: "ok", value: "20" })).toMatchObject({ level: "critical" });
    expect(thresholdLevel(6, "lower_is_better", null, null)).toBe("normal");
    expect(thresholdLevel(6, "lower_is_better", null, "6")).toBe("critical");
  });
  it("formats values with their unit", () => {
    expect(formatKpiValue(6, "count")).toBe("6");
    expect(formatKpiValue(12.5, "days")).toBe("12.5 days");
    expect(formatKpiValue(1234.567, "EUR")).toBe("1234.57 EUR");
  });
});

describe("maturity scorecard", () => {
  const input = { answeredQuestions: 3, totalQuestions: 6, verifiedFacts: 1, totalFacts: 4, systems: 2, verifiedSystems: 0, openCriticalFindings: 0, openHighFindings: 1 };
  it("is deterministic and lists its inputs", () => {
    const a = maturityScore(input);
    const b = maturityScore({ ...input });
    expect(a).toEqual(b);
    // answers 20 + evidence 7.5 + systems 0 - penalty 8 = 19.5 -> 20
    expect(a.score).toBe(20);
    expect(a.components).toEqual({ answers: 20, evidence: 7.5, systems: 0, penalty: 8 });
    expect(a.inputs.map((i) => i.label)).toEqual(["Answered questions", "Verified facts", "Verified or connected systems", "Open critical findings", "Open high findings"]);
    expect(a.inputs[0]).toEqual({ label: "Answered questions", value: "3 of 6" });
  });
  it("returns uncertainty levels from the evidence count", () => {
    expect(maturityScore({ ...input, answeredQuestions: 0, verifiedFacts: 0 }).uncertainty).toBe("high");
    expect(maturityScore(input).uncertainty).toBe("medium");
    expect(maturityScore({ ...input, answeredQuestions: 6, verifiedFacts: 4 }).uncertainty).toBe("low");
  });
  it("clamps to 0..100, caps the penalty at 30 and has no score without inputs", () => {
    expect(maturityScore({ ...input, openCriticalFindings: 5, openHighFindings: 5 }).components.penalty).toBe(30);
    expect(maturityScore({ ...input, answeredQuestions: 0, verifiedFacts: 0, openCriticalFindings: 2 }).score).toBe(0);
    expect(maturityScore({ answeredQuestions: 10, totalQuestions: 10, verifiedFacts: 5, totalFacts: 5, systems: 2, verifiedSystems: 2, openCriticalFindings: 0, openHighFindings: 0 }).score).toBe(100);
    expect(maturityScore({ answeredQuestions: 0, totalQuestions: 0, verifiedFacts: 0, totalFacts: 0, systems: 0, verifiedSystems: 0, openCriticalFindings: 0, openHighFindings: 0 }).score).toBeNull();
  });
});

describe("onboarding wizard parsers", () => {
  it("parses departments and systems lines", () => {
    const depts = parseDepartments("management|Management|client_admin\nfinance|Finance|department_manager\n\nops|Operations\n");
    expect(depts).toEqual([
      { key: "management", name: "Management", headRole: "client_admin" },
      { key: "finance", name: "Finance", headRole: "department_manager" },
      { key: "ops", name: "Operations", headRole: null }
    ]);
    const systems = parseSystems("Rentman|Rentman|Projects and crew|ops|api, mcp\nSheet||Manual list||", new Set(depts.map((d) => d.key)));
    expect(systems).toEqual([
      { name: "Rentman", vendor: "Rentman", function: "Projects and crew", departmentKey: "ops", apiCapabilities: ["api", "mcp"] },
      { name: "Sheet", vendor: null, function: "Manual list", departmentKey: null, apiCapabilities: ["none"] }
    ]);
  });
  it("refuses bad keys, unknown departments, unknown capabilities and duplicates", () => {
    expect(() => parseDepartments("Bad Key|Name")).toThrow(/department key/);
    expect(() => parseDepartments("a|A\na|B")).toThrow(/twice/);
    expect(() => parseDepartments("a|A|boss")).toThrow(/head role/);
    expect(() => parseSystems("X|v|fn|nope|api", new Set(["a"]))).toThrow(/department key/);
    expect(() => parseSystems("X|v|fn|a|ftp", new Set(["a"]))).toThrow(/capability/);
    expect(() => parseSystems("X|v|fn\nx|w|fn2", new Set())).toThrow(/twice/);
    expect(() => parseSystems("X|v||", new Set())).toThrow(/function/);
  });
});

describe("widget render states (server markup)", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const kpiId = "8a9f4d50-b5f4-4ffc-83c0-a3ad4e7ad2ef";
  const kpi = { kpiId, key: "open_q", name: "Open questions", unit: "count", kpiStatus: "active", sourceSystem: "second-brain", sourceField: "questions.state", formula: "count(open)", ownerRole: "client_admin", direction: "lower_is_better", warningThreshold: null, criticalThreshold: null, lastSuccessfulSyncAt: null, status: "missing_data" as string | null, value: null as string | null, observedAt: "2026-11-09T21:04:57.000Z" };
  const widget = (type: string, config?: Record<string, string | number | boolean>) => ({ widget_id: "5bf45100-fa43-4bfb-816c-39db751507fb", type: type as never, kpi_ids: [kpiId], priority: 1, reason: "because", size: "m" as const, config });
  const data = (overrides: Partial<Parameters<(typeof WIDGET_RENDERERS)["kpi_tile"]>[0]["data"]> = {}) => ({ slug: "t", kpis: [kpi], history: {}, tasks: [], findings: [], briefing: null, ...overrides });
  const render = (type: string, d = data(), config?: Record<string, string | number | boolean>) => renderToStaticMarkup(WIDGET_RENDERERS[type as keyof typeof WIDGET_RENDERERS]({ widget: widget(type, config), data: d }) as React.ReactElement);

  it("shows Missing data as a state and the reason footnote, never a number", () => {
    const html = render("kpi_tile");
    expect(html).toContain("Missing data");
    expect(html).toContain("Why on this dashboard");
    expect(html).not.toMatch(/text-3xl[^>]*>\d/);
  });
  it("shows Stale data and Error states", () => {
    expect(render("kpi_tile", data({ kpis: [{ ...kpi, status: "stale_data" }] }))).toContain("Stale data");
    expect(render("kpi_tile", data({ kpis: [{ ...kpi, status: "error" }] }))).toContain(">Error<");
  });
  it("needs two ok observations before a chart renders", () => {
    const one = data({ kpis: [{ ...kpi, status: "ok", value: "6" }], history: { [kpiId]: [{ observedAt: "2026-11-09T00:00:00Z", periodStart: "2026-11-08T00:00:00Z", periodEnd: "2026-11-09T00:00:00Z", status: "ok", value: "6" }, { observedAt: "2026-11-08T00:00:00Z", periodStart: "2026-11-07T00:00:00Z", periodEnd: "2026-11-08T00:00:00Z", status: "missing_data", value: null }] } });
    expect(render("trend_line", one)).toContain("Not enough data");
    expect(render("bar", one)).toContain("Not enough data");
  });
  it("lists a KPI without ok data in the data gap list with its source", () => {
    const html = render("data_gap_list");
    expect(html).toContain("second-brain");
    expect(html).toContain("questions.state");
  });
  it("sanitises markdown in a text note and renders plain text otherwise", () => {
    const md = render("text_note", data(), { text: "# Hello\n\n<script>alert(1)</script>**bold**", markdown: true });
    expect(md).toContain("<h1>Hello</h1>");
    expect(md).not.toContain("<script>");
    const plain = render("text_note", data(), { text: "<b>plain</b>" });
    expect(plain).toContain("&lt;b&gt;plain&lt;/b&gt;");
  });
});
