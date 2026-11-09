import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AgentFeedbackSchema,
  AgentRunResultSchema,
  AnswerRecordSchema,
  ApprovalRequestSchema,
  CONTRACTS_VERSION,
  DashboardSpecificationSchema,
  EvidenceRecordSchema,
  ExecutiveBriefingSchema,
  FactVerificationRequestSchema,
  FindingSchema,
  KnowledgeFactSchema,
  KpiDefinitionSchema,
  KpiObservationSchema,
  MissionControlSummarySchema,
  OpportunitySchema,
  QuestionRequestSchema,
  UpgradeProposalSchema,
  VaultDocumentSchema,
  contractNames,
  toJsonSchemas
} from "../src/index";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ID_A = "22222222-2222-4222-8222-222222222222";
const ID_B = "33333333-3333-4333-8333-333333333333";
const ID_C = "44444444-4444-4444-8444-444444444444";
const ID_D = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-11-09T08:00:00Z";
const EARLIER = "2026-11-08T08:00:00Z";

const permissionsContext = {
  tenant_id: TENANT,
  actor_type: "agent",
  actor_id: "discovery-agent",
  roles: ["agent"],
  scopes: ["findings:write"],
  cross_tenant_content_authorized: false
};

const envelope = {
  tenant_id: TENANT,
  source_ids: [ID_A],
  confidence: 0.8,
  generated_at: NOW,
  review_status: "unreviewed",
  permissions_context: permissionsContext,
  agent_id: "discovery-agent",
  run_id: ID_B,
  skill_version: "1.2.0",
  uncertainties: ["Sample size is small"]
};

const sourceRef = {
  source_id: ID_A,
  system: "rentman",
  locator: "projects/123",
  retrieved_at: NOW,
  checksum: "sha256:abc"
};

const money = { amount: 12000, currency: "EUR", is_estimate: true as const };

