import type { ConnectorDescriptor } from "@sbos/connectors";
import type { Tone } from "@/components/ui";

/**
 * Pure helpers for the Integration Center and the Connected Tools pages (Milestone 5, ADR-011/021). No I/O.
 * The database trigger `enforce_connection_phase` is the gate; these helpers only decide what the UI offers and
 * how it is rendered. The rules here mirror the trigger: one step at a time, consent before read_only, a recorded
 * security review before read_only, and no write phase in this release.
 */
export const PHASES = ["metadata", "read_only", "sandbox", "write"] as const;
export type Phase = (typeof PHASES)[number];
export type ConnectionStatus = "proposed" | "consent_pending" | "active" | "paused" | "revoked" | "error";
export type Consent = "pending" | "granted" | "revoked";
export type SyncRunStatus = "running" | "succeeded" | "failed" | "skipped";

export const CREDENTIAL_KINDS = ["api_key", "oauth_refresh_token", "basic"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export const SYNC_INTERVAL_MIN = 5;
export const SYNC_INTERVAL_MAX = 1440;

/** Same rule as `registerCredentialReference` in @sbos/core: a reference into the worker's environment, never a value. */
export const SECRET_REF_RE = /^env:[A-Z][A-Z0-9_]{2,80}$/;
/** Same rule as `registerWebhookEndpoint` in @sbos/core. */
export const PATH_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function phaseRank(phase: string): number {
  const i = (PHASES as readonly string[]).indexOf(phase);
  return i < 0 ? -1 : i;
}

export function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

/**
 * The only phase the UI offers to advance to: the next one, and never `write` (the database refuses it in this
 * release). Returns null when nothing can be offered.
 */
export function nextPhase(phase: string): Phase | null {
  const rank = phaseRank(phase);
  if (rank < 0) return null;
  const next = PHASES[rank + 1];
  if (!next || next === "write") return null;
  return next;
}

export function phaseLabel(phase: string): string {
  return phase.replaceAll("_", " ");
}

export function phaseTone(phase: string): Tone {
  switch (phase) {
    case "metadata": return "neutral";
    case "read_only": return "cyan";
    case "sandbox": return "warning";
    case "write": return "danger";
    default: return "neutral";
  }
}

export function connectionStatusTone(status: string): Tone {
  switch (status) {
    case "active": return "success";
    case "consent_pending": return "warning";
    case "paused": return "warning";
    case "error": return "danger";
    case "revoked": return "danger";
    default: return "neutral";
  }
}

export function consentTone(consent: string): Tone {
  switch (consent) {
    case "granted": return "success";
    case "revoked": return "danger";
    default: return "warning";
  }
}

export function syncStatusTone(status: string): Tone {
  switch (status) {
    case "running": return "cyan";
    case "succeeded": return "success";
    case "failed": return "danger";
    default: return "neutral";
  }
}

export function reviewOutcomeTone(outcome: string | null): Tone {
  if (outcome === "approved") return "success";
  if (outcome === "rejected") return "danger";
  return "neutral";
}

export function phaseChangeKindTone(kind: string): Tone {
  switch (kind) {
    case "consent_granted": return "success";
    case "phase_advanced": return "cyan";
    case "security_review": return "indigo";
    case "consent_revoked": return "danger";
    case "paused": return "warning";
    case "resumed": return "success";
    default: return "neutral";
  }
}

export function kpiStatusTone(status: string): Tone {
  switch (status) {
    case "active": return "success";
    case "stale": return "warning";
    case "missing_source": return "danger";
    case "draft": return "neutral";
    default: return "neutral";
  }
}

/** Plain-language explanation of each phase for clients. */
export const PHASE_EXPLANATIONS: Record<Phase, { title: string; text: string }> = {
  metadata: { title: "Metadata", text: "Nothing is read. Only the system's name, its function and the fields we would read are recorded. No credentials exist yet and no network call is made." },
  read_only: { title: "Read-only", text: "After your consent and the agency's security review, the worker reads only the listed fields of the listed objects, on the agreed interval. Nothing is written back and nothing outside the listed fields is read." },
  sandbox: { title: "Sandbox", text: "The same read-only scopes against a vendor test account, used to rehearse a connector before live data. In this release every sandbox sync uses synthetic fixtures and is labelled simulated." },
  write: { title: "Write", text: "Writing back to a system. This phase has no implementation in this release and the database refuses it." }
};

export interface ScopeView {
  scope: string;
  gloss: string | null;
}

/** Scopes requested for a phase, with the plain-language gloss from the descriptor. */
export function scopesForPhase(descriptor: ConnectorDescriptor, phase: Phase): ScopeView[] {
  if (phase === "write") return [];
  return descriptor.scopes[phase].map((s) => ({ scope: s.scope, gloss: s.gloss }));
}

/** Renders granted scopes with the gloss when the descriptor knows the scope (the read-only phase vocabulary). */
export function describeScopes(descriptor: ConnectorDescriptor | null, scopes: readonly string[]): ScopeView[] {
  const known = new Map<string, string>();
  if (descriptor) {
    for (const phase of ["read_only", "sandbox", "metadata"] as const) {
      for (const s of descriptor.scopes[phase]) if (!known.has(s.scope)) known.set(s.scope, s.gloss);
    }
  }
  return scopes.map((scope) => ({ scope, gloss: known.get(scope) ?? null }));
}

/** One line per object kind: fields read and the stated exclusion. */
export function readSummary(descriptor: ConnectorDescriptor): Array<{ kind: string; fields: string; excluded: string }> {
  return descriptor.objects.map((o) => ({ kind: o.kind, fields: o.fields.join(", "), excluded: o.excluded ?? "nothing else is read" }));
}

/** Validation shared by the form (client-side pattern attribute) and the server action. */
export function isValidSecretRef(ref: string): boolean {
  return SECRET_REF_RE.test(ref);
}

export function isValidPathToken(token: string): boolean {
  return PATH_TOKEN_RE.test(token);
}

export function isValidSyncInterval(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= SYNC_INTERVAL_MIN && minutes <= SYNC_INTERVAL_MAX;
}

/** 32 url-safe characters from two UUIDs (the server passes `crypto.randomUUID()` twice). */
export function pathTokenFromUuids(a: string, b: string): string {
  const hex = `${a}${b}`.replaceAll("-", "");
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("path token needs two UUIDs");
  return hex.slice(0, 32);
}

/** Duration of a sync run; "running" while it has no end. */
export function fmtSyncDuration(startedAt: Date | string, finishedAt: Date | string | null): string {
  if (!finishedAt) return "running";
  const s = typeof startedAt === "string" ? new Date(startedAt) : startedAt;
  const f = typeof finishedAt === "string" ? new Date(finishedAt) : finishedAt;
  const ms = f.getTime() - s.getTime();
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export function fmtInterval(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

export interface ConnectionLike {
  phase: string;
  status: string;
  consent: string;
  securityReviewedAt: Date | string | null;
  lastSyncAt: Date | string | null;
  syncIntervalMinutes: number;
}

/** True when an active syncing connection missed more than two intervals (the worker's stale rule). */
export function isOverdue(c: ConnectionLike, now: Date = new Date()): boolean {
  if (c.status !== "active" || (c.phase !== "read_only" && c.phase !== "sandbox")) return false;
  if (!c.lastSyncAt) return false;
  const last = typeof c.lastSyncAt === "string" ? new Date(c.lastSyncAt) : c.lastSyncAt;
  return now.getTime() - last.getTime() > 2 * c.syncIntervalMinutes * 60_000;
}

export interface SyncHealth {
  total: number;
  active: number;
  paused: number;
  error: number;
  awaitingConsent: number;
  awaitingReview: number;
  neverSynced: number;
  overdue: number;
}

export function syncHealth(rows: readonly ConnectionLike[], now: Date = new Date()): SyncHealth {
  const h: SyncHealth = { total: rows.length, active: 0, paused: 0, error: 0, awaitingConsent: 0, awaitingReview: 0, neverSynced: 0, overdue: 0 };
  for (const c of rows) {
    if (c.status === "active") h.active++;
    if (c.status === "paused") h.paused++;
    if (c.status === "error") h.error++;
    if (c.consent === "pending") h.awaitingConsent++;
    if (c.consent === "granted" && !c.securityReviewedAt && c.phase === "metadata") h.awaitingReview++;
    if (c.status === "active" && (c.phase === "read_only" || c.phase === "sandbox") && !c.lastSyncAt) h.neverSynced++;
    if (isOverdue(c, now)) h.overdue++;
  }
  return h;
}

export interface AgencyActionsOffered {
  /** Record a security review: the client has consented. */
  review: boolean;
  /** The next phase the form offers, or null. Requires consent and an approved review for read_only. */
  advanceTo: Phase | null;
  /** Why no advance is offered (shown instead of the form). */
  advanceBlockedBy: string | null;
  pause: boolean;
  resume: boolean;
  runSync: boolean;
  testConnection: boolean;
}

/** Which agency actions the detail page offers. Mirrors the trigger so most refusals are explained before the submit. */
export function agencyActionsFor(c: ConnectionLike): AgencyActionsOffered {
  const next = nextPhase(c.phase);
  let advanceBlockedBy: string | null = null;
  if (!next) advanceBlockedBy = c.phase === "sandbox" ? "the write phase has no implementation in this release and is refused by the database" : "no further phase";
  else if (c.consent !== "granted") advanceBlockedBy = `phase ${phaseLabel(next)} requires consent granted by the client admin`;
  else if (!c.securityReviewedAt) advanceBlockedBy = `phase ${phaseLabel(next)} requires a recorded, approved security review`;
  const syncable = (c.phase === "read_only" || c.phase === "sandbox") && c.consent === "granted";
  return {
    review: c.consent === "granted",
    advanceTo: advanceBlockedBy ? null : next,
    advanceBlockedBy,
    pause: c.status === "active",
    resume: c.status === "paused" && c.phase !== "metadata",
    runSync: syncable && c.status === "active",
    testConnection: syncable
  };
}

export interface ClientActionsOffered {
  grantConsent: boolean;
  revokeConsent: boolean;
}

/** Which consent forms the Integration Center offers a client admin (never under a break-glass grant). */
export function clientActionsFor(c: { consent: string }, isAdmin: boolean): ClientActionsOffered {
  if (!isAdmin) return { grantConsent: false, revokeConsent: false };
  return { grantConsent: c.consent !== "granted", revokeConsent: c.consent === "granted" };
}

/** Names a KPI's `source_system` may carry for this connection: the registered system's name and the provider's display name. */
export function kpiSourceNames(systemName: string | null, descriptor: ConnectorDescriptor | null, provider: string): string[] {
  const names = new Set<string>([provider]);
  if (systemName) names.add(systemName);
  if (descriptor) names.add(descriptor.displayName);
  return [...names];
}

/** Matches a registered system to a provider descriptor by name or vendor (case-insensitive), for the propose form's default. */
export function suggestProvider(system: { name: string; vendor: string | null }, descriptors: readonly ConnectorDescriptor[]): string | null {
  const hay = `${system.name} ${system.vendor ?? ""}`.toLowerCase();
  for (const d of descriptors) {
    if (hay.includes(d.provider) || hay.includes(d.displayName.toLowerCase()) || hay.includes(d.vendor.toLowerCase())) return d.provider;
  }
  return null;
}
