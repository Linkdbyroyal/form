import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { schema, writeAudit, type RequestContext, type Tx } from "@sbos/db";
import { AuthorizationError } from "./errors";
import { defineKpi, observeKpi } from "./xray";

/**
 * Integration services (Milestone 5, ADR-011): connections in phases with consent per phase, security
 * review, sync runs and KPI observations with lineage. The database trigger `enforce_connection_phase`
 * holds the hard rules (one step at a time, consent before read_only, review before read_only, no write
 * phase, no agent changes). These services add validation, audit rows and the phase-change log.
 * Secrets never pass through here: `credentials_metadata.secret_ref` is a reference the worker resolves.
 */
const { connections, connectionPhaseChanges, syncRuns, credentialsMetadata, webhookEndpoints, kpis, systems } = schema;

export type ConnectionPhase = (typeof schema.connectionPhase.enumValues)[number];
export type ConnectionStatus = (typeof schema.connectionStatus.enumValues)[number];
export type SyncTrigger = (typeof schema.syncTrigger.enumValues)[number];

const AGENCY_DECIDERS = ["superadmin", "agency_operator", "agency_reviewer"] as const;
const SECRET_REF_RE = /^env:[A-Z][A-Z0-9_]{2,80}$/;
const TOKEN_LIKE = /(sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{16,}|[A-Za-z0-9_-]{40,})/g;

function requireTenant(ctx: RequestContext, tenantId: string, what: string): void {
  if (ctx.kind === "operator" || ctx.tenantId !== tenantId) throw new AuthorizationError(`${what} runs inside the tenant's context`);
}

function hasRole(ctx: RequestContext, roles: readonly string[]): boolean {
  return ctx.roles.some((r) => roles.includes(r));
}

/** Masks anything token-like so error text can be stored and shown. */
export function maskErrorText(text: string): string {
  return text.replace(TOKEN_LIKE, "[redacted]").slice(0, 1000);
}

async function logPhaseChange(tx: Tx, ctx: RequestContext, input: { tenantId: string; connectionId: string; fromPhase: ConnectionPhase | null; toPhase: ConnectionPhase; kind: string; consent?: (typeof schema.consentStatus.enumValues)[number] | null; scopes?: string[]; userId?: string | null; reason: string; reviewOutcome?: "approved" | "rejected" | null }): Promise<void> {
  await tx.insert(connectionPhaseChanges).values({ tenantId: input.tenantId, connectionId: input.connectionId, fromPhase: input.fromPhase, toPhase: input.toPhase, kind: input.kind, consent: input.consent ?? null, scopes: input.scopes ?? [], actorType: ctx.actorType, actorId: ctx.actorId, userId: input.userId ?? null, roles: [...ctx.roles], reason: input.reason, reviewOutcome: input.reviewOutcome ?? null });
}

// Connections ------------------------------------------------------------------------------------

export interface ProposeConnectionInput {
  tenantId: string;
  provider: string;
  systemId?: string | null;
  syncIntervalMinutes?: number;
  config?: Record<string, unknown>;
  reason?: string;
}

/** Creates a connection in phase `metadata` with consent pending. Client admins and agency staff may propose. */
export async function proposeConnection(tx: Tx, ctx: RequestContext, input: ProposeConnectionInput): Promise<string> {
  requireTenant(ctx, input.tenantId, "proposing a connection");
  if (ctx.actorType === "agent") throw new AuthorizationError("agents cannot propose connections");
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(input.provider)) throw new Error("provider must be a lowercase key");
  const config = input.config ?? {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === "string" && (TOKEN_LIKE.test(v) || /secret|token|password|key/i.test(k))) throw new Error(`config key "${k}" looks like a credential; credentials go to the worker's secret store, never to connections.config`);
    TOKEN_LIKE.lastIndex = 0;
  }
  const [row] = await tx
    .insert(connections)
    .values({ tenantId: input.tenantId, provider: input.provider, systemId: input.systemId ?? null, phase: "metadata", status: "proposed", consent: "pending", scopes: [], config, syncIntervalMinutes: input.syncIntervalMinutes ?? 60 })
    .returning({ id: connections.id });
  if (!row) throw new Error("connection insert returned nothing");
  await logPhaseChange(tx, ctx, { tenantId: input.tenantId, connectionId: row.id, fromPhase: null, toPhase: "metadata", kind: "proposed", reason: input.reason ?? "connection proposed" });
  await writeAudit(tx, ctx, { action: "connection.proposed", entityType: "connection", entityId: row.id, after: { provider: input.provider, phase: "metadata" } });
  return row.id;
}

