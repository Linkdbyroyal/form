import { describe, expect, it } from "vitest";
import { DATA_CLASSES, RETENTION_MINIMUM_DAYS } from "@sbos/core";
import {
  allowedUpgradeTransitions,
  artefactRequirement,
  deletionDecisionsFor,
  executionNote,
  isAllowedUpgradeTransition,
  isGithubPullRequestUrl,
  isHttpsUrl,
  isReviewer,
  isSourceKey,
  isValidCheckInterval,
  missingAssessmentFields,
  parseAgentKeys,
  retentionFloor,
  securityRiskTone,
  subjectRefHelp,
  summaryRows,
  upgradeActionsFor,
  upgradeActionsForRoles,
  upgradeStatusTone,
  deletionStateTone,
  validateRetentionDays,
  watchRunTone
} from "../lib/mission-control/governance-helpers";

/**
 * Milestone 6 governance UI rules (Tech Watch, Upgrade Center, retention, deletion requests). Pure functions only;
 * the database-backed flows are covered by packages/core/test/governance.test.ts and the page checks in the handoff.
 */

describe("upgrade lifecycle mirrors enforce_upgrade_transition", () => {
  it("lists exactly the trigger's transitions per status", () => {
    expect(allowedUpgradeTransitions("detected")).toEqual(["assessed", "rejected"]);
    expect(allowedUpgradeTransitions("assessed")).toEqual(["approved", "rejected", "detected"]);
    expect(allowedUpgradeTransitions("approved")).toEqual(["applied", "rejected"]);
    expect(allowedUpgradeTransitions("applied")).toEqual(["rolled_back"]);
    expect(allowedUpgradeTransitions("rejected")).toEqual([]);
    expect(allowedUpgradeTransitions("rolled_back")).toEqual([]);
    expect(isAllowedUpgradeTransition("detected", "approved")).toBe(false);
    expect(isAllowedUpgradeTransition("detected", "applied")).toBe(false);
    expect(isAllowedUpgradeTransition("approved", "applied")).toBe(true);
    expect(isAllowedUpgradeTransition("rolled_back", "approved")).toBe(false);
  });
  it("offers assess to everyone and approve, reject, apply, rollback to reviewers only", () => {
    expect(upgradeActionsFor("detected").map((a) => a.action)).toEqual(["assess", "reject"]);
    expect(upgradeActionsFor("assessed").map((a) => a.action)).toEqual(["approve", "reject", "assess"]);
    expect(upgradeActionsFor("approved").map((a) => a.action)).toEqual(["apply", "reject"]);
    expect(upgradeActionsFor("applied").map((a) => a.action)).toEqual(["rollback"]);
    expect(upgradeActionsFor("rejected")).toEqual([]);
    expect(upgradeActionsFor("rolled_back")).toEqual([]);
    for (const a of upgradeActionsFor("assessed")) expect(a.reviewerOnly).toBe(a.action !== "assess");
    expect(upgradeActionsForRoles("assessed", ["agency_consultant"]).map((a) => a.action)).toEqual(["assess"]);
    expect(upgradeActionsForRoles("assessed", ["agency_reviewer"]).map((a) => a.action)).toEqual(["approve", "reject", "assess"]);
    expect(upgradeActionsForRoles("applied", ["agency_operator"])).toEqual([]);
    expect(upgradeActionsForRoles("applied", ["superadmin"]).map((a) => a.action)).toEqual(["rollback"]);
    expect(isReviewer(["agency_operator"])).toBe(false);
    expect(isReviewer(["agency_reviewer"])).toBe(true);
  });
  it("names the artefact the approval trigger demands per kind", () => {
    expect(artefactRequirement("code_update")?.field).toBe("pullRequestUrl");
    expect(artefactRequirement("code_update")?.rule).toMatch(/only with a pull request/);
    expect(artefactRequirement("skill_update")?.field).toBe("skillVersionId");
    expect(artefactRequirement("skill_update")?.applyEffect).toMatch(/never re-pinned/);
    expect(artefactRequirement("knowledge_update")?.field).toBe("knowledgeRecordId");
    expect(artefactRequirement("other")).toBeNull();
  });
  it("reports the assessment fields the trigger requires", () => {
    expect(missingAssessmentFields({})).toEqual(["kind", "security risk", "potential benefit", "compatibility notes", "migration plan", "rollback plan"]);
    expect(missingAssessmentFields({ kind: "code_update", securityRisk: "low", potentialBenefit: "x", compatibilityNotes: "y", migrationPlan: "z", rollbackPlan: " " })).toEqual(["rollback plan"]);
  });
  it("tones follow the status", () => {
    expect(upgradeStatusTone("applied")).toBe("success");
    expect(upgradeStatusTone("rejected")).toBe("danger");
    expect(upgradeStatusTone("rolled_back")).toBe("warning");
    expect(upgradeStatusTone("unknown")).toBe("neutral");
    expect(securityRiskTone("critical")).toBe("danger");
    expect(securityRiskTone(null)).toBe("neutral");
    expect(watchRunTone("failed")).toBe("danger");
    expect(deletionStateTone("completed")).toBe("success");
  });
});

