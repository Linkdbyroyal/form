"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { agencyContext, schema, writeAudit, type AgencyContext, type Tx } from "@sbos/db";
import { advancePhase, recordSecurityReview, registerCredentialReference, registerWebhookEndpoint, setConnectionPaused, updateConnectionConfig } from "@sbos/core";
import { LIVE_PROVIDERS } from "@sbos/connectors";
import { getDb } from "../db";
import { getJobs } from "../jobs";
import { errorMessage, withNotice } from "../format";
import { requireOperatorContext } from "../request-context";
import { CREDENTIAL_KINDS, isPhase, isValidSecretRef, pathTokenFromUuids, type CredentialKind } from "../client/integration-helpers";

/**
 * Connected Tools write actions (M5, ADR-011/021): security review, phase advance, pause and resume, credential and
 * webhook references, manual sync and connection test. Reads in Mission Control use the operator role, which cannot
 * write tenant tables, so every action runs as the signed-in operator in AGENCY scope pinned to the connection's
 * tenant (`agencyContext({ tenantId, ... })`), exactly like `lib/mission-control/actions.ts`. The database trigger
 * `enforce_connection_phase` is the real gate (one step at a time, consent and review before read_only, no write
 * phase, no agent changes); its text is shown through `?error=` on the redirect.
 *
 * The web app never runs a sync and never reads a secret: "Run sync now" and "Test connection" only enqueue the
 * `connector.sync` job that the worker processes; a credential is registered as an `env:NAME` reference only.
 */
const { connections } = schema;

const BASE = "/mission-control/tools";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(form: FormData, name: string, options: { required?: boolean; max?: number } = {}): string {
  const raw = form.get(name);
  const value = typeof raw === "string" ? raw.trim() : "";
  if (options.required && value.length === 0) throw new Error(`${name} is required`);
  if (options.max && value.length > options.max) throw new Error(`${name} is longer than ${options.max} characters`);
  return value;
}

function uuidField(form: FormData, name: string): string {
  const v = field(form, name, { required: true });
  if (!UUID_RE.test(v)) throw new Error(`${name} must be a UUID`);
  return v;
}

function returnPath(form: FormData, fallback: string): string {
  const v = field(form, "returnTo");
  return v.startsWith("/") && !v.startsWith("//") ? v : fallback;
}

function isRedirect(err: unknown): boolean {
  return typeof err === "object" && err !== null && "digest" in err && typeof (err as { digest?: unknown }).digest === "string" && (err as { digest: string }).digest.startsWith("NEXT_REDIRECT");
}

function finish(returnTo: string, outcome: { ok?: string; error?: string }): never {
  revalidatePath(returnTo.split("?")[0] ?? returnTo);
  revalidatePath(BASE);
  revalidatePath("/mission-control");
  redirect(withNotice(returnTo, outcome));
}

/** Runs `fn` as the signed-in operator in agency scope pinned to the connection's tenant, after checking the connection exists there. */
async function connectionWrite<T>(form: FormData, fn: (tx: Tx, ctx: AgencyContext, conn: { id: string; tenantId: string; phase: string; status: string; consent: string; provider: string }) => Promise<T>): Promise<T> {
  const connectionId = uuidField(form, "connectionId");
  const tenantId = uuidField(form, "tenantId");
  const op = await requireOperatorContext();
  const ctx = agencyContext({ tenantId, actorType: "user", actorId: op.actorId, roles: op.roles });
  return getDb().withContext(ctx, async (tx) => {
    const [conn] = await tx.select({ id: connections.id, tenantId: connections.tenantId, phase: connections.phase, status: connections.status, consent: connections.consent, provider: connections.provider }).from(connections).where(and(eq(connections.id, connectionId), eq(connections.tenantId, tenantId)));
    if (!conn) throw new Error("connection not found in that tenant");
    return fn(tx, ctx, conn);
  });
}

function detailPath(form: FormData): string {
  const id = field(form, "connectionId");
  return returnPath(form, UUID_RE.test(id) ? `${BASE}/${id}` : BASE);
}

