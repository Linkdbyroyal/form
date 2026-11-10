import { describe, expect, it } from "vitest";
import { DESCRIPTORS } from "@sbos/connectors";
import {
  agencyActionsFor,
  clientActionsFor,
  connectionStatusTone,
  consentTone,
  describeScopes,
  fmtInterval,
  fmtSyncDuration,
  isOverdue,
  isValidPathToken,
  isValidSecretRef,
  isValidSyncInterval,
  kpiSourceNames,
  nextPhase,
  pathTokenFromUuids,
  PHASE_EXPLANATIONS,
  PHASES,
  phaseRank,
  phaseTone,
  readSummary,
  scopesForPhase,
  suggestProvider,
  syncHealth,
  syncStatusTone
} from "../lib/client/integration-helpers";

/**
 * Milestone 5 Integration UI rules. Pure functions only; the database-backed flows (trigger refusals, consent, sync
 * runs, lineage, isolation) are covered by packages/connectors/test/integrations.test.ts and the worker demo flow.
 */

const base = { phase: "metadata", status: "proposed", consent: "pending", securityReviewedAt: null, lastSyncAt: null, syncIntervalMinutes: 60 };

describe("phase order", () => {
  it("ranks the four phases in the trigger's order and offers only the next step, never write", () => {
    expect(PHASES).toEqual(["metadata", "read_only", "sandbox", "write"]);
    expect(PHASES.map(phaseRank)).toEqual([0, 1, 2, 3]);
    expect(phaseRank("nope")).toBe(-1);
    expect(nextPhase("metadata")).toBe("read_only");
    expect(nextPhase("read_only")).toBe("sandbox");
    expect(nextPhase("sandbox")).toBeNull();
    expect(nextPhase("write")).toBeNull();
    expect(nextPhase("unknown")).toBeNull();
  });

  it("has a plain-language explanation for every phase and marks write as refused", () => {
    for (const p of PHASES) expect(PHASE_EXPLANATIONS[p].text.length).toBeGreaterThan(40);
    expect(PHASE_EXPLANATIONS.write.text).toMatch(/refuses/);
    expect(PHASE_EXPLANATIONS.metadata.text).toMatch(/Nothing is read/);
  });
});

describe("badge tones", () => {
  it("maps phases, statuses, consent and sync statuses to tones", () => {
    expect(phaseTone("metadata")).toBe("neutral");
    expect(phaseTone("read_only")).toBe("cyan");
    expect(phaseTone("write")).toBe("danger");
    expect(connectionStatusTone("active")).toBe("success");
    expect(connectionStatusTone("error")).toBe("danger");
    expect(connectionStatusTone("paused")).toBe("warning");
    expect(consentTone("granted")).toBe("success");
    expect(consentTone("revoked")).toBe("danger");
    expect(consentTone("pending")).toBe("warning");
    expect(syncStatusTone("failed")).toBe("danger");
    expect(syncStatusTone("skipped")).toBe("neutral");
  });
});

describe("scope rendering from descriptors", () => {
  it("lists read-only scopes with gloss and glosses granted scopes the descriptor knows", () => {
    const rentman = scopesForPhase(DESCRIPTORS.rentman, "read_only");
    expect(rentman.map((s) => s.scope)).toEqual(["projects:read", "invoices:read"]);
    expect(rentman.every((s) => s.gloss && s.gloss.length > 10)).toBe(true);
    expect(scopesForPhase(DESCRIPTORS.rentman, "write")).toEqual([]);
    const granted = describeScopes(DESCRIPTORS.rentman, ["projects:read", "custom:scope"]);
    expect(granted[0]!.gloss).toMatch(/project names/);
    expect(granted[1]!.gloss).toBeNull();
    expect(describeScopes(null, ["x"])).toEqual([{ scope: "x", gloss: null }]);
  });

  it("summarises what each object kind reads and what is never read", () => {
    const summary = readSummary(DESCRIPTORS.trengo);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.kind).toBe("tickets");
    expect(summary[0]!.fields).toContain("status");
    expect(summary[0]!.excluded).toMatch(/message bodies/);
    const rentmanInvoices = readSummary(DESCRIPTORS.rentman)[1]!;
    expect(rentmanInvoices.excluded).toBe("nothing else is read");
  });

  it("suggests the provider for a registered system by name or vendor", () => {
    const all = Object.values(DESCRIPTORS);
    expect(suggestProvider({ name: "QuickBooks Online", vendor: "Intuit" }, all)).toBe("quickbooks");
    expect(suggestProvider({ name: "Accounting package", vendor: "Intuit" }, all)).toBe("quickbooks");
    expect(suggestProvider({ name: "Property Management System", vendor: "Unknown (to verify)" }, all)).toBeNull();
  });

  it("names the source systems a KPI may carry for a connection", () => {
    expect(kpiSourceNames("QuickBooks Online", DESCRIPTORS.quickbooks, "quickbooks").sort()).toEqual(["QuickBooks Online", "quickbooks"]);
    expect(kpiSourceNames("Finance tool", DESCRIPTORS.quickbooks, "quickbooks").sort()).toEqual(["Finance tool", "QuickBooks Online", "quickbooks"]);
    expect(kpiSourceNames(null, null, "custom")).toEqual(["custom"]);
  });
});

