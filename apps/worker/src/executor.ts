import { and, eq, sql } from "drizzle-orm";
import { schema, tenantContext, type DbHandle, type TenantContext, type Tx } from "@sbos/db";
import { RunFailure, appendRunEvent, assertWithinRunCap, checkBudget, estimateCostUsd, raiseIncident, recordCost, saveCheckpoint, setTaskState, transitionRun, type JobBackend } from "@sbos/core";
import { MastraAgentRuntime, SimulatedRuntime, ToolGateway, type AgentRuntime, type TenantSnapshot } from "@sbos/agents";
import type { WorkerEnv } from "./env";
import { log } from "./log";
import { OPERATOR } from "./platform";
import { flowFor } from "./flows";
import { assembleSnapshot } from "./flows/snapshot";
import type { BaseCheckpoint, FlowRuntime } from "./flows/types";

const { agentRuns, agentInstances, agentDefinitions, skillVersions, tenants } = schema;

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
 * Generic run executor. Loads the run, admits it (state, budget), then drives the flow registered for the
 * agent definition step by step. Every step persists a checkpoint; a crashed or redeployed worker resumes
 * from the last completed step without repeating model calls. Steps may suspend (approval, input).
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
  if (TERMINAL.includes(run.state)) return log("info", "run already terminal, skipping", { runId, state: run.state });
  if (run.state === "paused" || run.state === "waiting_for_approval" || run.state === "waiting_for_input") return log("info", "run not runnable in its current state, skipping", { runId, state: run.state });

  if (instance.state === "paused" || instance.state === "disabled") {
    await handle.withContext(ctx, async (tx) => {
      await transitionRun(tx, { tenantId, runId, to: "cancelled", summary: `cancelled: agent instance is ${instance.state}` });
      await raiseIncident(tx, jobs, { tenantId, kind: "admission_refused", severity: "low", title: "Run refused: agent instance paused or disabled", runId, agentInstanceId: instance.id });
    });
    return;
  }
  const flow = flowFor(definition.key);
  if (!flow) {
    await handle.withContext(ctx, async (tx) => {
      await transitionRun(tx, { tenantId, runId, to: "failed", summary: `no flow for definition ${definition.key}`, patch: { error: { code: "no_flow", message: definition.key } } });
      await raiseIncident(tx, jobs, { tenantId, kind: "worker_error", severity: "high", title: `No flow registered for agent definition ${definition.key}`, runId, agentInstanceId: instance.id, dedupeKey: `noflow:${definition.key}` });
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
  let checkpoint: BaseCheckpoint = (run.checkpoint as BaseCheckpoint | null) ?? flow.initial();

  const rt: FlowRuntime = {
    handle,
    env,
    jobs,
    ctx,
    gateway,
    simulated,
    model,
    runCapUsd: budget.runCapUsd,
    run: { id: run.id, taskId: run.taskId, scheduleId: run.scheduleId, state: run.state, attempt: run.attempt, checkpoint: run.checkpoint },
    instance: { id: instance.id, serviceIdentity: instance.serviceIdentity, model: instance.model, definitionId: instance.definitionId, state: instance.state, config: instance.config },
    definition: { id: definition.id, key: definition.key, name: definition.name, department: definition.department, defaultModel: definition.defaultModel, allowedTools: definition.allowedTools },
    skill: { id: skill.id, version: skill.version, skillMd: skill.skillMd, allowedTools: skill.allowedTools },
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, industry: tenant.industry, locale: tenant.locale, kind: tenant.kind },
    tx: <T,>(fn: (tx: Tx) => Promise<T>) => handle.withContext(ctx, fn),
    runtime: (fixture) => (simulated ? new SimulatedRuntime(() => fixture()) : new MastraAgentRuntime({ apiKey: env.anthropicApiKey!, model, agentId: `${definition.key}-${instance.id}` })) as AgentRuntime,
    async generate(g) {
      const projected = estimateCostUsd(model, Math.ceil((skill.skillMd.length + g.prompt.length) / 4), g.maxOutputTokens ?? 3000);
      assertWithinRunCap(projected, budget.runCapUsd);
      const runtime = rt.runtime(g.fixture);
      const r = await runtime.generateStructured({ instructions: skill.skillMd, prompt: g.prompt, schema: g.schema, maxOutputTokens: g.maxOutputTokens ?? 3000 });
      const cost = estimateCostUsd(r.model, r.usage.inputTokens, r.usage.outputTokens);
      await handle.withContext(ctx, async (tx) => {
        await recordCost(tx, { tenantId, runId, agentInstanceId: instance.id, taskId: run.taskId, model: r.model, tokensInput: r.usage.inputTokens, tokensOutput: r.usage.outputTokens, costUsd: cost, simulated: r.simulated });
        await tx.update(agentRuns).set({ tokensInput: sql`${agentRuns.tokensInput} + ${r.usage.inputTokens}`, tokensOutput: sql`${agentRuns.tokensOutput} + ${r.usage.outputTokens}`, costUsd: sql`${agentRuns.costUsd} + ${cost}`, simulated: r.simulated }).where(eq(agentRuns.id, runId));
        await appendRunEvent(tx, { tenantId, runId, kind: "model_call", summary: `${r.simulated ? "simulated model" : r.model}: ${g.summary}`, payload: { model: r.model, simulated: r.simulated }, classification: "confidential", tokensInput: r.usage.inputTokens, tokensOutput: r.usage.outputTokens, costUsd: cost, durationMs: r.durationMs });
      });
      return { object: r.object, simulated: r.simulated, model: r.model };
    },
    event: (kind, summary, payload, classification) => handle.withContext(ctx, (tx) => appendRunEvent(tx, { tenantId, runId, kind: kind as never, summary, payload, classification })),
    saveCheckpoint: (cp, summary) => handle.withContext(ctx, (tx) => saveCheckpoint(tx, tenantId, runId, cp, summary)),
    snapshot: (): Promise<TenantSnapshot> => handle.withContext(ctx, (tx) => assembleSnapshot(tx, ctx, gateway, { id: tenant.id, name: tenant.name, industry: tenant.industry, locale: tenant.locale, kind: tenant.kind }, runId))
  };

  const heartbeat = setInterval(() => {
    handle.withContext(ctx, (tx) => tx.update(agentRuns).set({ leaseExpiresAt: new Date(Date.now() + 90_000) }).where(eq(agentRuns.id, runId))).catch((err) => log("warn", "heartbeat failed", { runId, error: (err as Error).message }));
  }, 30_000);

  try {
    let guard = 0;
    while (checkpoint.step !== "done") {
      if (++guard > 50) throw new RunFailure("bug", "flow exceeded 50 steps");
      const step = flow.steps[checkpoint.step];
      if (!step) throw new RunFailure("bug", `unknown step ${checkpoint.step} in flow ${flow.key}`);
      const outcome = await step(rt, checkpoint);
      checkpoint = outcome.checkpoint;
      await rt.saveCheckpoint(checkpoint, `step ${checkpoint.step}`);
      if (outcome.kind === "suspend") {
        clearInterval(heartbeat);
        log("info", "run suspended", { runId, tenantId, reason: outcome.reason });
        return; // the resume job continues at checkpoint.step
      }
    }
    const final = await flow.finalize(rt, checkpoint);
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
        summary: final.summary,
        outputs: final.outputs,
        tools_used: gateway.list()
      };
      await transitionRun(tx, { tenantId, runId, to: "succeeded", summary: final.summary, patch: { result, summary: final.summary } });
      if (run.taskId) await setTaskState(tx, tenantId, run.taskId, "done");
    });
    log("info", "run succeeded", { runId, tenantId, flow: flow.key, simulated });
  } catch (err) {
    const failure = err instanceof RunFailure ? err : new RunFailure(classify(err), (err as Error).message);
    await handle.withContext(ctx, async (tx) => {
      await appendRunEvent(tx, { tenantId, runId, kind: "error", summary: `${failure.failureClass}: ${failure.message.slice(0, 200)}`, payload: { class: failure.failureClass, retryable: failure.retryable }, classification: "internal" });
      if (gateway.denied.length > 0) await appendRunEvent(tx, { tenantId, runId, kind: "tool_denied", summary: `denied tools: ${gateway.denied.join(", ")}` });
      if (failure.retryable) {
        await transitionRun(tx, { tenantId, runId, to: "interrupted", summary: "interrupted, will retry", patch: { error: { code: failure.failureClass, message: failure.message } } });
      } else {
        await transitionRun(tx, { tenantId, runId, to: "failed", summary: `failed: ${failure.failureClass}`, patch: { error: { code: failure.failureClass, message: failure.message, details: failure.details } } });
        await raiseIncident(tx, jobs, { tenantId, kind: failure.failureClass === "credential" ? "credential_invalid" : failure.failureClass === "policy" ? "tool_denied" : "run_failed", severity: "high", title: `Run failed (${failure.failureClass})`, details: { runId, class: failure.failureClass }, runId, agentInstanceId: instance.id });
        if (run.taskId) await setTaskState(tx, tenantId, run.taskId, "failed");
      }
    });
    log("error", "run failed", { runId, tenantId, class: failure.failureClass, retryable: failure.retryable });
    if (failure.retryable) throw err;
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