export interface GrantConsentInput {
  tenantId: string;
  connectionId: string;
  /** The scopes the client agrees to, in the connector's words. */
  scopes: string[];
  reason: string;
  /** public.users id of the client admin giving consent. */
  userId: string;
}

/** The client admin grants consent for the next phase. Recorded with user, time and scopes; the trigger enforces the role. */
export async function grantConsent(tx: Tx, ctx: RequestContext, input: GrantConsentInput): Promise<void> {
  requireTenant(ctx, input.tenantId, "granting consent");
  if (!hasRole(ctx, ["client_admin", "superadmin"])) throw new AuthorizationError("consent is granted by the client admin (superadmin only on written instruction)");
  if (input.scopes.length === 0) throw new Error("consent needs at least one named scope");
  if (input.reason.trim().length < 10) throw new Error("record why or on what basis consent is given (at least 10 characters)");
  const [c] = await tx.select({ phase: connections.phase }).from(connections).where(and(eq(connections.id, input.connectionId), eq(connections.tenantId, input.tenantId)));
  if (!c) throw new Error("connection not found in this tenant");
  await tx.update(connections).set({ consent: "granted", consentGivenByUserId: input.userId, scopes: input.scopes, status: "consent_pending" }).where(eq(connections.id, input.connectionId));
  await logPhaseChange(tx, ctx, { tenantId: input.tenantId, connectionId: input.connectionId, fromPhase: c.phase, toPhase: c.phase, kind: "consent_granted", consent: "granted", scopes: input.scopes, userId: input.userId, reason: input.reason });
  await writeAudit(tx, ctx, { action: "connection.consent_granted", entityType: "connection", entityId: input.connectionId, after: { scopes: input.scopes }, metadata: { reason: input.reason } });
}

/** Revokes consent: the trigger drops the phase to metadata and pauses; dependent KPIs become `missing_source`. */
export async function revokeConsent(tx: Tx, ctx: RequestContext, input: { tenantId: string; connectionId: string; reason: string }): Promise<{ kpisMarked: number }> {
  requireTenant(ctx, input.tenantId, "revoking consent");
  if (!hasRole(ctx, ["client_admin", "superadmin"])) throw new AuthorizationError("consent is revoked by the client admin or a superadmin");
  const [c] = await tx.select({ phase: connections.phase, provider: connections.provider, systemId: connections.systemId }).from(connections).where(and(eq(connections.id, input.connectionId), eq(connections.tenantId, input.tenantId)));
  if (!c) throw new Error("connection not found in this tenant");
  await tx.update(connections).set({ consent: "revoked", pausedReason: `consent revoked: ${input.reason}`.slice(0, 500) }).where(eq(connections.id, input.connectionId));
  const names = await sourceSystemNames(tx, input.tenantId, c.provider, c.systemId);
  const marked = await tx.update(kpis).set({ status: "missing_source" }).where(and(eq(kpis.tenantId, input.tenantId), inArray(kpis.sourceSystem, names), inArray(kpis.status, ["active", "stale", "draft"]))).returning({ id: kpis.id });
  await logPhaseChange(tx, ctx, { tenantId: input.tenantId, connectionId: input.connectionId, fromPhase: c.phase, toPhase: "metadata", kind: "consent_revoked", consent: "revoked", reason: input.reason });
  await writeAudit(tx, ctx, { action: "connection.consent_revoked", entityType: "connection", entityId: input.connectionId, after: { kpisMarked: marked.length }, metadata: { reason: input.reason } });
  return { kpisMarked: marked.length };
}

async function sourceSystemNames(tx: Tx, tenantId: string, provider: string, systemId: string | null): Promise<string[]> {
  const names = new Set<string>([provider]);
  if (systemId) {
    const [s] = await tx.select({ name: systems.name }).from(systems).where(and(eq(systems.id, systemId), eq(systems.tenantId, tenantId)));
    if (s) names.add(s.name);
  }
  return [...names];
}