const fixtures = {
  QuestionRequest: {
    question_id: ID_A,
    tenant_id: TENANT,
    department: "finance",
    recipient_role: "cfo",
    question_text: "How many days does it take to send an invoice after a project closes?",
    reason: "Needed to quantify the quote-to-cash cycle",
    evidence_gap: "No invoice timing data has been captured",
    priority: "high",
    answer_type: "number",
    source: sourceRef,
    status: "open",
    next_action: "Compare with Rentman invoice dates",
    confidence: 0.7,
    round_id: ID_B,
    depends_on: [],
    asked_by_agent_id: "discovery-agent",
    created_at: NOW
  },
  AnswerRecord: {
    question_id: ID_A,
    tenant_id: TENANT,
    answer: 14,
    answered_by_user_id: "user-1",
    answered_by_role: "cfo",
    answered_at: NOW,
    source: sourceRef,
    notes: "Rough estimate"
  },
  EvidenceRecord: {
    evidence_id: ID_A,
    tenant_id: TENANT,
    kind: "system_record",
    summary: "Invoice dates for the last 50 projects",
    source: sourceRef,
    captured_at: NOW,
    classification: "confidential",
    verification_status: "evidence_backed",
    checksum: "sha256:def",
    related_entity: [{ type: "process", id: ID_B }]
  },
  Finding: {
    ...envelope,
    finding_id: ID_C,
    title: "Invoices are sent late",
    description: "Median gap between project end and invoice is 14 days",
    department: "finance",
    process_id: ID_B,
    severity: "high",
    impact: { description: "Cash tied up for two extra weeks", estimated_annual_cost: money },
    urgency: "short_term",
    owner_role: "cfo",
    evidence_ids: [ID_A],
    claim_type: "data_observation",
    status: "open"
  },
  Opportunity: {
    ...envelope,
    opportunity_id: ID_C,
    title: "Automate invoice creation on project close",
    finding_ids: [ID_D],
    intervention_type: "automate",
    description: "Trigger invoice draft when a project reaches status closed",
    business_case: {
      effort: "m",
      dependencies: ["Rentman API access"],
      risks: ["Incorrect line items on edge cases"],
      estimated_cost: money,
      estimated_saving: money,
      expected_kpi_changes: [{ kpi_id: ID_A, direction: "down", magnitude: "10 days" }]
    },
    priority_score: { impact: 4, feasibility: 3, risk: 4, time_to_value: 4, composite: 3.75 },
    status: "proposed"
  },
  ApprovalRequest: {
    approval_id: ID_A,
    tenant_id: TENANT,
    subject: { type: "opportunity", id: ID_B },
    requested_by: { actor_type: "agent", actor_id: "planner-agent" },
    approver_role: "ceo",
    risk_level: "medium",
    summary: "Approve invoice automation pilot",
    rationale: "Saves two weeks of cash cycle per project",
    evidence_ids: [ID_C],
    blocking: true,
    status: "pending",
    expires_at: NOW,
    created_at: EARLIER
  },
  KpiDefinition: {
    kpi_id: ID_A,
    tenant_id: TENANT,
    name: "Days to invoice",
    business_question: "How fast do we invoice after delivery?",
    formula: "median(invoice_date - project_end_date)",
    unit: "days",
    source_system: "rentman",
    source_field: "invoices.date",
    owner_role: "cfo",
    filters: { status: "closed" },
    refresh_frequency: "daily",
    thresholds: { warning: 7, critical: 14, direction: "lower_is_better" },
    reliability: "medium",
    permission_scope: ["finance:read"],
    history_retention_days: 365,
    last_successful_sync_at: NOW,
    status: "active"
  },
  KpiObservation: {
    kpi_id: ID_A,
    tenant_id: TENANT,
    observed_at: NOW,
    period_start: EARLIER,
    period_end: NOW,
    value: 12.5,
    status: "ok",
    source: sourceRef,
    computed_by: { actor_type: "system", actor_id: "kpi-engine" },
    lineage: { query_or_formula: "select median(...)", source_record_ids: ["inv-1", "inv-2"] }
  },
  DashboardSpecification: {
    dashboard_id: ID_A,
    tenant_id: TENANT,
    audience_role: "cfo",
    title: "Finance overview",
    widgets: [
      { widget_id: ID_B, type: "kpi_tile", kpi_ids: [ID_C], priority: 1, reason: "Primary cash KPI", size: "s" },
      {
        widget_id: ID_C,
        type: "trend_line",
        kpi_ids: [ID_C],
        priority: 2,
        reason: "Shows improvement over time",
        size: "l",
        config: { months: 6, show_target: true, label: "Days to invoice" }
      }
    ],
    generated_by: "dashboard-agent",
    version: 1,
    review_status: "unreviewed"
  },
  ExecutiveBriefing: {
    ...envelope,
    briefing_id: ID_C,
    briefing_date: "2026-11-09",
    sections: {
      what_changed: [{ text: "Invoice lag dropped to 12 days", source_ids: [ID_A], confidence: 0.9 }],
      what_matters_today: [],
      decisions_needed: [{ text: "Approve automation pilot", source_ids: [], confidence: 0.6 }],
      tasks_delegated: [],
      risks: [],
      opportunities: [],
      data_gaps: [{ text: "No purchase order data yet", source_ids: [], confidence: 0.5 }],
      impact_of_prior_improvements: []
    },
    top_priorities: ["Approve automation pilot", "Close purchase order data gap"]
  },
  UpgradeProposal: {
    ...envelope,
    upgrade_id: ID_C,
    kind: "code_update",
    subject: "zod",
    current_version: "4.6.7",
    proposed_version: "4.7.0",
    source_url: "https://github.com/colinhacks/zod/releases",
    published_at: EARLIER,
    detected_at: NOW,
    relevant_agent_ids: ["discovery-agent"],
    potential_benefit: "Faster parsing",
    compatibility_notes: "No breaking changes listed",
    security_risk: "none",
    migration_plan: "Bump version, run tests",
    test_result: "All tests pass",
    rollback_plan: "Revert lockfile",
    status: "assessed"
  },
  AgentRunResult: {
    ...envelope,
    run_id: ID_B,
    agent_id: "discovery-agent",
    task_id: ID_C,
    status: "succeeded",
    started_at: EARLIER,
    finished_at: NOW,
    summary: "Produced two findings",
    outputs: [{ contract: "Finding", ref_id: ID_D }],
    tools_used: ["rentman.list_invoices"],
    token_usage: { input: 1200, output: 400, cost_usd: 0.02 },
    checkpoints: [{ checkpoint_id: ID_A, at: EARLIER, note: "Data loaded" }],
    help_requests: [
      {
        kind: "missing_data",
        message: "Purchase orders are not exported",
        owner_role: "coo",
        urgency: "medium",
        deadline: NOW
      }
    ]
  },
  VaultDocument: {
    document_id: ID_A,
    vault_scope: "client",
    tenant_id: TENANT,
    path: "04_processes_as_is/quote-to-cash.md",
    title: "Quote to cash (as is)",
    frontmatter: { owner: "cfo", tags: ["finance"] },
    body_markdown: "# Quote to cash\n\nText.",
    tags: ["finance", "process"],
    links_out: ["02_systems/rentman.md"],
    classification: "confidential",
    verification_status: "evidence_backed",
    version: 3,
    created_by: "user-1",
    updated_by: "discovery-agent",
    created_at: EARLIER,
    updated_at: NOW,
    checksum: "sha256:123"
  },
  KnowledgeFact: {
    fact_id: ID_A,
    vault_scope: "agency",
    tenant_id: null,
    statement: "Rentman exposes invoice dates through the invoices endpoint",
    subject_entity: { type: "system", id: ID_B },
    source_ids: [ID_C],
    origin_system: "rentman_docs",
    observed_at: NOW,
    responsible_role: "consultant",
    verification_status: "verified",
    confidence: 0.95,
    classification: "internal",
    version: 1,
    access_policy: ["consultant"],
    contradicts: []
  },
  FactVerificationRequest: {
    request_id: ID_A,
    tenant_id: TENANT,
    fact_id: ID_B,
    conflicting_fact_ids: [ID_C],
    raised_by: { actor_type: "agent", actor_id: "knowledge-agent" },
    reason: "Client statement conflicts with system data",
    evidence_ids: [ID_D],
    requested_reviewer_role: "consultant",
    status: "verified",
    resolution: { decided_by: "user-2", decided_at: NOW, outcome: "verified", note: "System data wins" }
  },
  AgentFeedback: {
    feedback_id: ID_A,
    tenant_id: TENANT,
    run_id: ID_B,
    agent_id: "discovery-agent",
    given_by_user_id: "user-1",
    kind: "correction",
    message: "The department is operations, not finance",
    applies_to_output_ref: { contract: "Finding", ref_id: ID_C },
    should_update_skill: true,
    created_at: NOW
  },
  MissionControlSummary: {
    generated_at: NOW,
    scope: "all_clients",
    agents: [
      {
        agent_id: "discovery-agent",
        tenant_id: TENANT,
        name: "Discovery",
        state: "running",
        current_task_id: ID_A,
        department: "finance",
        priority: "high",
        last_run_at: EARLIER,
        next_scheduled_run_at: NOW
      }
    ],
    counters: {
      runs_succeeded_24h: 12,
      runs_failed_24h: 1,
      retries_24h: 2,
      approvals_pending: 3,
      tasks_without_owner: 0,
      schedules_missed: 0,
      incidents_open: 1
    },
    budget: { spent_usd_mtd: 42.5, cap_usd: 500 },
    content_masked: true
  }
} as const satisfies Record<(typeof contractNames)[number], unknown>;