export async function securityReviewAction(form: FormData): Promise<void> {
  const returnTo = detailPath(form);
  let outcome: { ok?: string; error?: string };
  try {
    const outcomeValue = field(form, "outcome", { required: true });
    if (outcomeValue !== "approved" && outcomeValue !== "rejected") throw new Error("outcome must be approved or rejected");
    const note = field(form, "note", { required: true, max: 2000 });
    await connectionWrite(form, (tx, ctx, conn) => recordSecurityReview(tx, ctx, { tenantId: conn.tenantId, connectionId: conn.id, outcome: outcomeValue, note }));
    outcome = { ok: outcomeValue === "approved" ? "Security review recorded as approved. The phase can now be advanced one step." : "Security review recorded as rejected; the connection stays in its phase and the reason is stored on the connection." };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function advancePhaseAction(form: FormData): Promise<void> {
  const returnTo = detailPath(form);
  let outcome: { ok?: string; error?: string };
  try {
    const to = field(form, "to", { required: true });
    if (!isPhase(to)) throw new Error("unknown phase");
    const reason = field(form, "reason", { required: true, max: 1000 });
    // The form only offers the next phase; for anything else (a crafted request, two steps at once, write) the
    // database trigger is the gate and its text is shown through the notice.
    await connectionWrite(form, (tx, ctx, conn) => advancePhase(tx, ctx, { tenantId: conn.tenantId, connectionId: conn.id, to, reason }));
    outcome = { ok: `Phase advanced to ${to.replaceAll("_", " ")}. The worker syncs on the connection's interval; use Run sync now to queue one immediately.` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function pauseResumeAction(form: FormData): Promise<void> {
  const returnTo = detailPath(form);
  let outcome: { ok?: string; error?: string };
  try {
    const action = field(form, "action", { required: true });
    if (action !== "pause" && action !== "resume") throw new Error("action must be pause or resume");
    const reason = field(form, "reason", { required: true, max: 500 });
    await connectionWrite(form, (tx, ctx, conn) => setConnectionPaused(tx, ctx, { tenantId: conn.tenantId, connectionId: conn.id, paused: action === "pause", reason }));
    outcome = { ok: action === "pause" ? "Connection paused. Scheduled and manual syncs skip it until it is resumed." : "Connection resumed and active again." };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function registerCredentialAction(form: FormData): Promise<void> {
  const returnTo = detailPath(form);
  let outcome: { ok?: string; error?: string };
  try {
    const kindValue = field(form, "kind", { required: true });
    if (!(CREDENTIAL_KINDS as readonly string[]).includes(kindValue)) throw new Error(`kind must be one of ${CREDENTIAL_KINDS.join(", ")}`);
    const kind = kindValue as CredentialKind;
    const secretRef = field(form, "secretRef", { required: true, max: 120 });
    if (!isValidSecretRef(secretRef)) throw new Error("secret reference must look like env:VARIABLE_NAME (upper case, digits and underscores); never paste the secret itself");
    const expiresRaw = field(form, "expiresAt");
    const expiresAt = expiresRaw ? new Date(`${expiresRaw}T00:00:00Z`) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error("expiry date is invalid");
    await connectionWrite(form, (tx, ctx, conn) => registerCredentialReference(tx, ctx, { tenantId: conn.tenantId, connectionId: conn.id, kind, secretRef, expiresAt }));
    outcome = { ok: `Credential reference ${secretRef} registered (${kind}). Only the reference is stored; the value must be set as that variable in the worker's environment.` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function registerWebhookAction(form: FormData): Promise<void> {
  const returnTo = detailPath(form);
  let outcome: { ok?: string; error?: string };
  try {
    const secretRef = field(form, "secretRef", { required: true, max: 120 });
    if (!isValidSecretRef(secretRef)) throw new Error("signing secret reference must look like env:VARIABLE_NAME; never paste the secret itself");
    // The path token is generated server-side: 32 url-safe characters from two random UUIDs.
    const pathToken = pathTokenFromUuids(randomUUID(), randomUUID());
    await connectionWrite(form, (tx, ctx, conn) => registerWebhookEndpoint(tx, ctx, { tenantId: conn.tenantId, connectionId: conn.id, pathToken, secretRef }));
    outcome = { ok: `Webhook endpoint registered with path token ${pathToken} (signature unverified until the worker receives a signed call). No inbound webhook handler is deployed in this release; the endpoint is a reference only.` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

/** Enqueues `connector.sync` with trigger manual or test. The worker runs it; the web app only queues. */
export async function enqueueSyncAction(form: FormData): Promise<void> {
  const returnTo = detailPath(form);
  let outcome: { ok?: string; error?: string };
  try {
    const trigger = field(form, "trigger", { required: true });
    if (trigger !== "manual" && trigger !== "test") throw new Error("trigger must be manual or test");
    const jobs = await getJobs();
    const result = await connectionWrite(form, async (tx, ctx, conn) => {
      if (conn.phase === "metadata") throw new Error("the metadata phase allows no external call; advance the phase to read_only first");
      if (conn.phase === "write") throw new Error("the write phase has no implementation");
      if (trigger === "manual" && conn.status !== "active") throw new Error(`connection is ${conn.status}; manual syncs run only while active (a test connection is allowed)`);
      const jobId = await jobs.enqueue("connector.sync", { tenantId: conn.tenantId, connectionId: conn.id, trigger });
      await writeAudit(tx, ctx, { action: trigger === "test" ? "connection.test_requested" : "connection.sync_requested", entityType: "connection", entityId: conn.id, metadata: { trigger, jobId } });
      return { jobId, provider: conn.provider };
    });
    outcome = { ok: `${trigger === "test" ? "Test connection" : "Sync"} job queued${result.jobId ? ` (job ${result.jobId.slice(0, 8)})` : ""}. The worker processes it; the sync run appears here and in the client's Integration Center once it has. Sandbox mode: simulated fixtures, no external system is contacted.` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

/**
 * Live mode switch (ADR-023): sets `config.mode` to live or sandbox, the connector's credential reference and, for
 * Rentman, the status names that mean "closed". Only providers with a live implementation can be set to live; the
 * worker refuses the rest with a "not connected" sync run anyway. The reference must also be registered as a
 * credential reference so expiry is tracked, and the variable must exist in the worker's environment.
 */
export async function setLiveModeAction(form: FormData): Promise<void> {
  const returnTo = detailPath(form);
  let outcome: { ok?: string; error?: string };
  try {
    const mode = field(form, "mode", { required: true });
    if (mode !== "sandbox" && mode !== "live") throw new Error("mode must be sandbox or live");
    const credentialRef = field(form, "credentialRef", { max: 120 });
    if (mode === "live" && !credentialRef) throw new Error("live mode needs the credential reference (env:NAME) of the token in the worker environment");
    if (credentialRef && !isValidSecretRef(credentialRef)) throw new Error("credential reference must look like env:VARIABLE_NAME; never paste the token itself");
    const closedRaw = field(form, "closedStatusNames", { max: 400 });
    const closedStatusNames = closedRaw.split(",").map((x) => x.trim()).filter(Boolean);
    const patch: Record<string, unknown> = { mode };
    if (credentialRef) patch.credentialRef = credentialRef;
    if (closedStatusNames.length > 0) patch.closedStatusNames = closedStatusNames;
    let provider = "";
    await connectionWrite(form, async (tx, ctx, conn) => {
      provider = conn.provider;
      if (mode === "live" && !(LIVE_PROVIDERS as readonly string[]).includes(conn.provider)) throw new Error(`${conn.provider} has no live connector in this release (not connected); only ${LIVE_PROVIDERS.join(", ")} can run live`);
      await updateConnectionConfig(tx, ctx, { tenantId: conn.tenantId, connectionId: conn.id, patch });
    });
    outcome = { ok: mode === "live" ? `Connection set to live mode (${provider}). The next sync reads the real system read-only through ${credentialRef}; run "Test connection" first.` : "Connection set back to sandbox mode (simulated fixtures)." };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}