/** Agency security review (superadmin, agency_operator or agency_reviewer) in agency scope pinned to the tenant. */
export async function recordSecurityReview(tx: Tx, ctx: RequestContext, input: { tenantId: string; connectionId: string; outcome: "approved" | "rejected"; note: string }): Promise<void> {
  requireTenant(ctx, input.tenantId, "a security review");
  if (ctx.kind !== "agency" || !hasRole(ctx, AGENCY_DECIDERS)) throw new AuthorizationError("the security review is an agency decision (superadmin, agency_operator or agency_reviewer)");
  if (input.note.trim().length < 10) throw new Error("the review needs a note (at least 10 characters)");
  const [c] = await tx.select({ phase: connections.phase, consent: connections.consent }).from(connections).where(and(eq(connections.id, input.connectionId), eq(connections.tenantId, input.tenantId)));
  if (!c) throw new Error("connection not found in this tenant");
  if (c.consent !== "granted") throw new Error("a security review follows the client's consent; consent is not granted yet");
  await tx
    .update(connections)
    .set(input.outcome === "approved" ? { securityReviewedAt: new Date(), securityReviewedBy: ctx.actorId } : { securityReviewedAt: null, securityReviewedBy: null, pausedReason: `security review rejected: ${input.note}`.slice(0, 500) })
    .where(eq(connections.id, input.connectionId));
  await logPhaseChange(tx, ctx, { tenantId: input.tenantId, connectionId: input.connectionId, fromPhase: c.phase, toPhase: c.phase, kind: "security_review", reason: input.note, reviewOutcome: input.outcome });
  await writeAudit(tx, ctx, { action: `connection.security_review_${input.outcome}`, entityType: "connection", entityId: input.connectionId, metadata: { note: input.note } });
}

/** Advances one phase. The trigger refuses skipping, missing consent, missing review, agents and the write phase. */
export async function advancePhase(tx: Tx, ctx: RequestContext, input: { tenantId: string; connectionId: string; to: ConnectionPhase; reason: string }): Promise<void> {
  requireTenant(ctx, input.tenantId, "advancing a connection phase");
  if (ctx.kind !== "agency" || !hasRole(ctx, AGENCY_DECIDERS)) throw new AuthorizationError("advancing a phase is an agency decision (superadmin, agency_operator or agency_reviewer)");
  const [c] = await tx.select({ phase: connections.phase }).from(connections).where(and(eq(connections.id, input.connectionId), eq(connections.tenantId, input.tenantId)));
  if (!c) throw new Error("connection not found in this tenant");
  await tx.update(connections).set({ phase: input.to, status: input.to === "metadata" ? "proposed" : "active", pausedReason: null }).where(eq(connections.id, input.connectionId));
  await logPhaseChange(tx, ctx, { tenantId: input.tenantId, connectionId: input.connectionId, fromPhase: c.phase, toPhase: input.to, kind: "phase_advanced", reason: input.reason });
  await writeAudit(tx, ctx, { action: "connection.phase_advanced", entityType: "connection", entityId: input.connectionId, before: { phase: c.phase }, after: { phase: input.to }, metadata: { reason: input.reason } });
}

export async function setConnectionPaused(tx: Tx, ctx: RequestContext, input: { tenantId: string; connectionId: string; paused: boolean; reason: string }): Promise<void> {
  requireTenant(ctx, input.tenantId, "pausing a connection");
  if (ctx.actorType === "agent") throw new AuthorizationError("agents cannot pause or resume connections");
  if (!hasRole(ctx, ["client_admin", ...AGENCY_DECIDERS])) throw new AuthorizationError("pausing or resuming needs client_admin or an agency role");
  const [c] = await tx.select({ phase: connections.phase, status: connections.status }).from(connections).where(and(eq(connections.id, input.connectionId), eq(connections.tenantId, input.tenantId)));
  if (!c) throw new Error("connection not found in this tenant");
  if (!input.paused && c.phase === "metadata") throw new Error("a connection in the metadata phase has nothing to resume; advance the phase instead");
  await tx.update(connections).set(input.paused ? { status: "paused", pausedReason: input.reason.slice(0, 500) } : { status: "active", pausedReason: null }).where(eq(connections.id, input.connectionId));
  await logPhaseChange(tx, ctx, { tenantId: input.tenantId, connectionId: input.connectionId, fromPhase: c.phase, toPhase: c.phase, kind: input.paused ? "paused" : "resumed", reason: input.reason });
  await writeAudit(tx, ctx, { action: input.paused ? "connection.paused" : "connection.resumed", entityType: "connection", entityId: input.connectionId, metadata: { reason: input.reason } });
}

