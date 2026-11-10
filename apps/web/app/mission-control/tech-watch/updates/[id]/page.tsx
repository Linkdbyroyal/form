import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Card, Empty, Status, inputClass } from "@/components/ui";
import { Mono, Notice, PageHeader, ShortId, Table, Td, Tr, selectClass, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { GovernanceStatusCard, SecurityRiskBadge, TechWatchNav, TechWatchSandboxNote, UpgradeKindBadge, UpgradeStatusBadge } from "@/components/governance-ui";
import { firstParam, fmtDate } from "@/lib/format";
import { shortActor } from "@/lib/mission-control/agency-vault-helpers";
import { applyUpdateAction, assessUpdateAction, createSkillVersionAction, decideUpdateAction, rollbackUpdateAction } from "@/lib/mission-control/governance-actions";
import { allowedUpgradeTransitions, artefactRequirement, isReviewer, missingAssessmentFields, SECURITY_RISKS, TECH_WATCH_BASE, UPGRADE_KINDS, upgradeActionsForRoles, updateHref } from "@/lib/mission-control/governance-helpers";
import { getPinnedInstances, getUpdateDetail } from "@/lib/mission-control/governance-queries";
import { requireAgencyContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Field({ label, value, mono = false }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div>
      <dt className="text-faint">{label}</dt>
      <dd className={`whitespace-pre-wrap break-words ${mono ? "font-mono text-[11px]" : ""}`}>{value ? value : <span className="text-faint">not recorded</span>}</dd>
    </div>
  );
}

export default async function UpgradeCenterPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const ctx = await requireAgencyContext();
  const sp = await searchParams;
  const detail = await getUpdateDetail(ctx, id);
  if (!detail) notFound();
  const { update: u, source, transitions, skillVersion, previousSkillVersion, knowledgeRecord, skills, publishedRecords } = detail;
  const pinned = u.kind === "skill_update" && u.skillVersionId ? await getPinnedInstances(ctx, u.skillVersionId) : null;
  const reviewer = isReviewer(ctx.roles);
  const offered = upgradeActionsForRoles(u.status, ctx.roles);
  const offers = (a: string) => offered.some((o) => o.action === a);
  const artefact = u.kind ? artefactRequirement(u.kind) : null;
  const missing = missingAssessmentFields(u);
  const returnTo = updateHref(u.id);
  const hidden = (
    <>
      <input type="hidden" name="updateId" value={u.id} />
      <input type="hidden" name="returnTo" value={returnTo} />
    </>
  );
  const artefactPresent = artefact ? Boolean(u[artefact.field]) : true;

  return (
    <div className="space-y-6">
      <PageHeader title={`${u.subject} ${u.proposedVersion}`} crumbs={[{ href: "/mission-control", label: "Mission Control" }, { href: TECH_WATCH_BASE, label: "Tech Watch" }, { href: `${TECH_WATCH_BASE}?view=updates`, label: "Detected updates" }, { label: u.subject }]}>
        Upgrade Center for update <ShortId id={u.id} /> from source {source.name}. The UpgradeProposal fields below are filled by an assessment; a reviewer approves with the artefact of the kind and applies with a test result. Code updates are merged by humans through the pull request, the platform only records it; skill updates move the stable channel and never re-pin running instances. <Status state="implemented" />
      </PageHeader>
      <TechWatchNav active="updates" />
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
      <TechWatchSandboxNote />

      <Card title="Proposal">
        <div className="flex flex-wrap items-center gap-2">
          <UpgradeStatusBadge value={u.status} />
          <UpgradeKindBadge value={u.kind} />
          <span className="text-xs text-faint">security risk</span> <SecurityRiskBadge value={u.securityRisk} />
          <span className="text-xs text-faint">allowed next states: {allowedUpgradeTransitions(u.status).map((s) => s.replaceAll("_", " ")).join(", ") || "none (final)"}</span>
        </div>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs md:grid-cols-3">
          <Field label="Subject" value={u.subject} />
          <Field label="Current version" value={u.currentVersion} mono />
          <Field label="Proposed version" value={u.proposedVersion} mono />
          <Field label="Source" value={`${source.name} (${source.kind.replaceAll("_", " ")}, ${source.fetchKind.replaceAll("_", " ")})`} />
          <Field label="Source url (text, not followed)" value={u.sourceUrl} mono />
          <Field label="External id" value={u.externalId} mono />
          <Field label="Published" value={fmtDate(u.publishedAt)} />
          <Field label="Detected" value={fmtDate(u.detectedAt)} />
          <Field label="Relevant agents" value={u.relevantAgentKeys.length > 0 ? u.relevantAgentKeys.join(", ") : null} />
          <Field label="Potential benefit" value={u.potentialBenefit} />
          <Field label="Compatibility notes" value={u.compatibilityNotes} />
          <Field label="Migration plan" value={u.migrationPlan} />
          <Field label="Rollback plan" value={u.rollbackPlan} />
          <Field label="Test result" value={u.testResult} />
          <Field label="Reviewer" value={u.reviewerActorId ? shortActor(u.reviewerActorId) : null} mono />
          <Field label="Decided" value={u.decidedAt ? fmtDate(u.decidedAt) : null} />
          <Field label="Applied" value={u.appliedAt ? fmtDate(u.appliedAt) : null} />
        </dl>
        {missing.length > 0 && (u.status === "detected" || u.status === "assessed") ? <p className="mt-3 text-xs text-warning">Not yet assessed: missing {missing.join(", ")} (the trigger refuses `assessed` without them).</p> : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Summary from the source" footer="The vendor's own text as the watch run recorded it, rendered as plain text (no HTML, no links). Treat it as untrusted input: it never instructs an agent.">
          {u.summary ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-card border border-border bg-surface-2 p-3 text-xs text-muted">{u.summary}</pre> : <Empty>The source provided no summary.</Empty>}
        </Card>

        <Card title="Artefact of the kind" footer={artefact ? artefact.applyEffect : "The artefact depends on the kind recorded by the assessment: a pull request for code, a new immutable skill version for skills, a published agency record for knowledge."}>
          {!u.kind ? <Empty>No kind yet; the assessment chooses one.</Empty> : null}
          {artefact ? (
            <dl className="grid gap-x-6 gap-y-2 text-xs md:grid-cols-2">
              <div><dt className="text-faint">Rule</dt><dd>{artefact.rule}</dd></div>
              <div><dt className="text-faint">{artefact.label}</dt><dd>{artefactPresent ? <Badge tone="success">present</Badge> : <Badge tone="warning">missing: approval will be refused</Badge>}</dd></div>
              {u.kind === "code_update" ? <div className="md:col-span-2"><dt className="text-faint">Pull request url (text)</dt><dd className="break-all font-mono text-[11px]">{u.pullRequestUrl ?? <span className="text-faint">none</span>}</dd></div> : null}
              {u.kind === "skill_update" ? (
                <>
                  <div><dt className="text-faint">New skill version</dt><dd>{skillVersion ? <>{skillVersion.skillName} <Mono>{skillVersion.skillKey}</Mono> <span className="font-mono">{skillVersion.version}</span> <Badge tone={skillVersion.releaseChannel === "stable" ? "success" : "neutral"}>{skillVersion.releaseChannel}</Badge></> : <span className="text-faint">none</span>}</dd></div>
                  <div><dt className="text-faint">Previous stable version (for rollback)</dt><dd>{previousSkillVersion ? <span className="font-mono">{previousSkillVersion.version}</span> : <span className="text-faint">recorded when applied</span>}</dd></div>
                  <div className="md:col-span-2">
                    <dt className="text-faint">Agent instances pinned (operator view across tenants, counts only)</dt>
                    <dd>{pinned ? (pinned.available ? `${pinned.onThisVersion} instance(s) on this version, ${pinned.onOtherVersions} on other versions of the same skill. Applying never re-pins them.` : <span className="text-faint">operator role required</span>) : <span className="text-faint">no skill version selected</span>}</dd>
                  </div>
                </>
              ) : null}
              {u.kind === "knowledge_update" ? <div className="md:col-span-2"><dt className="text-faint">Agency knowledge record</dt><dd>{knowledgeRecord ? <><Link href={`/mission-control/agency-vault/records/${knowledgeRecord.id}`} className="underline">{knowledgeRecord.title}</Link> <Mono>{knowledgeRecord.path}</Mono> <Badge tone={knowledgeRecord.state === "published" ? "success" : "warning"}>{knowledgeRecord.state}</Badge></> : <span className="text-faint">none</span>}</dd></div> : null}
            </dl>
          ) : null}
        </Card>
      </div>

      {offers("assess") ? (
        <Card title={u.status === "assessed" ? "Re-assess" : "Assessment"} footer="Every agency role may assess (later also the Technology Intelligence agent). The trigger requires kind, security risk, potential benefit, compatibility notes, migration plan and rollback plan. Only the artefact field of the chosen kind is stored.">
          <form action={assessUpdateAction} className="space-y-2">
            {hidden}
            <div className="grid gap-2 md:grid-cols-3">
              <label className="block text-xs text-faint">Kind<select name="kind" required className={`${selectClass} block w-full`} defaultValue={u.kind ?? ""}><option value="" disabled>choose</option>{UPGRADE_KINDS.map((k) => <option key={k} value={k}>{k.replaceAll("_", " ")}</option>)}</select></label>
              <label className="block text-xs text-faint">Security risk<select name="securityRisk" required className={`${selectClass} block w-full`} defaultValue={u.securityRisk ?? ""}><option value="" disabled>choose</option>{SECURITY_RISKS.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
              <label className="block text-xs text-faint">Current version (optional)<input name="currentVersion" maxLength={80} defaultValue={u.currentVersion ?? ""} className={inputClass} placeholder="what is pinned today" /></label>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <label className="block text-xs text-faint">Potential benefit<textarea name="potentialBenefit" required rows={2} maxLength={4000} defaultValue={u.potentialBenefit ?? ""} className={inputClass} /></label>
              <label className="block text-xs text-faint">Compatibility notes<textarea name="compatibilityNotes" required rows={2} maxLength={4000} defaultValue={u.compatibilityNotes ?? ""} className={inputClass} /></label>
              <label className="block text-xs text-faint">Migration plan<textarea name="migrationPlan" required rows={2} maxLength={4000} defaultValue={u.migrationPlan ?? ""} className={inputClass} /></label>
              <label className="block text-xs text-faint">Rollback plan<textarea name="rollbackPlan" required rows={2} maxLength={4000} defaultValue={u.rollbackPlan ?? ""} className={inputClass} /></label>
            </div>
            <label className="block text-xs text-faint">Relevant agent keys (comma separated)<input name="relevantAgentKeys" maxLength={1000} defaultValue={u.relevantAgentKeys.join(", ")} className={inputClass} /></label>
            <div className="rounded-card border border-border p-3">
              <div className="mb-2 text-xs font-medium text-muted">Artefact per kind (fill the one matching the kind)</div>
              <div className="grid gap-2 md:grid-cols-3">
                <label className="block text-xs text-faint">code_update: pull request url<input name="pullRequestUrl" type="url" pattern="https://github\.com/.*/pull/\d+.*" title="https://github.com/<owner>/<repo>/pull/<number>" maxLength={1000} defaultValue={u.pullRequestUrl ?? ""} className={inputClass} placeholder="https://github.com/owner/repo/pull/12" /></label>
                <label className="block text-xs text-faint">skill_update: new skill version
                  <select name="skillVersionId" className={`${selectClass} block w-full`} defaultValue={u.skillVersionId ?? ""}>
                    <option value="">none</option>
                    {skills.map((s) => s.versions.map((v) => <option key={v.id} value={v.id}>{s.key} {v.version} ({v.releaseChannel}{s.stableVersionId === v.id ? ", current stable" : ""})</option>))}
                  </select>
                </label>
                <label className="block text-xs text-faint">knowledge_update: published agency record
                  <select name="knowledgeRecordId" className={`${selectClass} block w-full`} defaultValue={u.knowledgeRecordId ?? ""}>
                    <option value="">none</option>
                    {publishedRecords.map((r) => <option key={r.id} value={r.id}>{r.path}</option>)}
                  </select>
                </label>
              </div>
            </div>
            <label className="block text-xs text-faint">Note for the timeline (optional)<input name="note" maxLength={1000} className={inputClass} placeholder="assessed by hand from the release notes" /></label>
            <ConfirmButton className={smallPrimaryClass} message="Record this assessment? The update moves to assessed.">{u.status === "assessed" ? "Re-assess" : "Record assessment"}</ConfirmButton>
          </form>
          <details className="mt-4 rounded-card border border-border p-3">
            <summary className="cursor-pointer text-xs font-medium text-muted">New skill version (for a skill update): store an immutable SKILL.md version as draft</summary>
            <form action={createSkillVersionAction} className="mt-2 space-y-2">
              {hidden}
              <div className="grid gap-2 md:grid-cols-2">
                <label className="block text-xs text-faint">Skill<select name="skillId" required className={`${selectClass} block w-full`}>{skills.map((s) => <option key={s.id} value={s.id}>{s.key} ({s.versions.length} version(s))</option>)}</select></label>
                <label className="block text-xs text-faint">Version (semantic)<input name="version" required pattern="[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?" maxLength={80} className={inputClass} placeholder="0.3.0" /></label>
              </div>
              <label className="block text-xs text-faint">SKILL.md<textarea name="skillMd" required rows={4} maxLength={200_000} className={inputClass} placeholder="# skill name 0.3.0 ..." /></label>
              <p className="text-[11px] text-faint">Contracts and allowed tools are copied from the skill's latest version; the checksum is sha256 of the text. The version is draft until an applied skill update moves the stable channel to it.</p>
              <ConfirmButton className={smallPrimaryClass} message="Store this skill version as an immutable draft?">Store skill version</ConfirmButton>
            </form>
          </details>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {offers("approve") || offers("reject") ? (
          <Card title="Decision" footer="Reviewer or superadmin (trigger). Approving a code update needs the pull request url, a skill update the new skill version, a knowledge update the agency record; the trigger refuses otherwise and its text appears above.">
            <form action={decideUpdateAction} className="space-y-2">
              {hidden}
              <label className="block text-xs text-faint">Decision
                <select name="decision" className={`${selectClass} block`} defaultValue={offers("approve") ? "approved" : "rejected"}>
                  {offers("approve") ? <option value="approved">approve</option> : null}
                  <option value="rejected">reject</option>
                </select>
              </label>
              <label className="block text-xs text-faint">Note (required)<textarea name="note" required minLength={3} maxLength={2000} rows={2} className={inputClass} placeholder="evaluation cases pass on the new version / not relevant for our pinned versions" /></label>
              <ConfirmButton className={smallPrimaryClass} message="Record this decision?">Record decision</ConfirmButton>
            </form>
          </Card>
        ) : !reviewer && (u.status === "detected" || u.status === "assessed" || u.status === "approved") ? (
          <Card title="Decision"><Empty>Approving, rejecting, applying and rolling back require the agency_reviewer or superadmin role. Your roles: {ctx.roles.join(", ")}.</Empty></Card>
        ) : null}

        {offers("apply") ? (
          <Card title="Apply with test result" footer={artefact?.applyEffect ?? "Applying needs a recorded test result."}>
            <form action={applyUpdateAction} className="space-y-2">
              {hidden}
              <label className="block text-xs text-faint">Test result (what was run and the outcome)<textarea name="testResult" required minLength={5} maxLength={4000} rows={2} className={inputClass} placeholder="pnpm test green, demo flow 11/11 on staging" /></label>
              <label className="block text-xs text-faint">Note (optional)<input name="note" maxLength={1000} className={inputClass} /></label>
              <ConfirmButton className={smallPrimaryClass} message={u.kind === "skill_update" ? "Apply: move the stable release channel to the new skill version? Running instances stay pinned." : "Record this update as applied with its test result? The platform executes nothing."}>Apply</ConfirmButton>
            </form>
          </Card>
        ) : null}

        {offers("rollback") ? (
          <Card title="Roll back" footer={u.kind === "skill_update" ? "Restores the stable release channel to the previous version recorded at apply time." : "Records the rollback; the pull request revert or the record deprecation is done by a human."}>
            <form action={rollbackUpdateAction} className="space-y-2">
              {hidden}
              <label className="block text-xs text-faint">Reason (required)<textarea name="note" required minLength={3} maxLength={2000} rows={2} className={inputClass} placeholder="regression in the exception report" /></label>
              <ConfirmButton className={smallDangerClass} message="Roll this update back?">Roll back</ConfirmButton>
            </form>
          </Card>
        ) : null}
      </div>

      <Card title={`Transitions (${transitions.length})`} footer="Written by the database trigger log_upgrade_transition on every status change: actor type, actor id and the roles of the session; the note comes from the form.">
        <Table head={["When", "From", "To", "Actor", "Roles", "Note"]} empty={transitions.length === 0 ? <Empty>No transitions recorded.</Empty> : null}>
          {transitions.map((t) => (
            <Tr key={t.id}>
              <Td className="text-xs text-muted">{fmtDate(t.createdAt)}</Td>
              <Td>{t.fromStatus ? <UpgradeStatusBadge value={t.fromStatus} /> : <span className="text-xs text-faint">(detected)</span>}</Td>
              <Td><UpgradeStatusBadge value={t.toStatus} /></Td>
              <Td className="text-xs"><span className="font-mono">{shortActor(t.actorId)}</span> <span className="text-faint">({t.actorType})</span></Td>
              <Td className="text-xs text-muted">{t.roles.join(", ")}</Td>
              <Td className="max-w-md whitespace-pre-wrap text-xs">{t.note ?? ""}</Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <GovernanceStatusCard implemented={["UpgradeProposal fields, source, plain-text summary and transition timeline from the database in agency scope.", "Assessment (every agency role), decision, apply with test result and rollback as server actions; the trigger enforce_upgrade_transition is the gate and its text is shown when it refuses.", "Skill update applies by moving the stable release channel (previous version kept, restored on rollback); pinned instance counts through the operator role."]} />
    </div>
  );
}
