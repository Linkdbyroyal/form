import { and, desc, eq, sql } from "drizzle-orm";
import { schema, tenantContext, writeAudit, type DbHandle, type TenantContext } from "@sbos/db";
import {
  RunFailure,
  appendRunEvent,
  assertWithinRunCap,
  checkBudget,
  estimateCostUsd,
  markActionExecuted,
  queueNotification,
  raiseIncident,
  recordCost,
  registerAction,
  requestApproval,
  saveCheckpoint,
  setTaskState,
  transitionRun,
  writeVaultDocument,
  type JobBackend
} from "@sbos/core";
import { MastraAgentRuntime, SimulatedRuntime, ToolGateway, discoveryFixture, runDiscoveryModelStep, type AgentRuntime, type DiscoveryContext } from "@sbos/agents";
import type { WorkerEnv } from "./env";
import { log } from "./log";
import { OPERATOR } from "./platform";

const { agentRuns, agentInstances, agentDefinitions, skillVersions, tenants, departments, systems, questions, interviewRounds, approvedActions, approvals, memberships } = schema;

type Step = "assemble_context" | "generate" | "persist" | "request_publication" | "publish" | "done";

interface Checkpoint {
  step: Step;
  roundId?: string;
  roundNumber?: number;
  context?: DiscoveryContext;
  draft?: unknown;
  contracts?: unknown[];
  questionIds?: string[];
  documentId?: string;
  actionId?: string;
  approvalId?: string;
  model?: string;
  simulated?: boolean;
}

export interface ExecuteInput {
  tenantId: string;
  runId: string;
  resume: boolean;
}

export interface PlatformBudget {
  capUsdMonth: number;
  spentUsdMonth: number;
  hardStop: boolean;
  runCapUsd: number;
}

const TERMINAL = ["succeeded", "failed", "cancelled", "timed_out"];

/**
 * Executes one run step by step. Every step is its own transaction; the checkpoint makes a crashed or
 * redeployed worker resume from the last completed step without repeating a model call.
 */