/** Records that a credential exists in the worker's secret store. Only the reference is stored. */
export async function registerCredentialReference(tx: Tx, ctx: RequestContext, input: { tenantId: string; connectionId: string; kind: "api_key" | "oauth_refresh_token" | "basic"; secretRef: string; expiresAt?: Date | null }): Promise<string> {
  requireTenant(ctx, input.tenantId, "registering a credential reference");
  if (ctx.kind !== "agency" || !hasRole(ctx, AGENCY_DECIDERS)) throw new AuthorizationError("credential references are registered by agency staff");
  if (!SECRET_REF_RE.test(input.secretRef)) throw new Error("secret reference must look like env:VARIABLE_NAME; never paste the secret itself");
  const [row] = await tx.insert(credentialsMetadata).values({ tenantId: input.tenantId, connectionId: input.connectionId, kind: input.kind, secretRef: input.secretRef, expiresAt: input.expiresAt ?? null, createdByActorId: ctx.actorId }).returning({ id: credentialsMetadata.id });
  if (!row) throw new Error("credential reference insert returned nothing");
  await writeAudit(tx, ctx, { action: "credential_reference.registered", entityType: "credentials_metadata", entityId: row.id, after: { kind: input.kind, secretRef: input.secretRef } });
  return row.id;
}

export async function registerWebhookEndpoint(tx: Tx, ctx: RequestContext, input: { tenantId: string; connectionId: string; pathToken: string; secretRef: string }): Promise<string> {
  requireTenant(ctx, input.tenantId, "registering a webhook endpoint");
  if (ctx.kind !== "agency" || !hasRole(ctx, AGENCY_DECIDERS)) throw new AuthorizationError("webhook endpoints are registered by agency staff");
  if (!SECRET_REF_RE.test(input.secretRef)) throw new Error("secret reference must look like env:VARIABLE_NAME");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(input.pathToken)) throw new Error("path token must be 16 to 64 url-safe characters");
  const [row] = await tx.insert(webhookEndpoints).values({ tenantId: input.tenantId, connectionId: input.connectionId, pathToken: input.pathToken, secretRef: input.secretRef, createdByActorId: ctx.actorId }).returning({ id: webhookEndpoints.id });
  if (!row) throw new Error("webhook endpoint insert returned nothing");
  await writeAudit(tx, ctx, { action: "webhook_endpoint.registered", entityType: "webhook_endpoint", entityId: row.id, after: { connectionId: input.connectionId } });
  return row.id;
}

// Sync runs and observations ----------------------------------------------------------------------

export async function startSyncRun(tx: Tx, ctx: RequestContext, input: { tenantId: string; connectionId: string; trigger: SyncTrigger; phase: ConnectionPhase; mode: "sandbox" | "live" }): Promise<string> {
  requireTenant(ctx, input.tenantId, "starting a sync run");
  const [row] = await tx.insert(syncRuns).values({ tenantId: input.tenantId, connectionId: input.connectionId, trigger: input.trigger, phase: input.phase, mode: input.mode, status: "running" }).returning({ id: syncRuns.id });
  if (!row) throw new Error("sync run insert returned nothing");
  return row.id;
}

export interface FinishSyncRunInput {
  tenantId: string;
  syncRunId: string;
  status: "succeeded" | "failed" | "skipped";
  objectsRead?: number;
  observationsWritten?: number;
  errorClass?: string | null;
  errorMessage?: string | null;
  details?: Record<string, unknown>;
}

export async function finishSyncRun(tx: Tx, ctx: RequestContext, input: FinishSyncRunInput): Promise<void> {
  requireTenant(ctx, input.tenantId, "finishing a sync run");
  const [run] = await tx.select({ connectionId: syncRuns.connectionId, status: syncRuns.status }).from(syncRuns).where(and(eq(syncRuns.id, input.syncRunId), eq(syncRuns.tenantId, input.tenantId)));
  if (!run) throw new Error("sync run not found");
  if (run.status !== "running") throw new Error(`sync run is already ${run.status}`);
  const errorMessage = input.errorMessage ? maskErrorText(input.errorMessage) : null;
  await tx.update(syncRuns).set({ status: input.status, finishedAt: new Date(), objectsRead: input.objectsRead ?? 0, observationsWritten: input.observationsWritten ?? 0, errorClass: input.errorClass ?? null, errorMessage, details: input.details ?? {} }).where(eq(syncRuns.id, input.syncRunId));
  if (input.status === "succeeded") await tx.update(connections).set({ lastSyncAt: new Date(), lastError: null }).where(eq(connections.id, run.connectionId));
  if (input.status === "failed") await tx.update(connections).set({ lastError: `${input.errorClass ?? "error"}: ${errorMessage ?? ""}`.slice(0, 500), status: "error" }).where(and(eq(connections.id, run.connectionId), eq(connections.status, "active")));
}

