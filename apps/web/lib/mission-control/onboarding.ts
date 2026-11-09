"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { agencyContext, schema, writeAudit } from "@sbos/db";
import { betterAuthSchema } from "@sbos/db/schema";
import { getAuthDb } from "../auth-db";
import { linkOrganizationToTenant } from "../auth-bridge";
import { getDb } from "../db";
import { errorMessage, withNotice } from "../format";
import { sendMail } from "../mailer";
import { getSession, requireOperatorContext } from "../request-context";
import { EMAIL_RE, LOCALES, parseDepartments, parseSystems, SLUG_RE } from "./onboarding-parse";

/**
 * Client onboarding wizard (M3-09): a consultant creates a client tenant with its organisation map,
 * systems register, budgets, the full agent pool, a Discovery schedule, the Better Auth organisation
 * and an invitation for the CEO.
 *
 * Scopes: the tenant row is inserted in agency scope without a tenant (`agencyContext({ tenantId: null })`),
 * everything inside the tenant in agency scope pinned to the new tenant, so RLS still applies. Every step
 * writes an audit row in the same transaction.
 *
 * Organisation and invitation: Better Auth's `createOrganization` makes the caller the owner member of
 * the organisation and `createInvitation` requires a member session on that organisation. The operator
 * must NOT become a member of a client (ADR-017: operators reach client content only through a
 * break-glass grant), so the organisation and invitation rows are written directly through the auth pool
 * (schema `auth`, identity data only) and the tenant is linked with `linkOrganizationToTenant`, the same
 * bridge function the Better Auth hook calls. The invitation row has the shape Better Auth expects, so
 * the existing `/accept-invitation/[id]` page (account creation for the invited address, e-mail
 * verification, accept through `auth.api.acceptInvitation`) handles the rest and the bridge mirrors the
 * CEO into `memberships` as client_admin. The invitation mail goes through the mailer (`[mail:dev]`
 * console delivery without RESEND_API_KEY).
 */
const { tenants, departments, systems, budgets, agentDefinitions, agentInstances, schedules, skillReleaseChannels } = schema;

function field(form: FormData, name: string, options: { required?: boolean; max?: number } = {}): string {
  const raw = form.get(name);
  const value = typeof raw === "string" ? raw.trim() : "";
  if (options.required && value.length === 0) throw new Error(`${name} is required`);
  if (options.max && value.length > options.max) throw new Error(`${name} is longer than ${options.max} characters`);
  return value;
}