const schemas: Record<(typeof contractNames)[number], z.ZodType> = {
  QuestionRequest: QuestionRequestSchema,
  AnswerRecord: AnswerRecordSchema,
  EvidenceRecord: EvidenceRecordSchema,
  Finding: FindingSchema,
  Opportunity: OpportunitySchema,
  ApprovalRequest: ApprovalRequestSchema,
  KpiDefinition: KpiDefinitionSchema,
  KpiObservation: KpiObservationSchema,
  DashboardSpecification: DashboardSpecificationSchema,
  ExecutiveBriefing: ExecutiveBriefingSchema,
  UpgradeProposal: UpgradeProposalSchema,
  AgentRunResult: AgentRunResultSchema,
  VaultDocument: VaultDocumentSchema,
  KnowledgeFact: KnowledgeFactSchema,
  FactVerificationRequest: FactVerificationRequestSchema,
  AgentFeedback: AgentFeedbackSchema,
  MissionControlSummary: MissionControlSummarySchema
};

function issues(result: z.ZodSafeParseResult<unknown>): string {
  return result.success ? "" : JSON.stringify(result.error.issues, null, 2);
}

describe("valid fixtures", () => {
  for (const name of contractNames) {
    it(`${name} parses`, () => {
      const result = schemas[name].safeParse(fixtures[name]);
      expect(result.success, issues(result)).toBe(true);
    });
  }
});