export interface MetricReadingInput {
  key: string;
  name: string;
  unit: string;
  formula: string;
  sourceField: string;
  direction: "higher_is_better" | "lower_is_better";
  status: "ok" | "missing_data" | "stale_data" | "error";
  value: number | null;
  periodStart: Date;
  periodEnd: Date;
  sourceRecordIds: string[];
}

/**
 * Writes one observation per reading with lineage (formula, source field, source record ids, sync run). A KPI
 * that does not exist yet is defined from the connector's descriptor (formula, source system and field are
 * known, so the "no KPI without source and formula" rule holds); an existing KPI keeps its definition.
 */
export async function recordMetricObservations(tx: Tx, ctx: RequestContext, input: { tenantId: string; connectionId: string; syncRunId: string; sourceSystem: string; readings: MetricReadingInput[]; ownerRole?: string }): Promise<{ written: number; kpiIds: string[] }> {
  requireTenant(ctx, input.tenantId, "recording metric observations");
  const kpiIds: string[] = [];
  let written = 0;
  for (const r of input.readings) {
    const [existing] = await tx.select({ id: kpis.id }).from(kpis).where(and(eq(kpis.tenantId, input.tenantId), eq(kpis.key, r.key)));
    const kpiId = existing?.id ?? (await defineKpi(tx, ctx, { tenantId: input.tenantId, key: r.key, name: r.name, businessQuestion: `What is ${r.name.toLowerCase()} according to ${input.sourceSystem}?`, formula: r.formula, unit: r.unit, sourceSystem: input.sourceSystem, sourceField: r.sourceField, ownerRole: input.ownerRole ?? "client_admin", direction: r.direction, reliability: "medium", status: "active" }));
    kpiIds.push(kpiId);
    await observeKpi(tx, ctx, { tenantId: input.tenantId, kpiId, periodStart: r.periodStart, periodEnd: r.periodEnd, value: r.value, status: r.status, lineage: { query_or_formula: `${r.formula} [${input.sourceSystem}.${r.sourceField}]`, source_record_ids: r.sourceRecordIds.slice(0, 200) }, syncRunId: input.syncRunId });
    written++;
  }
  await writeAudit(tx, ctx, { action: "connection.observations_recorded", entityType: "sync_run", entityId: input.syncRunId, after: { written, keys: input.readings.map((r) => r.key) } });
  return { written, kpiIds };
}

/** Connections due for a scheduled sync (operator or agency view across tenants). */
export async function dueConnections(tx: Tx, ctx: RequestContext, now = new Date()): Promise<Array<{ id: string; tenantId: string; provider: string }>> {
  if (ctx.kind === "tenant") throw new AuthorizationError("due connections are listed across tenants by the worker (operator or agency context)");
  const rows = await tx
    .select({ id: connections.id, tenantId: connections.tenantId, provider: connections.provider, lastSyncAt: connections.lastSyncAt, interval: connections.syncIntervalMinutes })
    .from(connections)
    .where(and(eq(connections.status, "active"), inArray(connections.phase, ["read_only", "sandbox"]), or(isNull(connections.lastSyncAt), lt(connections.lastSyncAt, sql`${now.toISOString()}::timestamptz - make_interval(mins => ${connections.syncIntervalMinutes})`))));
  return rows.map((r) => ({ id: r.id, tenantId: r.tenantId, provider: r.provider }));
}

/** Marks observations stale when a connection missed more than two intervals; returns the KPIs affected. */
export async function markStaleConnections(tx: Tx, ctx: RequestContext, now = new Date()): Promise<Array<{ connectionId: string; tenantId: string }>> {
  if (ctx.kind === "tenant") throw new AuthorizationError("stale marking runs across tenants");
  const rows = await tx
    .select({ id: connections.id, tenantId: connections.tenantId })
    .from(connections)
    .where(and(eq(connections.status, "active"), inArray(connections.phase, ["read_only", "sandbox"]), lt(connections.lastSyncAt, sql`${now.toISOString()}::timestamptz - make_interval(mins => 2 * ${connections.syncIntervalMinutes})`)));
  return rows.map((r) => ({ connectionId: r.id, tenantId: r.tenantId }));
}