export async function executeRun(handle: DbHandle, env: WorkerEnv, jobs: JobBackend, platform: PlatformBudget | null, input: ExecuteInput): Promise<void> {
  const { tenantId, runId } = input;

  const loaded = await handle.withContext(tenantContext({ tenantId, actorType: "system", actorId: "worker:loader", roles: ["agent_service"] }), async (tx) => {
    const [run] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, tenantId)));
    if (!run) return null;
    const [instance] = await tx.select().from(agentInstances).where(eq(agentInstances.id, run.agentInstanceId));
    if (!instance) return null;
    const [definition] = await tx.select().from(agentDefinitions).where(eq(agentDefinitions.id, instance.definitionId));
    const skillVersionId = run.skillVersionId ?? instance.skillVersionId;
    const [skill] = skillVersionId ? await tx.select().from(skillVersions).where(eq(skillVersions.id, skillVersionId)) : [];
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId));
    return { run, instance, definition: definition ?? null, skill: skill ?? null, tenant: tenant ?? null };
  });
  if (!loaded) throw new RunFailure("bug", `run ${runId} not found for tenant ${tenantId}`);
  const { run, instance, definition, skill, tenant } = loaded;
  if (!definition || !skill || !tenant) throw new RunFailure("bug", "run is missing definition, skill version or tenant");

  const ctx: TenantContext = tenantContext({ tenantId, actorType: "agent", actorId: instance.serviceIdentity, roles: ["agent_service"] });

  if (TERMINAL.includes(run.state)) {
    log("info", "run already terminal, skipping", { runId, state: run.state });
    return;
  }
  if (run.state === "paused" || run.state === "waiting_for_approval" || run.state === "waiting_for_input") {
    log("info", "run not runnable in its current state, skipping", { runId, state: run.state });
    return;
  }

  if (instance.state === "paused" || instance.state === "disabled") {
    await handle.withContext(ctx, async (tx) => {
      await transitionRun(tx, { tenantId, runId, to: "cancelled", summary: `cancelled: agent instance is ${instance.state}` });
      await raiseIncident(tx, jobs, { tenantId, kind: "admission_refused", severity: "low", title: "Run refused: agent instance paused or disabled", runId, agentInstanceId: instance.id });
    });
    return;
  }
  const budget = await handle.withContext(ctx, (tx) => checkBudget(tx, { tenantId, agentInstanceId: instance.id, platform }));
  if (!budget.ok) {
    await handle.withContext(ctx, async (tx) => {
      await transitionRun(tx, { tenantId, runId, to: "failed", summary: "budget hard stop", patch: { error: { code: "budget_exceeded", ...budget.blockedBy } } });
      await raiseIncident(tx, jobs, { tenantId, kind: "budget_exceeded", severity: "high", title: `Budget cap reached (${budget.blockedBy?.scope})`, details: budget.blockedBy ?? {}, runId, agentInstanceId: instance.id, dedupeKey: `budget:${budget.blockedBy?.scope}:${tenantId}` });
    });
    return;
  }

  await handle.withContext(ctx, async (tx) => {
    await transitionRun(tx, { tenantId, runId, to: "running", summary: input.resume ? "resumed" : "started", patch: { attempt: run.state === "interrupted" ? run.attempt + 1 : run.attempt } });
    for (const w of budget.warnings) await appendRunEvent(tx, { tenantId, runId, kind: "note", summary: `budget warning: ${w}` });
  });

  const gateway = new ToolGateway(definition.allowedTools, skill.allowedTools);
  const model = instance.model ?? definition.defaultModel;
  const simulated = env.forceSimulated || !env.anthropicApiKey;
  let checkpoint: Checkpoint = (run.checkpoint as Checkpoint | null) ?? { step: "assemble_context" };

  const heartbeat = setInterval(() => {
    handle
      .withContext(ctx, (tx) => tx.update(agentRuns).set({ leaseExpiresAt: new Date(Date.now() + 90_000) }).where(eq(agentRuns.id, runId)))
      .catch((err) => log("warn", "heartbeat failed", { runId, error: (err as Error).message }));
  }, 30_000);

  try {
    while (checkpoint.step !== "done") {
      switch (checkpoint.step) {
        case "assemble_context": {
          checkpoint = await handle.withContext(ctx, async (tx) => {
            gateway.authorize("systems.read");
            gateway.authorize("questions.read");
            const deps = await tx.select({ key: departments.key, name: departments.name, headRole: departments.headRole }).from(departments);
            const sys = await tx.select({ name: systems.name, vendor: systems.vendor, function: systems.function, claimStatus: systems.claimStatus, apiCapabilities: systems.apiCapabilities, sourceOfTruthFor: systems.sourceOfTruthFor }).from(systems);
            const prior = await tx.select({ department: questions.department, question_text: questions.questionText, state: questions.state }).from(questions).where(sql`${questions.state} <> 'superseded'`);
            const [last] = await tx.select({ n: interviewRounds.roundNumber }).from(interviewRounds).orderBy(desc(interviewRounds.roundNumber)).limit(1);
            const roundNumber = (last?.n ?? 0) + 1;
            const [round] = await tx.insert(interviewRounds).values({ tenantId, runId, roundNumber, rationale: "pending" }).returning({ id: interviewRounds.id });
            const context: DiscoveryContext = {
              tenantId,
              company: { name: tenant.name, industry: tenant.industry, locale: tenant.locale, kind: tenant.kind },
              departments: deps,
              systems: sys.map((s) => ({ ...s, apiCapabilities: s.apiCapabilities as string[] })),
              priorQuestions: prior,
              roundNumber
            };
            await appendRunEvent(tx, { tenantId, runId, kind: "tool_call", summary: `read ${deps.length} departments, ${sys.length} systems, ${prior.length} prior questions`, payload: { tools: ["systems.read", "questions.read"] } });
            const next: Checkpoint = { step: "generate", roundId: round!.id, roundNumber, context, model, simulated };
            await saveCheckpoint(tx, tenantId, runId, next as unknown as Record<string, unknown>, "context assembled");
            return next;
          });
          break;
        }
        case "generate": {
          const context = checkpoint.context!;
          const runtime: AgentRuntime = simulated
            ? new SimulatedRuntime(() => discoveryFixture(context))
            : new MastraAgentRuntime({ apiKey: env.anthropicApiKey!, model, agentId: `discovery-${instance.id}` });
          const projected = estimateCostUsd(model, Math.ceil((skill.skillMd.length + JSON.stringify(context).length) / 4), 3000);
          assertWithinRunCap(projected, budget.runCapUsd);
          const out = await runDiscoveryModelStep(runtime, skill.skillMd, context, { agentInstanceId: instance.id, roundId: checkpoint.roundId! });
          const cost = estimateCostUsd(out.model, out.usage.inputTokens, out.usage.outputTokens);
          checkpoint = await handle.withContext(ctx, async (tx) => {
            await recordCost(tx, { tenantId, runId, agentInstanceId: instance.id, taskId: run.taskId, model: out.model, tokensInput: out.usage.inputTokens, tokensOutput: out.usage.outputTokens, costUsd: cost, simulated: out.simulated });
            await tx
              .update(agentRuns)
              .set({ tokensInput: sql`${agentRuns.tokensInput} + ${out.usage.inputTokens}`, tokensOutput: sql`${agentRuns.tokensOutput} + ${out.usage.outputTokens}`, costUsd: sql`${agentRuns.costUsd} + ${cost}`, simulated: out.simulated })
              .where(eq(agentRuns.id, runId));
            await appendRunEvent(tx, {
              tenantId,
              runId,
              kind: "model_call",
              summary: `${out.simulated ? "simulated model" : out.model}: ${out.contracts.length} questions drafted`,
              payload: { model: out.model, simulated: out.simulated, questionCount: out.contracts.length },
              classification: "confidential",
              tokensInput: out.usage.inputTokens,
              tokensOutput: out.usage.outputTokens,
              costUsd: cost,
              durationMs: out.durationMs
            });
            const next: Checkpoint = { ...checkpoint, step: "persist", draft: out.draft, contracts: out.contracts, simulated: out.simulated, model: out.model };
            await saveCheckpoint(tx, tenantId, runId, next as unknown as Record<string, unknown>, "questions drafted");
            return next;
          });
          break;
        }
        case "persist": {
          const draft = checkpoint.draft as { round_rationale: string; summary: string };
          const contracts = checkpoint.contracts as Array<{ question_id: string; department: string; recipient_role: string; question_text: string; reason: string; evidence_gap: string; priority: "critical" | "high" | "medium" | "low"; answer_type: string; options?: string[]; confidence: number }>;
          checkpoint = await handle.withContext(ctx, async (tx) => {
            gateway.authorize("questions.create");
            gateway.authorize("vault.write_draft");
            await tx.update(interviewRounds).set({ rationale: draft.round_rationale }).where(eq(interviewRounds.id, checkpoint.roundId!));
            const ids: string[] = [];
            for (const q of contracts) {
              const [row] = await tx
                .insert(questions)
                .values({ id: q.question_id, tenantId, roundId: checkpoint.roundId!, runId, department: q.department, recipientRole: q.recipient_role, questionText: q.question_text, reason: q.reason, evidenceGap: q.evidence_gap, priority: q.priority, answerType: q.answer_type, options: q.options ?? [], state: "draft", confidence: String(q.confidence), askedByAgentInstanceId: instance.id })
                .returning({ id: questions.id });
              ids.push(row!.id);
              await appendRunEvent(tx, { tenantId, runId, kind: "question_created", summary: `question drafted for ${q.department} (${q.priority})`, payload: { questionId: row!.id }, classification: "confidential" });
            }
            const path = `13_interviews_and_open_questions/round-${String(checkpoint.roundNumber).padStart(3, "0")}.md`;
            const body = [
              `# Discovery round ${checkpoint.roundNumber}`,
              "",
              `> Status: draft questions awaiting publication approval. Source: agent run ${runId}. ${checkpoint.simulated ? "Model: simulated (no API key)." : `Model: ${checkpoint.model}.`}`,
              "",
              "## Rationale",
              draft.round_rationale,
              "",
              "## Questions",
              ...contracts.map((q, i) => `${i + 1}. **[${q.priority}] ${q.department} to ${q.recipient_role}**: ${q.question_text}\n   - Why: ${q.reason}\n   - Evidence gap: ${q.evidence_gap}\n   - Answer type: ${q.answer_type}; confidence ${q.confidence}`)
            ].join("\n");
            const doc = await writeVaultDocument(tx, ctx, {
              tenantId,
              path,
              title: `Discovery round ${checkpoint.roundNumber}`,
              frontmatter: { round: checkpoint.roundNumber, run_id: runId, agent: definition.key, skill_version: skill.version, simulated: checkpoint.simulated, status: "draft", source_ids: [runId], confidence: 0.5, verification: "unconfirmed" },
              bodyMarkdown: body,
              classification: "confidential",
              verification: "unconfirmed",
              runId,
              changeNote: "Discovery agent draft"
            });
            await appendRunEvent(tx, { tenantId, runId, kind: "output_written", summary: `vault document written (v${doc.version})`, payload: { documentId: doc.documentId, path } });
            const next: Checkpoint = { ...checkpoint, step: "request_publication", questionIds: ids, documentId: doc.documentId };
            await saveCheckpoint(tx, tenantId, runId, next as unknown as Record<string, unknown>, "questions and vault note persisted");
            return next;
          });
          break;
        }
        case "request_publication": {
          // Publishing questions to client staff is communication to the client: T3, needs client_admin approval.
          await handle.withContext(ctx, async (tx) => {
            gateway.authorize("approvals.request");
            const actionId = await registerAction(tx, { tenantId, runId, actionType: "publish_questions", risk: "medium", payload: { questionIds: checkpoint.questionIds, roundId: checkpoint.roundId } });
            const next: Checkpoint = { ...checkpoint, step: "publish", actionId };
            await tx.update(agentRuns).set({ checkpoint: next as unknown as Record<string, unknown> }).where(eq(agentRuns.id, runId));
            const { approvalId } = await requestApproval(tx, ctx, {
              tenantId,
              runId,
              taskId: run.taskId,
              subjectType: "approved_action",
              subjectId: actionId,
              requestedBy: { actorType: "agent", actorId: instance.serviceIdentity },
              approverRole: "client_admin",
              risk: "medium",
              summary: `Publish ${checkpoint.questionIds?.length ?? 0} discovery questions (round ${checkpoint.roundNumber}) to department heads`,
              rationale: "Questions are sent to client staff; the client admin decides what reaches the organisation.",
              evidenceIds: []
            });
            await tx.update(approvedActions).set({ approvalId }).where(eq(approvedActions.id, actionId));
            await tx.update(agentRuns).set({ checkpoint: { ...next, approvalId } as unknown as Record<string, unknown> }).where(eq(agentRuns.id, runId));
            if (run.taskId) await setTaskState(tx, tenantId, run.taskId, "waiting_approval");
            const admins = await tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.tenantId, tenantId), eq(memberships.roleKey, "client_admin")));
            for (const a of admins) {
              await queueNotification(tx, jobs, { tenantId, channel: "email", template: "approval.requested", subject: "Approval requested: publish discovery questions", payload: { approvalId, tenantSlug: tenant.slug, runId }, recipientRole: "client_admin", recipientUserId: a.userId });
            }
            await queueNotification(tx, jobs, { tenantId, channel: "pumble", template: "approval.requested", subject: `Approval pending for ${tenant.slug}: publish discovery questions`, payload: { approvalId, tenantSlug: tenant.slug, runId } });
          });
          clearInterval(heartbeat);
          log("info", "run suspended for approval", { runId, tenantId });
          return; // The resume job continues at step "publish" after the decision.
        }
        case "publish": {
          checkpoint = await handle.withContext(ctx, async (tx) => {
            const [approval] = await tx.select().from(approvals).where(eq(approvals.id, checkpoint.approvalId!));
            if (!approval || approval.state !== "approved") throw new RunFailure("policy", `approval ${checkpoint.approvalId} is ${approval?.state ?? "missing"}`);
            // The database trigger is the real gate; this update throws if the approval is not approved.
            await markActionExecuted(tx, { tenantId, actionId: checkpoint.actionId!, result: { published: checkpoint.questionIds?.length ?? 0 } });
            await tx.update(questions).set({ state: "open" }).where(and(eq(questions.roundId, checkpoint.roundId!), eq(questions.state, "draft")));
            await appendRunEvent(tx, { tenantId, runId, kind: "output_written", summary: `${checkpoint.questionIds?.length ?? 0} questions published to Interview Inbox`, payload: { roundId: checkpoint.roundId } });
            await writeAudit(tx, ctx, { action: "questions.published", entityType: "interview_round", entityId: checkpoint.roundId ?? null, after: { count: checkpoint.questionIds?.length ?? 0, approvalId: checkpoint.approvalId } });
            const recipients = await tx.select({ userId: memberships.userId, role: memberships.roleKey }).from(memberships).where(and(eq(memberships.tenantId, tenantId), sql`${memberships.roleKey} in ('client_admin','department_manager')`));
            for (const r of recipients) {
              await queueNotification(tx, jobs, { tenantId, channel: "email", template: "questions.published", subject: "New discovery questions are waiting for you", payload: { roundId: checkpoint.roundId, tenantSlug: tenant.slug }, recipientRole: r.role, recipientUserId: r.userId });
            }
            const next: Checkpoint = { ...checkpoint, step: "done" };
            await saveCheckpoint(tx, tenantId, runId, next as unknown as Record<string, unknown>, "published");
            return next;
          });
          break;
        }
        default:
          throw new RunFailure("bug", `unknown step ${String(checkpoint.step)}`);
      }
    }

    const draft = checkpoint.draft as { summary?: string } | undefined;
    await handle.withContext(ctx, async (tx) => {
      const result = {
        tenant_id: tenantId,
        source_ids: [runId],
        confidence: 0.5,
        generated_at: new Date().toISOString(),
        review_status: "unreviewed",
        permissions_context: { tenant_id: tenantId, actor_type: "agent", actor_id: instance.serviceIdentity, roles: ["agent_service"], scopes: gateway.list(), cross_tenant_content_authorized: false },
        run_id: runId,
        agent_id: instance.id,
        status: "succeeded",
        summary: draft?.summary ?? "Discovery round completed",
        outputs: (checkpoint.questionIds ?? []).map((id) => ({ contract: "QuestionRequest", ref_id: id })),
        tools_used: gateway.list()
      };
      await transitionRun(tx, { tenantId, runId, to: "succeeded", summary: draft?.summary ?? "succeeded", patch: { result, summary: draft?.summary ?? "Discovery round completed" } });
      if (run.taskId) await setTaskState(tx, tenantId, run.taskId, "done");
    });
    log("info", "run succeeded", { runId, tenantId, simulated });
  } catch (err) {
    const failure = err instanceof RunFailure ? err : new RunFailure(classify(err), (err as Error).message);
    await handle.withContext(ctx, async (tx) => {
      await appendRunEvent(tx, { tenantId, runId, kind: "error", summary: `${failure.failureClass}: ${failure.message.slice(0, 200)}`, payload: { class: failure.failureClass, retryable: failure.retryable }, classification: "internal" });
      if (gateway.denied.length > 0) await appendRunEvent(tx, { tenantId, runId, kind: "tool_denied", summary: `denied tools: ${gateway.denied.join(", ")}` });
      if (failure.retryable) {
        await transitionRun(tx, { tenantId, runId, to: "interrupted", summary: "interrupted, will retry", patch: { error: { code: failure.failureClass, message: failure.message } } });
      } else {
        await transitionRun(tx, { tenantId, runId, to: "failed", summary: `failed: ${failure.failureClass}`, patch: { error: { code: failure.failureClass, message: failure.message, details: failure.details } } });
        await raiseIncident(tx, jobs, {
          tenantId,
          kind: failure.failureClass === "credential" ? "credential_invalid" : failure.failureClass === "policy" ? "tool_denied" : "run_failed",
          severity: "high",
          title: `Run failed (${failure.failureClass})`,
          details: { runId, class: failure.failureClass },
          runId,
          agentInstanceId: instance.id
        });
        if (run.taskId) await setTaskState(tx, tenantId, run.taskId, "failed");
      }
    });
    log("error", "run failed", { runId, tenantId, class: failure.failureClass, retryable: failure.retryable });
    if (failure.retryable) throw err; // pg-boss retries with backoff; exhausted retries land in dead-letter
  } finally {
    clearInterval(heartbeat);
  }
}