describe("source and assessment input validation", () => {
  it("parses agent key lists and refuses impossible keys", () => {
    expect(parseAgentKeys("worker, Process-Redesign\nfinance-agent worker")).toEqual(["worker", "process-redesign", "finance-agent"]);
    expect(parseAgentKeys("")).toEqual([]);
    expect(() => parseAgentKeys("bad key!")).toThrow(/agent key/);
  });
  it("validates source keys, https urls, pull request urls and intervals", () => {
    expect(isSourceKey("pg-boss-releases")).toBe(true);
    expect(isSourceKey("Bad_Key")).toBe(false);
    expect(isSourceKey("a")).toBe(false);
    expect(isHttpsUrl("https://github.com/timgit/pg-boss/releases")).toBe(true);
    expect(isHttpsUrl("http://example.com")).toBe(false);
    expect(isHttpsUrl("not a url")).toBe(false);
    expect(isGithubPullRequestUrl("https://github.com/Linkdbyroyal/form/pull/12")).toBe(true);
    expect(isGithubPullRequestUrl("https://github.com/Linkdbyroyal/form/releases")).toBe(false);
    expect(isGithubPullRequestUrl("https://gitlab.com/x/y/pull/1")).toBe(false);
    expect(isValidCheckInterval(24)).toBe(true);
    expect(isValidCheckInterval(0)).toBe(false);
    expect(isValidCheckInterval(721)).toBe(false);
    expect(isValidCheckInterval(1.5)).toBe(false);
  });
});

describe("retention floors", () => {
  it("refuses values below the database floor per data class and above the maximum", () => {
    for (const dc of DATA_CLASSES) {
      expect(retentionFloor(dc)).toBe(RETENTION_MINIMUM_DAYS[dc]);
      expect(validateRetentionDays(dc, RETENTION_MINIMUM_DAYS[dc])).toBeNull();
      expect(validateRetentionDays(dc, RETENTION_MINIMUM_DAYS[dc] - 1)).toMatch(/at least/);
    }
    expect(validateRetentionDays("knowledge_access_logs", 30)).toMatch(/at least 365 days/);
    expect(validateRetentionDays("run_events", 3651)).toMatch(/cannot exceed 3650/);
    expect(validateRetentionDays("run_events", 60.5)).toMatch(/whole number/);
    expect(validateRetentionDays("nope", 100)).toMatch(/unknown data class/);
    expect(retentionFloor("nope")).toBeNull();
  });
});

describe("deletion requests", () => {
  it("mirrors enforce_deletion_request for the decisions still open", () => {
    expect(deletionDecisionsFor("requested")).toEqual(["approved", "rejected"]);
    expect(deletionDecisionsFor("approved")).toEqual(["rejected"]);
    expect(deletionDecisionsFor("executing")).toEqual([]);
    expect(deletionDecisionsFor("completed")).toEqual([]);
    expect(deletionDecisionsFor("rejected")).toEqual([]);
  });
  it("gives help text per kind and states who executes", () => {
    expect(subjectRefHelp("document")).toMatch(/path/);
    expect(subjectRefHelp("connection_data")).toMatch(/connection/);
    expect(subjectRefHelp("subject_data")).toMatch(/runbook/);
    expect(subjectRefHelp("tenant_offboarding")).toMatch(/slug/);
    expect(executionNote("document", "approved")).toMatch(/Sundays 03:00 UTC/);
    expect(executionNote("subject_data", "approved")).toMatch(/manual completion/);
    expect(executionNote("document", "completed")).toMatch(/worker/);
    expect(executionNote("tenant_offboarding", "completed")).toMatch(/superadmin/);
    expect(executionNote("document", "requested")).toMatch(/reviewer/);
  });
  it("renders the summary jsonb as rows", () => {
    expect(summaryRows({ vault_documents: 1, vault_revisions: 3 })).toEqual([{ key: "vault_documents", value: "1" }, { key: "vault_revisions", value: "3" }]);
    expect(summaryRows({ manual: true, note: "two facts corrected" })).toEqual([{ key: "manual", value: "yes" }, { key: "note", value: "two facts corrected" }]);
    expect(summaryRows({})).toEqual([]);
    expect(summaryRows(null)).toEqual([]);
    expect(summaryRows([1])).toEqual([]);
  });
});