export async function createClientAction(form: FormData): Promise<void> {
  const returnTo = "/mission-control/clients/new";
  let destination: string | null = null;
  let outcome: { ok?: string; error?: string };
  try {
    const op = await requireOperatorContext();
    const session = await getSession();
    if (!session) throw new Error("not signed in");
    const name = field(form, "name", { required: true, max: 160 });
    const slug = field(form, "slug", { required: true, max: 64 }).toLowerCase();
    if (!SLUG_RE.test(slug)) throw new Error("slug must be lowercase letters, digits and dashes (3 to 64 characters)");
    const industry = field(form, "industry", { max: 120 }) || null;
    const locale = field(form, "locale") || "en";
    if (!(LOCALES as readonly string[]).includes(locale)) throw new Error(`locale must be one of ${LOCALES.join(", ")}`);
    const depts = parseDepartments(field(form, "departments", { max: 8000 }));
    if (depts.length === 0) throw new Error("at least one department is required (key|name|head role per line)");
    const systemLines = parseSystems(field(form, "systems", { max: 12000 }), new Set(depts.map((d) => d.key)));
    const ceoEmail = field(form, "ceoEmail", { required: true, max: 200 }).toLowerCase();
    if (!EMAIL_RE.test(ceoEmail)) throw new Error("CEO e-mail address is invalid");
    const ceoName = field(form, "ceoName", { required: true, max: 120 });

    const db = getDb();
    const authDb = getAuthDb();
    const actor = { actorType: "user" as const, actorId: op.actorId, roles: op.roles };

    // Refuse slugs that already exist as a tenant or an organisation before writing anything.
    const [orgExisting] = await authDb.select({ id: betterAuthSchema.organization.id }).from(betterAuthSchema.organization).where(eq(betterAuthSchema.organization.slug, slug));
    if (orgExisting) throw new Error(`an organisation with slug "${slug}" already exists`);

    // 1 and 2. Tenant plus everything inside it in ONE transaction, so a failure leaves nothing behind.
    //    The transaction starts in agency scope without a tenant (the only scope allowed to insert tenants);
    //    once the tenant row exists, `app.tenant_id` is set for the rest of the transaction (the same
    //    SET LOCAL mechanism `withContext()` uses), so RLS pins every following write to the new tenant.
    const { tenantId, summary } = await db.withContext(agencyContext({ tenantId: null, ...actor }), async (tx) => {
      const [dup] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug));
      if (dup) throw new Error(`a tenant with slug "${slug}" already exists`);
      const [t] = await tx.insert(tenants).values({ slug, name, kind: "client", status: "onboarding", locale, industry, settings: { onboarding: { wizard: "mission_control", by: op.actorId, at: new Date().toISOString() }, consent: "pending" } }).returning({ id: tenants.id });
      if (!t) throw new Error("tenant insert returned nothing");
      const tenantId = t.id;
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      const ctx = agencyContext({ tenantId, ...actor });
      await writeAudit(tx, ctx, { action: "tenant.created", entityType: "tenant", entityId: tenantId, after: { slug, kind: "client", status: "onboarding", locale, industry } });
      const deptIds: Record<string, string> = {};
      for (const d of depts) {
        const [row] = await tx.insert(departments).values({ tenantId, key: d.key, name: d.name, headRole: d.headRole }).returning({ id: departments.id });
        deptIds[d.key] = row!.id;
        await writeAudit(tx, ctx, { action: "department.created", entityType: "department", entityId: row!.id, after: { key: d.key, headRole: d.headRole } });
      }
      for (const s of systemLines) {
        const [row] = await tx
          .insert(systems)
          .values({ tenantId, name: s.name, vendor: s.vendor, function: s.function, departmentId: s.departmentKey ? (deptIds[s.departmentKey] ?? null) : null, apiCapabilities: s.apiCapabilities, claimStatus: "stated", notes: "Stated by the consultant in the onboarding wizard; existence and access not verified." })
          .returning({ id: systems.id });
        await writeAudit(tx, ctx, { action: "system.registered", entityType: "system", entityId: row!.id, after: { name: s.name, claimStatus: "stated" } });
      }
      // Budgets: tenant cap USD 10 per month (ADR-016), per instance the definition's default.
      await tx.insert(budgets).values({ tenantId, scope: "tenant", capUsdMonth: "10.00", runCapUsd: "0.50" });
      await writeAudit(tx, ctx, { action: "budget.created", entityType: "budget", after: { scope: "tenant", capUsdMonth: "10.00" } });

      // Agent pool: every active definition, pinned to the skill's stable release.
      const defs = await tx.select({ id: agentDefinitions.id, key: agentDefinitions.key, name: agentDefinitions.name, skillId: agentDefinitions.skillId, cron: agentDefinitions.defaultScheduleCron, budget: agentDefinitions.defaultBudgetUsdMonth, runCap: agentDefinitions.defaultRunCapUsd }).from(agentDefinitions).where(eq(agentDefinitions.status, "active")).orderBy(agentDefinitions.key);
      if (defs.length === 0) throw new Error("no active agent definitions in the catalogue; run the seed first");
      let scheduleCount = 0;
      for (const def of defs) {
        const [stable] = def.skillId ? await tx.select({ skillVersionId: skillReleaseChannels.skillVersionId }).from(skillReleaseChannels).where(and(eq(skillReleaseChannels.skillId, def.skillId), eq(skillReleaseChannels.channel, "stable"))) : [];
        const [inst] = await tx.insert(agentInstances).values({ tenantId, definitionId: def.id, skillVersionId: stable?.skillVersionId ?? null, name: def.name, state: "idle", serviceIdentity: `agent:${def.key}:${slug}` }).returning({ id: agentInstances.id });
        await tx.insert(budgets).values({ tenantId, scope: "agent_instance", agentInstanceId: inst!.id, capUsdMonth: def.budget, runCapUsd: def.runCap });
        await writeAudit(tx, ctx, { action: "agent_instance.activated", entityType: "agent_instance", entityId: inst!.id, after: { definition: def.key, skillVersionId: stable?.skillVersionId ?? null } });
        const isDiscovery = def.key === "discovery-interview";
        if (isDiscovery || def.cron) {
          const [s] = await tx
            .insert(schedules)
            .values({ tenantId, agentInstanceId: inst!.id, name: `${def.name} (weekdays)`, cron: isDiscovery ? "0 7 * * 1-5" : def.cron!, timezone: "UTC", enabled: isDiscovery, expectedBySeconds: 900, instruction: isDiscovery ? "Discovery round: ask up to 5 targeted questions that close the largest evidence gaps." : `Scheduled run of ${def.name}` })
            .returning({ id: schedules.id });
          scheduleCount += 1;
          await writeAudit(tx, ctx, { action: "schedule.created", entityType: "schedule", entityId: s!.id, after: { definition: def.key, enabled: isDiscovery } });
        }
      }
      return { tenantId, summary: { departments: depts.length, systems: systemLines.length, agents: defs.length, schedules: scheduleCount } };
    });
    const ctx = agencyContext({ tenantId, ...actor });

    // 3. Better Auth organisation (direct row, then the bridge links it) and the CEO invitation.
    const orgId = randomUUID();
    await authDb.insert(betterAuthSchema.organization).values({ id: orgId, name, slug, createdAt: new Date(), metadata: JSON.stringify({ tenantId, createdBy: "onboarding_wizard" }) });
    await linkOrganizationToTenant({ id: orgId, slug, name });
    const invitationId = randomUUID();
    const expiresAt = new Date(Date.now() + 72 * 3_600_000);
    await authDb.insert(betterAuthSchema.invitation).values({ id: invitationId, organizationId: orgId, email: ceoEmail, role: "owner", status: "pending", expiresAt, createdAt: new Date(), inviterId: session.user.id });
    const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
    const acceptUrl = `${baseUrl}/accept-invitation/${invitationId}`;
    const delivery = await sendMail({
      to: ceoEmail,
      subject: `Second Brain Business OS: invitation to ${name}`,
      text: `${session.user.name || session.user.email} invited you (${ceoName}) to join ${name} as owner.\n\nAccept the invitation here:\n${acceptUrl}\n\nThe invitation expires in 72 hours. You create your account on that page; public sign-up is disabled.`
    });
    await db.withContext(ctx, async (tx) => {
      await writeAudit(tx, ctx, { action: "auth.invitation.created", entityType: "invitation", entityId: invitationId, after: { role: "owner", expiresAt: expiresAt.toISOString() }, metadata: { delivery: delivery.channel, organizationId: orgId } });
      await writeAudit(tx, ctx, { action: "tenant.onboarding_completed", entityType: "tenant", entityId: tenantId, after: summary, metadata: { ceoInvited: true } });
    });

    destination = `/mission-control/clients/${slug}`;
    outcome = { ok: `Client "${name}" created: ${summary.departments} department(s), ${summary.systems} system(s), ${summary.agents} agent instance(s), ${summary.schedules} schedule(s) (Discovery enabled, weekdays 07:00 UTC), organisation linked, CEO invitation ${delivery.channel === "console" ? "logged to the server console ([mail:dev])" : "sent by e-mail"}.` };
  } catch (err) {
    outcome = { error: errorMessage(err) };
  }
  revalidatePath("/mission-control/clients");
  revalidatePath("/mission-control");
  if (destination) {
    revalidatePath(destination);
    redirect(withNotice(destination, outcome));
  }
  redirect(withNotice(returnTo, outcome));
}