export async function listSyncRuns(tx: Tx, ctx: RequestContext, input: { tenantId: string; connectionId: string; limit?: number }) {
  requireTenant(ctx, input.tenantId, "listing sync runs");
  return tx.select().from(syncRuns).where(and(eq(syncRuns.tenantId, input.tenantId), eq(syncRuns.connectionId, input.connectionId))).orderBy(desc(syncRuns.startedAt)).limit(Math.min(100, input.limit ?? 20));
}


/** Credential references past their expiry; the worker refuses live mode for them and reports an incident. */
export async function expiredCredentialReferences(tx: Tx, ctx: RequestContext, input: { tenantId: string; connectionId?: string; now?: Date }): Promise<Array<{ id: string; connectionId: string; kind: string; secretRef: string; expiresAt: Date }>> {
  requireTenant(ctx, input.tenantId, "listing expired credential references");
  const now = input.now ?? new Date();
  const rows = await tx
    .select({ id: credentialsMetadata.id, connectionId: credentialsMetadata.connectionId, kind: credentialsMetadata.kind, secretRef: credentialsMetadata.secretRef, expiresAt: credentialsMetadata.expiresAt })
    .from(credentialsMetadata)
    .where(and(eq(credentialsMetadata.tenantId, input.tenantId), input.connectionId ? eq(credentialsMetadata.connectionId, input.connectionId) : sql`true`, lt(credentialsMetadata.expiresAt, now)));
  return rows.filter((r): r is typeof r & { expiresAt: Date } => r.expiresAt !== null);
}

export interface UpdateConnectionConfigInput {
  tenantId: string;
  connectionId: string;
  /** Keys to set; a null value removes the key. Credential-looking keys and token-looking values are refused. */
  patch: Record<string, unknown>;
}

/**
 * Updates non-secret connection settings (`connections.config`): `mode` (sandbox or live), the connector's
 * `credentialRef` (an env:NAME reference, never a value) and connector specific keys such as Rentman's
 * `closedStatusNames`. Agency staff only (operators, reviewers, superadmins); agents and client users never
 * change how a system is read. Audited with the keys that changed, not the values.
 */
export async function updateConnectionConfig(tx: Tx, ctx: RequestContext, input: UpdateConnectionConfigInput): Promise<Record<string, unknown>> {
  requireTenant(ctx, input.tenantId, "updating a connection's configuration");
  if (ctx.actorType === "agent") throw new AuthorizationError("agents cannot change connection configuration");
  if (ctx.kind !== "agency") throw new AuthorizationError("only agency staff change connection configuration");
  for (const [k, v] of Object.entries(input.patch)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(k)) throw new Error(`config key "${k}" is not a valid key`);
    if (/secret|token|password|apikey|api_key/i.test(k) && k !== "credentialRef") throw new Error(`config key "${k}" looks like a credential; credentials go to the worker's secret store, never to connections.config`);
    if (typeof v === "string" && TOKEN_LIKE.test(v)) throw new Error(`config key "${k}" has a value that looks like a credential`);
    TOKEN_LIKE.lastIndex = 0;
    if (k === "credentialRef" && v !== null && !(typeof v === "string" && SECRET_REF_RE.test(v))) throw new Error("credentialRef must look like env:VARIABLE_NAME");
    if (k === "mode" && v !== "sandbox" && v !== "live") throw new Error("mode must be sandbox or live");
  }
  const [row] = await tx.select({ config: connections.config }).from(connections).where(and(eq(connections.id, input.connectionId), eq(connections.tenantId, input.tenantId)));
  if (!row) throw new Error("connection not found");
  const current = (row.config ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(input.patch)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  await tx.update(connections).set({ config: next, updatedAt: new Date() }).where(and(eq(connections.id, input.connectionId), eq(connections.tenantId, input.tenantId)));
  await writeAudit(tx, ctx, { action: "connection.config_updated", entityType: "connection", entityId: input.connectionId, before: { keys: Object.keys(current).sort() }, after: { keys: Object.keys(next).sort(), mode: typeof next.mode === "string" ? next.mode : "sandbox" } });
  return next;
}