describe("secret reference and path token validation", () => {
  it("accepts env:NAME references only and never a value", () => {
    expect(isValidSecretRef("env:RENTMAN_API_TOKEN")).toBe(true);
    expect(isValidSecretRef("env:QUICKBOOKS_REALM_ID_2")).toBe(true);
    expect(isValidSecretRef("env:lowercase")).toBe(false);
    expect(isValidSecretRef("env:1STARTS_WITH_DIGIT")).toBe(false);
    expect(isValidSecretRef("sk-live-1234567890abcdef")).toBe(false);
    expect(isValidSecretRef("RENTMAN_API_TOKEN")).toBe(false);
    expect(isValidSecretRef("env:AB")).toBe(false);
    expect(isValidSecretRef(`env:${"A".repeat(81)}`)).toBe(true);
    expect(isValidSecretRef(`env:${"A".repeat(82)}`)).toBe(false);
  });

  it("derives a 32 character url-safe path token from two UUIDs", () => {
    const token = pathTokenFromUuids("3b241101-e2bb-4255-8caf-4136c566a962", "9dc040dc-697e-456a-b090-bfe0d35ed55c");
    expect(token).toBe("3b241101e2bb42558caf4136c566a962");
    expect(token).toHaveLength(32);
    expect(isValidPathToken(token)).toBe(true);
    expect(isValidPathToken("short")).toBe(false);
    expect(isValidPathToken("has space in it 1234567890")).toBe(false);
    expect(() => pathTokenFromUuids("not-a-uuid", "nope")).toThrow(/two UUIDs/);
  });

  it("bounds the sync interval like the CHECK constraint (5 to 1440 minutes)", () => {
    expect(isValidSyncInterval(5)).toBe(true);
    expect(isValidSyncInterval(1440)).toBe(true);
    expect(isValidSyncInterval(4)).toBe(false);
    expect(isValidSyncInterval(1441)).toBe(false);
    expect(isValidSyncInterval(7.5)).toBe(false);
    expect(fmtInterval(30)).toBe("30 min");
    expect(fmtInterval(120)).toBe("2 h");
    expect(fmtInterval(1440)).toBe("1 d");
  });
});