describe("defaults", () => {
  it("AnswerRecord defaults verification_status to unconfirmed", () => {
    const parsed = AnswerRecordSchema.parse(fixtures.AnswerRecord);
    expect(parsed.verification_status).toBe("unconfirmed");
  });

  it("DashboardSpecification defaults locale to en", () => {
    const parsed = DashboardSpecificationSchema.parse(fixtures.DashboardSpecification);
    expect(parsed.locale).toBe("en");
  });

  it("Opportunity defaults requires_approval to true", () => {
    const parsed = OpportunitySchema.parse(fixtures.Opportunity);
    expect(parsed.requires_approval).toBe(true);
  });
});

describe("invalid cases", () => {
  it("rejects KpiObservation with status missing_data and a numeric value", () => {
    const result = KpiObservationSchema.safeParse({ ...fixtures.KpiObservation, status: "missing_data", value: 3 });
    expect(result.success).toBe(false);
  });

  it("accepts KpiObservation with status missing_data and null value", () => {
    const result = KpiObservationSchema.safeParse({ ...fixtures.KpiObservation, status: "missing_data", value: null });
    expect(result.success, issues(result)).toBe(true);
  });

  it("rejects KpiObservation with status ok and null value", () => {
    const result = KpiObservationSchema.safeParse({ ...fixtures.KpiObservation, value: null });
    expect(result.success).toBe(false);
  });

  it("rejects DashboardSpecification with a widget type outside the whitelist", () => {
    const widget = { ...fixtures.DashboardSpecification.widgets[0], type: "iframe" };
    const result = DashboardSpecificationSchema.safeParse({ ...fixtures.DashboardSpecification, widgets: [widget] });
    expect(result.success).toBe(false);
  });

  it("rejects DashboardSpecification with duplicate widget ids", () => {
    const widget = fixtures.DashboardSpecification.widgets[0];
    const result = DashboardSpecificationSchema.safeParse({
      ...fixtures.DashboardSpecification,
      widgets: [widget, { ...widget, type: "table" }]
    });
    expect(result.success).toBe(false);
  });

  it("rejects ExecutiveBriefing with 8 top priorities", () => {
    const result = ExecutiveBriefingSchema.safeParse({
      ...fixtures.ExecutiveBriefing,
      top_priorities: ["1", "2", "3", "4", "5", "6", "7", "8"]
    });
    expect(result.success).toBe(false);
  });

  it("rejects ExecutiveBriefing with no top priorities", () => {
    const result = ExecutiveBriefingSchema.safeParse({ ...fixtures.ExecutiveBriefing, top_priorities: [] });
    expect(result.success).toBe(false);
  });

  it("rejects VaultDocument with vault_scope client and null tenant_id", () => {
    const result = VaultDocumentSchema.safeParse({ ...fixtures.VaultDocument, tenant_id: null });
    expect(result.success).toBe(false);
  });

  it("accepts VaultDocument with vault_scope agency and null tenant_id", () => {
    const result = VaultDocumentSchema.safeParse({ ...fixtures.VaultDocument, vault_scope: "agency", tenant_id: null });
    expect(result.success, issues(result)).toBe(true);
  });

  it("rejects KnowledgeFact with vault_scope client and null tenant_id", () => {
    const result = KnowledgeFactSchema.safeParse({ ...fixtures.KnowledgeFact, vault_scope: "client" });
    expect(result.success).toBe(false);
  });

  it("rejects Finding missing tenant_id", () => {
    const { tenant_id: _omitted, ...withoutTenant } = fixtures.Finding;
    const result = FindingSchema.safeParse(withoutTenant);
    expect(result.success).toBe(false);
  });

  it("rejects an envelope confidence above 1", () => {
    const result = FindingSchema.safeParse({ ...fixtures.Finding, confidence: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects a MoneyEstimate with is_estimate false", () => {
    const result = FindingSchema.safeParse({
      ...fixtures.Finding,
      impact: { description: "x", estimated_annual_cost: { ...money, is_estimate: false } }
    });
    expect(result.success).toBe(false);
  });
});

describe("package metadata", () => {
  it("exports a semver CONTRACTS_VERSION", () => {
    expect(CONTRACTS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("toJsonSchemas returns one JSON Schema per contract (17)", () => {
    const schemasJson = toJsonSchemas();
    const keys = Object.keys(schemasJson);
    expect(keys).toHaveLength(17);
    expect(keys.sort()).toEqual([...contractNames].sort());
    for (const key of keys) {
      const doc = schemasJson[key as (typeof contractNames)[number]];
      expect(doc.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(doc.type).toBe("object");
    }
  });
});