export function classify(err: unknown): RunFailure["failureClass"] {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  if (msg.includes("401") || msg.includes("authentication") || msg.includes("x-api-key") || msg.includes("api key")) return "credential";
  if (msg.includes("429") || msg.includes("overloaded") || msg.includes("timeout") || msg.includes("econnreset") || msg.includes("fetch failed") || msg.includes("503") || msg.includes("529")) return "model";
  if (msg.includes("not allowed")) return "policy";
  if (msg.includes("zod") || msg.includes("invalid")) return "validation";
  return "bug";
}

/** Marks runs whose worker died (lease expired) as interrupted and re-queues them. Called at startup and by stall.check. */
export async function recoverExpiredLeases(handle: DbHandle, jobs: JobBackend): Promise<number> {
  const stale = await handle.withContext(OPERATOR, (tx) => tx.select({ id: agentRuns.id, tenantId: agentRuns.tenantId }).from(agentRuns).where(and(eq(agentRuns.state, "running"), sql`${agentRuns.leaseExpiresAt} < now()`)));
  for (const r of stale) {
    const ctx = tenantContext({ tenantId: r.tenantId, actorType: "system", actorId: "worker:recovery", roles: ["agent_service"] });
    await handle.withContext(ctx, async (tx) => {
      await transitionRun(tx, { tenantId: r.tenantId, runId: r.id, to: "interrupted", summary: "lease expired, recovering" });
      await raiseIncident(tx, jobs, { tenantId: r.tenantId, kind: "lease_expired", severity: "medium", title: "Run lease expired; re-queued from checkpoint", runId: r.id, dedupeKey: `lease:${r.id}` });
      await jobs.enqueue("agent.resume", { tenantId: r.tenantId, runId: r.id, reason: "recovery" }, { singletonKey: `resume:${r.id}` });
    });
  }
  return stale.length;
}

/** Called by the dead-letter consumer: a job exhausted its retries. */
export async function failRunFromDeadLetter(handle: DbHandle, jobs: JobBackend, tenantId: string, runId: string, reason: string): Promise<void> {
  const ctx = tenantContext({ tenantId, actorType: "system", actorId: "worker:dead-letter", roles: ["agent_service"] });
  await handle.withContext(ctx, async (tx) => {
    const [run] = await tx.select({ state: agentRuns.state, taskId: agentRuns.taskId, agentInstanceId: agentRuns.agentInstanceId }).from(agentRuns).where(eq(agentRuns.id, runId));
    if (!run || TERMINAL.includes(run.state)) return;
    await transitionRun(tx, { tenantId, runId, to: "failed", summary: "dead-letter: retries exhausted", patch: { error: { code: "dead_letter", message: reason.slice(0, 500) } } });
    await raiseIncident(tx, jobs, { tenantId, kind: "dead_letter", severity: "high", title: "Run moved to dead-letter after retries", details: { runId }, runId, agentInstanceId: run.agentInstanceId });
    if (run.taskId) await setTaskState(tx, tenantId, run.taskId, "failed");
  });
}