describe("durations and health", () => {
  it("formats a sync run duration and reports running runs", () => {
    expect(fmtSyncDuration("2026-11-09T12:00:00Z", null)).toBe("running");
    expect(fmtSyncDuration("2026-11-09T12:00:00.000Z", "2026-11-09T12:00:00.250Z")).toBe("250 ms");
    expect(fmtSyncDuration("2026-11-09T12:00:00Z", "2026-11-09T12:00:04.500Z")).toBe("4.5 s");
    expect(fmtSyncDuration("2026-11-09T12:00:00Z", "2026-11-09T12:03:10Z")).toBe("3 min");
    expect(fmtSyncDuration("2026-11-09T12:00:00Z", "2026-11-09T11:00:00Z")).toBe("n/a");
  });

  it("flags overdue syncs after two missed intervals, only for active reading connections", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    const active = { ...base, phase: "read_only", status: "active", consent: "granted", syncIntervalMinutes: 30 };
    expect(isOverdue({ ...active, lastSyncAt: new Date("2026-11-09T11:30:00Z") }, now)).toBe(false);
    expect(isOverdue({ ...active, lastSyncAt: new Date("2026-11-09T10:00:00Z") }, now)).toBe(true);
    expect(isOverdue({ ...active, status: "paused", lastSyncAt: new Date("2026-11-09T10:00:00Z") }, now)).toBe(false);
    expect(isOverdue({ ...active, phase: "metadata", lastSyncAt: new Date("2026-11-09T10:00:00Z") }, now)).toBe(false);
    expect(isOverdue({ ...active, lastSyncAt: null }, now)).toBe(false);
  });

  it("counts sync health across connections", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    const h = syncHealth(
      [
        { ...base },
        { ...base, consent: "granted", status: "consent_pending" },
        { ...base, phase: "read_only", status: "active", consent: "granted", securityReviewedAt: now, lastSyncAt: null },
        { ...base, phase: "read_only", status: "active", consent: "granted", securityReviewedAt: now, lastSyncAt: new Date("2026-11-09T09:00:00Z") },
        { ...base, phase: "metadata", status: "paused", consent: "revoked" },
        { ...base, phase: "read_only", status: "error", consent: "granted", securityReviewedAt: now, lastSyncAt: now }
      ],
      now
    );
    expect(h).toEqual({ total: 6, active: 2, paused: 1, error: 1, awaitingConsent: 1, awaitingReview: 1, neverSynced: 1, overdue: 1 });
  });
});

describe("actions offered", () => {
  it("offers the client admin grant before consent and revoke after, nothing to others", () => {
    expect(clientActionsFor({ consent: "pending" }, true)).toEqual({ grantConsent: true, revokeConsent: false });
    expect(clientActionsFor({ consent: "granted" }, true)).toEqual({ grantConsent: false, revokeConsent: true });
    expect(clientActionsFor({ consent: "revoked" }, true)).toEqual({ grantConsent: true, revokeConsent: false });
    expect(clientActionsFor({ consent: "pending" }, false)).toEqual({ grantConsent: false, revokeConsent: false });
  });

  it("mirrors the trigger for agency actions: consent, then review, then one step; never write", () => {
    const proposed = agencyActionsFor({ ...base });
    expect(proposed.review).toBe(false);
    expect(proposed.advanceTo).toBeNull();
    expect(proposed.advanceBlockedBy).toMatch(/consent granted by the client admin/);
    expect(proposed.runSync).toBe(false);
    expect(proposed.testConnection).toBe(false);

    const consented = agencyActionsFor({ ...base, consent: "granted", status: "consent_pending" });
    expect(consented.review).toBe(true);
    expect(consented.advanceTo).toBeNull();
    expect(consented.advanceBlockedBy).toMatch(/security review/);

    const reviewed = agencyActionsFor({ ...base, consent: "granted", status: "consent_pending", securityReviewedAt: new Date() });
    expect(reviewed.advanceTo).toBe("read_only");
    expect(reviewed.pause).toBe(false);
    expect(reviewed.resume).toBe(false);

    const active = agencyActionsFor({ ...base, phase: "read_only", status: "active", consent: "granted", securityReviewedAt: new Date() });
    expect(active.advanceTo).toBe("sandbox");
    expect(active.pause).toBe(true);
    expect(active.runSync).toBe(true);
    expect(active.testConnection).toBe(true);

    const paused = agencyActionsFor({ ...base, phase: "read_only", status: "paused", consent: "granted", securityReviewedAt: new Date() });
    expect(paused.resume).toBe(true);
    expect(paused.runSync).toBe(false);
    expect(paused.testConnection).toBe(true);

    const sandbox = agencyActionsFor({ ...base, phase: "sandbox", status: "active", consent: "granted", securityReviewedAt: new Date() });
    expect(sandbox.advanceTo).toBeNull();
    expect(sandbox.advanceBlockedBy).toMatch(/write phase has no implementation/);

    const revoked = agencyActionsFor({ ...base, phase: "metadata", status: "paused", consent: "revoked" });
    expect(revoked.resume).toBe(false);
    expect(revoked.review).toBe(false);
  });
});
