/* Second Brain OS: synthetic fleet simulation for the Live Agent Mission Control proposals.
 * Synthetic data only (no client content). Vocabulary mirrors the real schema (packages/db/src/schema/agents.ts):
 * run_state, run_event_kind, task_state, approval_state, incident_kind, agent_state, pg-boss queue names.
 * The same engine powers proposals A, B and C; each proposal only renders it differently.
 */
(function (global) {
  "use strict";

  function prng(seed) {
    let s = seed >>> 0 || 1;
    return function () {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return (s % 100000) / 100000;
    };
  }

  const CLIENTS = [
    { id: "c1", slug: "northline-events", name: "Northline Events", industry: "Event rental", locale: "nl", connections: ["rentman"], live: true },
    { id: "c2", slug: "harbour-view-hotel", name: "Harbour View Hotel", industry: "Hospitality", locale: "en", connections: ["quickbooks"], live: false },
    { id: "c3", slug: "meridian-logistics", name: "Meridian Logistics", industry: "Transport", locale: "nl", connections: [], live: false }
  ];

  const DEFINITIONS = [
    { key: "discovery-interview", name: "Discovery", role: "Evidence-gap interviewer", tier: "t1", tools: ["vault.search", "facts.read", "questions.draft"] },
    { key: "finance-agent", name: "Finance", role: "Finance findings", tier: "t2", tools: ["vault.search", "kpi.read", "connector.read", "findings.write"] },
    { key: "operations-agent", name: "Operations", role: "Operations findings", tier: "t2", tools: ["vault.search", "kpi.read", "findings.write"] },
    { key: "process-redesign", name: "Process Redesign", role: "Redesign proposals", tier: "t2", tools: ["vault.search", "facts.read", "proposal.write", "knowledge.nominate"] },
    { key: "ceo-intelligence", name: "CEO Intelligence", role: "Opportunity synthesis", tier: "t2", tools: ["findings.read", "kpi.read", "opportunity.write"] },
    { key: "executive-briefing", name: "Executive Briefing", role: "Weekly briefing", tier: "t1", tools: ["findings.read", "kpi.read", "briefing.write", "notify.queue"] },
    { key: "performance-agent", name: "Performance", role: "Action verification", tier: "t3", tools: ["kpi.read", "actions.read", "actions.verify"] }
  ];

  const WORKERS = [
    { queue: "agent.run", label: "Agent runs", kind: "job" },
    { queue: "agent.resume", label: "Resumes after approval", kind: "job" },
    { queue: "schedule.tick", label: "Schedule ticks", kind: "schedule" },
    { queue: "connector.sync", label: "Connector syncs (read-only)", kind: "job" },
    { queue: "notify.send", label: "Notifications", kind: "job" },
    { queue: "tech.watch", label: "Tech Watch (daily 06:00 UTC)", kind: "schedule" },
    { queue: "retention.sweep", label: "Retention sweep (Sunday 03:00 UTC)", kind: "schedule" }
  ];

  const STEPS = {
    "discovery-interview": ["assemble_context", "retrieve_facts", "draft_questions", "validate_contracts", "persist_round", "request_approval", "publish"],
    "finance-agent": ["assemble_context", "read_kpis", "analyse", "write_findings", "request_approval", "publish"],
    "operations-agent": ["assemble_context", "read_kpis", "analyse", "write_findings", "publish"],
    "process-redesign": ["assemble_context", "retrieve_facts", "design", "validate_contracts", "write_proposal", "nominate_insight", "request_approval", "publish"],
    "ceo-intelligence": ["assemble_context", "read_findings", "synthesise", "write_opportunities", "publish"],
    "executive-briefing": ["assemble_context", "read_findings", "compose", "write_briefing", "queue_notification", "publish"],
    "performance-agent": ["assemble_context", "read_actions", "verify", "record_result", "publish"]
  };

  const MODELS = ["claude-sonnet-5-5"];
  const PRICE_IN = 3 / 1e6, PRICE_OUT = 15 / 1e6;

  function createSim(options) {
    const opts = Object.assign({ seed: 7, startAt: Date.now() - 42 * 60000, speed: 1 }, options || {});
    const rnd = prng(opts.seed);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    let eventSeq = 0, runSeq = 0, approvalSeq = 0, incidentSeq = 0, taskSeq = 0, questionSeq = 0;
    const listeners = new Set();
    const now = () => state.clock;

    const state = {
      clock: opts.startAt,
      clients: CLIENTS,
      definitions: DEFINITIONS,
      agents: [],
      runs: [],
      events: [],
      approvals: [],
      tasks: [],
      incidents: [],
      questions: [],
      schedules: [],
      workers: WORKERS.map((w) => ({ ...w, active: 0, queued: 0, completed: 0, failed: 0, lastAt: null })),
      edges: [],
      costs: { monthCapUsd: 25, monthUsd: 0, byClient: {}, byAgent: {} },
      platform: { mode: "live", model: MODELS[0], concurrency: 4, replicas: 2, workerStartedAt: opts.startAt - 6 * 3600000, instance: "worker-b14e@railway" }
    };

    for (const c of CLIENTS) {
      for (const d of DEFINITIONS) {
        state.agents.push({ id: `${c.id}-${d.key}`, clientId: c.id, definitionKey: d.key, name: d.name, role: d.role, tier: d.tier, tools: d.tools, state: "idle", currentRunId: null, lastActivityAt: opts.startAt - Math.floor(rnd() * 6 * 3600000), skillVersion: d.key === "process-redesign" ? "0.2.0" : "0.1.0", runsToday: Math.floor(rnd() * 4), failuresToday: 0 });
      }
      state.schedules.push({ id: `s-${c.id}-discovery`, clientId: c.id, definitionKey: "discovery-interview", cron: "0 7 * * 1-5", tz: "UTC", enabled: true, nextAt: nextWeekday7(opts.startAt), lastOutcome: "succeeded", misfire: "run_once_late" });
      state.schedules.push({ id: `s-${c.id}-briefing`, clientId: c.id, definitionKey: "executive-briefing", cron: "0 6 * * 1", tz: "UTC", enabled: c.id !== "c3", nextAt: nextMonday6(opts.startAt), lastOutcome: c.id === "c2" ? "missed_schedule" : "succeeded", misfire: "skip" });
      state.costs.byClient[c.id] = 0;
    }
    state.schedules.push({ id: "s-platform-techwatch", clientId: null, definitionKey: "tech.watch", cron: "0 6 * * *", tz: "UTC", enabled: true, nextAt: nextDaily6(opts.startAt), lastOutcome: "succeeded", misfire: "skip" });
    state.schedules.push({ id: "s-platform-retention", clientId: null, definitionKey: "retention.sweep", cron: "0 3 * * 0", tz: "UTC", enabled: true, nextAt: nextSunday3(opts.startAt), lastOutcome: "succeeded", misfire: "skip" });

    function nextWeekday7(t) { const d = new Date(t); d.setUTCHours(7, 0, 0, 0); if (d.getTime() <= t) d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1); return d.getTime(); }
    function nextMonday6(t) { const d = new Date(t); d.setUTCHours(6, 0, 0, 0); do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 1); return d.getTime(); }
    function nextDaily6(t) { const d = new Date(t); d.setUTCHours(6, 0, 0, 0); if (d.getTime() <= t) d.setUTCDate(d.getUTCDate() + 1); return d.getTime(); }
    function nextSunday3(t) { const d = new Date(t); d.setUTCHours(3, 0, 0, 0); do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 0); return d.getTime(); }

    const agentById = (id) => state.agents.find((a) => a.id === id);
    const runById = (id) => state.runs.find((r) => r.id === id);
    const clientById = (id) => CLIENTS.find((c) => c.id === id);

    function emit(run, kind, payload, extra) {
      const ev = Object.assign({ id: ++eventSeq, at: now(), runId: run ? run.id : null, agentId: run ? run.agentId : null, clientId: run ? run.clientId : null, kind, payload: payload || {} }, extra || {});
      state.events.push(ev);
      if (state.events.length > 4000) state.events.splice(0, state.events.length - 4000);
      if (run) { run.events.push(ev.id); run.lastEventAt = ev.at; }
      return ev;
    }

    function edge(from, to, kind, label) {
      state.edges.push({ id: ++eventSeq, at: now(), from, to, kind, label });
      if (state.edges.length > 120) state.edges.splice(0, state.edges.length - 120);
    }

    function worker(queue, delta) {
      const w = state.workers.find((x) => x.queue === queue);
      if (!w) return;
      Object.assign(w, delta(w));
      w.lastAt = now();
    }

    function setRunState(run, next, reason) {
      const prev = run.state;
      run.state = next;
      emit(run, "state_change", { from: prev, to: next, reason: reason || "" });
      const agent = agentById(run.agentId);
      if (agent) {
        agent.lastActivityAt = now();
        if (next === "running") agent.state = "running";
        else if (next === "waiting_for_approval" || next === "waiting_for_input") agent.state = "blocked";
        else if (next === "paused") agent.state = "paused";
        else if (next === "failed" || next === "timed_out") { agent.state = "error"; agent.failuresToday += 1; agent.currentRunId = null; }
        else if (next === "succeeded" || next === "cancelled") { agent.state = "idle"; agent.currentRunId = null; agent.runsToday += 1; }
      }
    }

    function startRun(agentId, trigger, taskTitle, options) {
      const agent = agentById(agentId);
      if (!agent || agent.currentRunId) return null;
      const client = clientById(agent.clientId);
      const def = DEFINITIONS.find((d) => d.key === agent.definitionKey);
      const task = { id: `T-${++taskSeq}`, clientId: client.id, agentId, title: taskTitle || `${def.name} run for ${client.name}`, state: "in_progress", priority: pick(["high", "medium", "medium", "low"]), createdAt: now(), department: pick(["finance", "operations", "sales", "management"]) };
      state.tasks.push(task);
      const run = { id: `R-${String(++runSeq).padStart(4, "0")}`, agentId, clientId: client.id, taskId: task.id, definitionKey: def.key, trigger, state: "queued", stepIndex: 0, steps: STEPS[def.key], startedAt: now(), lastEventAt: now(), events: [], toolCalls: 0, modelCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, attempt: 1, checkpoint: null, instructions: [], plan: options && options.plan ? options.plan : {}, output: null, failure: null, leaseUntil: now() + 90000 };
      state.runs.push(run);
      agent.currentRunId = run.id;
      emit(run, "state_change", { from: null, to: "queued", trigger });
      worker("agent.run", (w) => ({ queued: w.queued + 1 }));
      edge("orchestrator", agentId, "dispatch", trigger === "schedule" ? "schedule.tick" : trigger);
      return run;
    }

    function advance(run) {
      if (run.state === "queued") {
        worker("agent.run", (w) => ({ queued: Math.max(0, w.queued - 1), active: w.active + 1 }));
        setRunState(run, "running", "lease acquired");
        emit(run, "step_started", { step: run.steps[run.stepIndex] });
        run.ticksLeft = stepTicks(run.steps[run.stepIndex]);
        return;
      }
      if (run.state !== "running") return;
      const step = run.steps[run.stepIndex];
      // Steps take time: model steps several ticks, persistence steps one. A heartbeat keeps the lease fresh.
      if (run.ticksLeft > 0) { run.ticksLeft -= 1; run.leaseUntil = now() + 90000; const agent0 = agentById(run.agentId); if (agent0) agent0.lastActivityAt = now(); return; }
      const agent = agentById(run.agentId);
      const client = clientById(run.clientId);
      // Planned failure or input wait on this step?
      if (run.plan.failAt === step && !run.failure) {
        run.failure = run.plan.failure || "model_timeout";
        if (run.failure === "tool_denied") {
          emit(run, "tool_denied", { tool: run.plan.tool || "connector.write", reason: "tool not in the skill version's allow-list (ToolGateway)" });
        }
        emit(run, "error", { class: run.failure, message: run.failure === "model_timeout" ? "model call exceeded 60 s; attempt 1 of 3" : run.failure === "budget_exceeded" ? "tenant budget cap reached (USD 5.00/day)" : run.failure === "tool_denied" ? "run aborted after a denied tool call" : "unexpected error in step " + step });
        worker("agent.run", (w) => ({ active: Math.max(0, w.active - 1), failed: w.failed + 1 }));
        setRunState(run, run.failure === "model_timeout" && run.attempt < 3 ? "queued" : "failed", run.failure);
        if (run.state === "queued") { run.attempt += 1; run.failure = null; run.plan.failAt = null; worker("agent.run", (w) => ({ queued: w.queued + 1 })); emit(run, "note", { text: `retry ${run.attempt} of 3 with backoff` }); }
        else {
          const inc = { id: `INC-${++incidentSeq}`, clientId: run.clientId, kind: run.failure === "budget_exceeded" ? "budget_exceeded" : "run_failed", severity: run.failure === "tool_denied" ? "critical" : "high", title: `${agent.name} run ${run.id} failed: ${run.failure}`, runId: run.id, state: "open", createdAt: now() };
          state.incidents.push(inc);
          edge(run.agentId, "incidents", "incident", inc.kind);
          const task = state.tasks.find((t) => t.id === run.taskId); if (task) task.state = "failed";
        }
        return;
      }
      // Tool and model activity for this step.
      const toolsForStep = {
        assemble_context: ["vault.search", "facts.read"], retrieve_facts: ["facts.read"], read_kpis: ["kpi.read", client.connections[0] ? "connector.read" : null], read_findings: ["findings.read"], read_actions: ["actions.read"],
        draft_questions: ["model"], analyse: ["model"], design: ["model"], synthesise: ["model"], compose: ["model"], verify: ["model", "kpi.read"],
        validate_contracts: ["contract.validate"], persist_round: ["vault.write"], write_findings: ["findings.write"], write_proposal: ["proposal.write"], write_opportunities: ["opportunity.write"], write_briefing: ["briefing.write"], record_result: ["actions.verify"],
        nominate_insight: ["knowledge.nominate"], queue_notification: ["notify.queue"], request_approval: ["approval.request"], publish: ["vault.write"]
      }[step] || [];
      for (const tool of toolsForStep.filter(Boolean)) {
        if (tool === "model") {
          const tin = 1800 + Math.floor(rnd() * 2600), tout = 500 + Math.floor(rnd() * 1600);
          const cost = tin * PRICE_IN + tout * PRICE_OUT;
          run.modelCalls += 1; run.tokensIn += tin; run.tokensOut += tout; run.costUsd += cost;
          state.costs.monthUsd += cost; state.costs.byClient[run.clientId] += cost; state.costs.byAgent[run.agentId] = (state.costs.byAgent[run.agentId] || 0) + cost;
          emit(run, "model_call", { model: state.platform.model, tokensIn: tin, tokensOut: tout, costUsd: Number(cost.toFixed(4)), durationMs: 2200 + Math.floor(rnd() * 9000), summary: stepSummary(step, agent, client) });
          edge(run.agentId, "model", "model_call", state.platform.model);
        } else {
          run.toolCalls += 1;
          const target = tool.startsWith("vault") || tool.startsWith("facts") || tool.startsWith("findings") || tool.startsWith("proposal") || tool.startsWith("opportunity") || tool.startsWith("briefing") ? "vault" : tool.startsWith("kpi") || tool.startsWith("actions") ? "xray" : tool.startsWith("connector") ? "connector:" + client.connections[0] : tool === "knowledge.nominate" ? "agency-vault" : tool === "notify.queue" ? "notifications" : tool === "approval.request" ? "approvals" : "platform";
          emit(run, "tool_call", { tool, target, durationMs: 40 + Math.floor(rnd() * 900), result: toolResult(tool, client, rnd) });
          edge(run.agentId, target, "tool_call", tool);
          if (tool === "knowledge.nominate") edge(run.agentId, "agency-vault", "nomination", "reusable insight");
        }
      }
      emit(run, "step_finished", { step, durationMs: 300 + Math.floor(rnd() * 4000) });
      run.checkpoint = { step: run.steps[run.stepIndex + 1] || "done", savedAt: now() };
      emit(run, "checkpoint", { step: run.checkpoint.step });
      if (step === "request_approval") {
        const approval = { id: `AP-${++approvalSeq}`, clientId: run.clientId, agentId: run.agentId, runId: run.id, kind: approvalKind(run.definitionKey), risk: pick(["medium", "medium", "high", "low"]), summary: approvalSummary(run.definitionKey, client), state: "pending", requestedAt: now(), approverRole: run.definitionKey === "process-redesign" ? "agency_operator" : "client_admin", decidedBy: null, decidedAt: null, evidence: evidenceFor(run.definitionKey, client, rnd) };
        state.approvals.push(approval);
        emit(run, "approval_requested", { approvalId: approval.id, risk: approval.risk, approverRole: approval.approverRole });
        edge(run.agentId, "human", "approval_requested", approval.approverRole);
        worker("agent.run", (w) => ({ active: Math.max(0, w.active - 1) }));
        setRunState(run, "waiting_for_approval", approval.id);
        const task = state.tasks.find((t) => t.id === run.taskId); if (task) task.state = "waiting_approval";
        run.stepIndex += 1;
        return;
      }
      if (run.plan.askAt === step) {
        const q = { id: `Q-${++questionSeq}`, clientId: run.clientId, runId: run.id, agentId: run.agentId, department: pick(["finance", "operations"]), text: run.plan.question || "Which system is the source of truth for returned equipment?", priority: "high", state: "open", createdAt: now() };
        state.questions.push(q);
        emit(run, "question_created", { questionId: q.id, department: q.department, priority: q.priority });
        edge(run.agentId, "human", "question", q.department);
        worker("agent.run", (w) => ({ active: Math.max(0, w.active - 1) }));
        setRunState(run, "waiting_for_input", q.id);
        const task = state.tasks.find((t) => t.id === run.taskId); if (task) task.state = "waiting_input";
        run.plan.askAt = null;
        run.stepIndex += 1;
        return;
      }
      run.stepIndex += 1;
      run.ticksLeft = run.stepIndex < run.steps.length ? stepTicks(run.steps[run.stepIndex]) : 0;
      if (run.stepIndex >= run.steps.length) {
        run.output = outputFor(run.definitionKey, client, run, rnd);
        emit(run, "note", { text: run.output.title });
        worker("agent.run", (w) => ({ active: Math.max(0, w.active - 1), completed: w.completed + 1 }));
        setRunState(run, "succeeded", "flow finalised");
        run.finishedAt = now();
        const task = state.tasks.find((t) => t.id === run.taskId); if (task) task.state = "done";
        if (run.definitionKey === "executive-briefing") { worker("notify.send", (w) => ({ queued: w.queued + 1 })); }
      } else {
        emit(run, "step_started", { step: run.steps[run.stepIndex] });
      }
    }

    function stepTicks(step) { return ["draft_questions", "analyse", "design", "synthesise", "compose", "verify"].includes(step) ? 3 + Math.floor(rnd() * 4) : ["assemble_context", "retrieve_facts", "read_kpis", "read_findings"].includes(step) ? 1 + Math.floor(rnd() * 2) : 1; }
    function approvalKind(key) { return { "discovery-interview": "publish_questions", "finance-agent": "publish_findings", "process-redesign": "publish_proposal" }[key] || "publish"; }
    function approvalSummary(key, client) {
      return { "discovery-interview": `5 intake questions for ${client.name} (1 critical, 3 high, 1 medium); none repeats an answered question`, "finance-agent": `3 findings on invoicing lead time for ${client.name}; evidence from 2 KPIs and 4 facts`, "process-redesign": `Proposal: project closure checklist with invoice trigger (${client.name}); reusable insight nominated` }[key] || "Publish result";
    }
    function evidenceFor(key, client, r) {
      const base = [{ kind: "kpi", ref: "closed_projects_not_invoiced", value: `${3 + Math.floor(r() * 5)} projects`, source: client.connections[0] || "intake (stated)" }, { kind: "fact", ref: "F-" + (120 + Math.floor(r() * 80)), value: "Invoices are issued by the office on Fridays (verified)", source: "interview round 3" }];
      if (key === "process-redesign") base.push({ kind: "document", ref: "16_process_redesign/project-closure.md", value: "v2 draft", source: "vault" });
      return base;
    }
    function toolResult(tool, client, r) {
      return { "vault.search": `${2 + Math.floor(r() * 7)} documents`, "facts.read": `${8 + Math.floor(r() * 30)} facts (${Math.floor(r() * 4)} unverified)`, "kpi.read": `${2 + Math.floor(r() * 3)} KPIs`, "connector.read": `${client.connections[0] || "sandbox"}: ${40 + Math.floor(r() * 90)} records (read-only)`, "findings.read": `${1 + Math.floor(r() * 4)} findings`, "actions.read": `${1 + Math.floor(r() * 3)} actions`, "contract.validate": "ok", "vault.write": "1 document, 1 revision", "findings.write": "3 findings", "proposal.write": "1 proposal", "opportunity.write": "2 opportunities", "briefing.write": "1 briefing", "actions.verify": "verified", "knowledge.nominate": "1 nomination (pending review)", "notify.queue": "1 e-mail queued", "approval.request": "approval created" }[tool] || "ok";
    }
    function stepSummary(step, agent, client) {
      return { draft_questions: `${agent.name} drafted 5 questions for ${client.name}; contradiction found between intake and QuickBooks status`, analyse: `${agent.name} compared invoicing lead time with the previous period`, design: `${agent.name} drafted a closure checklist with an invoice trigger`, synthesise: `${agent.name} ranked 2 opportunities by expected margin impact`, compose: `${agent.name} composed the weekly briefing from 4 findings`, verify: `${agent.name} checked the action against the KPI trend` }[step] || `${agent.name} completed ${step}`;
    }
    function outputFor(key, client, run, r) {
      return { "discovery-interview": { title: `Interview round published: 5 questions for ${client.name}`, path: "13_interviews_and_open_questions/round-007.md" }, "finance-agent": { title: `3 finance findings published for ${client.name}`, path: "14_findings_and_evidence/finance-2026-11-11.md" }, "operations-agent": { title: `2 operations findings published for ${client.name}`, path: "14_findings_and_evidence/operations-2026-11-11.md" }, "process-redesign": { title: `Process proposal published: project closure checklist (${client.name})`, path: "16_process_redesign/project-closure.md" }, "ceo-intelligence": { title: `2 opportunities ranked for ${client.name}`, path: "17_opportunities/2026-11-11.md" }, "executive-briefing": { title: `Weekly briefing sent to the CEO of ${client.name}`, path: "18_briefings/week-46.md" }, "performance-agent": { title: `Action verified: invoice reminder cadence (${client.name})`, path: "19_history_and_archive/action-verification.md" } }[key];
    }

    // Scenario: six concurrent runs, planned failures, waits and completions over the first minutes.
    const scenario = [
      { at: -40 * 60000, agent: "c1-discovery-interview", trigger: "schedule", plan: {} },
      { at: -38 * 60000, agent: "c1-finance-agent", trigger: "schedule", plan: { askAt: "analyse", question: "Are the 4 returned projects without invoice intentionally on hold?" } },
      { at: -31 * 60000, agent: "c2-discovery-interview", trigger: "command", plan: {} },
      { at: -22 * 60000, agent: "c3-discovery-interview", trigger: "schedule", plan: { failAt: "draft_questions", failure: "model_timeout" } },
      { at: -9 * 60000, agent: "c1-process-redesign", trigger: "command", plan: {} },
      { at: -6 * 60000, agent: "c2-finance-agent", trigger: "schedule", plan: { failAt: "read_kpis", failure: "tool_denied", tool: "connector.write" } },
      { at: -3 * 60000, agent: "c1-ceo-intelligence", trigger: "event", plan: {} },
      { at: -2 * 60000, agent: "c2-operations-agent", trigger: "command", plan: {} },
      { at: -1 * 60000, agent: "c3-executive-briefing", trigger: "schedule", plan: { failAt: "compose", failure: "budget_exceeded" } },
      { at: -5 * 60000, agent: "c1-performance-agent", trigger: "schedule", plan: {} },
      { at: -4 * 60000, agent: "c3-operations-agent", trigger: "command", plan: {} },
      { at: -4 * 60000, agent: "c2-ceo-intelligence", trigger: "event", plan: {} },
      { at: -3 * 60000, agent: "c1-executive-briefing", trigger: "schedule", plan: {} },
      { at: -2 * 60000, agent: "c3-process-redesign", trigger: "command", plan: {} },
      { at: -2 * 60000, agent: "c2-performance-agent", trigger: "schedule", plan: {} },
      { at: -1 * 60000, agent: "c3-finance-agent", trigger: "command", plan: { askAt: "analyse", question: "Which ledger holds subcontractor costs after the Moneybird switch?" } },
      { at: -1 * 60000, agent: "c1-operations-agent", trigger: "schedule", plan: {} }
    ];
    // After the script: the orchestrator keeps the fleet busy (schedules, events, commands) so the demo never goes quiet.
    let autoTick = 0;
    function autoSchedule() {
      autoTick += 1;
      // Client admins decide older approvals and answer questions in their own workspace from time to time.
      if (autoTick % 4 === 0) {
        const old = state.approvals.filter((a) => a.state === "pending" && now() - a.requestedAt > 8 * 60000);
        if (old.length > 2 && rnd() < 0.5) { const a = old[0]; if (rnd() < 0.85) actions.approve(a.id, "client_admin"); else actions.reject(a.id, "client_admin", "not now"); }
        const oldQ = state.questions.filter((q) => q.state === "open" && now() - q.createdAt > 10 * 60000);
        if (oldQ.length > 1 && rnd() < 0.4) actions.answer(oldQ[0].id, "Answered in the client workspace");
      }
      if (autoTick % 2 !== 0) return;
      const active = state.runs.filter((r) => ["running", "queued"].includes(r.state)).length;
      if (active >= 9) return;
      const idle = state.agents.filter((a) => !a.currentRunId && a.state !== "error");
      if (idle.length === 0) return;
      const a = idle[Math.floor(rnd() * idle.length)];
      const roll = rnd();
      const plan = roll < 0.12 ? { failAt: a.definitionKey === "discovery-interview" ? "draft_questions" : "analyse", failure: pick(["model_timeout", "model_timeout", "budget_exceeded", "tool_denied"]) } : roll < 0.2 && a.definitionKey === "finance-agent" ? { askAt: "analyse" } : {};
      const trigger = pick(["schedule", "schedule", "event", "command"]);
      startRun(a.id, trigger, null, { plan });
      if (trigger === "schedule") worker("schedule.tick", (w) => ({ completed: w.completed + 1 }));
    }
    let scenarioIdx = 0;
    const t0 = opts.startAt;

    // Fast-forward: replay history up to "now" deterministically so the page opens in a realistic state.
    function fastForward(toClock) {
      while (state.clock < toClock) {
        state.clock += 20000;
        step(true);
      }
    }

    function step(silent) {
      // Scenario starts.
      while (scenarioIdx < scenario.length && t0 + scenario[scenarioIdx].at <= state.clock) {
        const s = scenario[scenarioIdx++];
        const a = agentById(s.agent);
        startRun(s.agent, s.trigger, null, { plan: Object.assign({}, s.plan) });
        if (s.trigger === "schedule") worker("schedule.tick", (w) => ({ completed: w.completed + 1 }));
      }
      if (scenarioIdx >= scenario.length) autoSchedule();
      // Advance every running run one tick; queued runs start while fewer than 8 are running (two worker replicas of 4).
      const running = state.runs.filter((r) => r.state === "running");
      const queued = state.runs.filter((r) => r.state === "queued");
      for (const r of running) advance(r);
      for (const r of queued.slice(0, 3)) if (state.runs.filter((x) => x.state === "running").length < 8) advance(r);
      // Background workers.
      if (Math.floor(state.clock / 20000) % 9 === 0) { worker("connector.sync", (w) => ({ completed: w.completed + 1 })); const c = CLIENTS[0]; edge("connector:" + c.connections[0], "xray", "sync", "2 observations"); }
      if (Math.floor(state.clock / 20000) % 7 === 0) worker("notify.send", (w) => ({ queued: Math.max(0, w.queued - 1), completed: w.completed + (w.queued > 0 ? 1 : 0) }));
      // Lease expiry recovery (recovered interrupted run) once in history.
      if (!state._recovered && state.clock > t0 - 12 * 60000) { state._recovered = true; emit(null, "note", { text: "worker restarted (deploy); 1 run recovered from checkpoint (lease_expired)" }, { kind: "note" }); state.incidents.push({ id: `INC-${++incidentSeq}`, clientId: "c1", kind: "lease_expired", severity: "medium", title: "Run lease expired during deploy; re-queued from checkpoint", runId: "R-0001", state: "acknowledged", createdAt: state.clock }); }
      if (!silent) notify();
    }

    function notify() { for (const fn of listeners) fn(state); }

    // Control actions (what a human can do from the UI; all audited in the real system).
    const actions = {
      approve(id, by) {
        const ap = state.approvals.find((a) => a.id === id); if (!ap || ap.state !== "pending") return false;
        ap.state = "approved"; ap.decidedBy = by || "you"; ap.decidedAt = now();
        const run = runById(ap.runId); emit(run, "approval_decided", { approvalId: id, decision: "approved", by: ap.decidedBy });
        worker("agent.resume", (w) => ({ queued: w.queued + 1 }));
        setRunState(run, "queued", "resume after approval"); run.trigger = "resume"; run.ticksLeft = 0;
        edge("human", run.agentId, "approval_decided", "approved");
        notify(); return true;
      },
      reject(id, by, reason) {
        const ap = state.approvals.find((a) => a.id === id); if (!ap || ap.state !== "pending") return false;
        ap.state = "rejected"; ap.decidedBy = by || "you"; ap.decidedAt = now(); ap.reason = reason || "";
        const run = runById(ap.runId); emit(run, "approval_decided", { approvalId: id, decision: "rejected", by: ap.decidedBy, reason: ap.reason });
        setRunState(run, "cancelled", "approval rejected"); run.finishedAt = now();
        const task = state.tasks.find((t) => t.id === run.taskId); if (task) task.state = "cancelled";
        edge("human", run.agentId, "approval_decided", "rejected");
        notify(); return true;
      },
      answer(id, text) {
        const q = state.questions.find((x) => x.id === id); if (!q || q.state !== "open") return false;
        q.state = "answered"; q.answer = text || "Yes"; q.answeredAt = now();
        const run = runById(q.runId); emit(run, "note", { text: `answer received for ${q.id}` });
        worker("agent.resume", (w) => ({ queued: w.queued + 1 }));
        setRunState(run, "queued", "resume after input"); run.trigger = "resume"; run.ticksLeft = 0;
        const task = state.tasks.find((t) => t.id === run.taskId); if (task) task.state = "in_progress";
        edge("human", run.agentId, "answer", q.department);
        notify(); return true;
      },
      pause(runId) { const run = runById(runId); if (!run || !["running", "queued"].includes(run.state)) return false; worker("agent.run", (w) => ({ active: Math.max(0, w.active - (run.state === "running" ? 1 : 0)), queued: Math.max(0, w.queued - (run.state === "queued" ? 1 : 0)) })); setRunState(run, "paused", "paused by operator"); notify(); return true; },
      resume(runId) { const run = runById(runId); if (!run || run.state !== "paused") return false; worker("agent.run", (w) => ({ queued: w.queued + 1 })); setRunState(run, "queued", "resumed by operator"); notify(); return true; },
      cancel(runId) { const run = runById(runId); if (!run || ["succeeded", "failed", "cancelled"].includes(run.state)) return false; if (run.state === "running") worker("agent.run", (w) => ({ active: Math.max(0, w.active - 1) })); setRunState(run, "cancelled", "cancelled by operator"); run.finishedAt = now(); const task = state.tasks.find((t) => t.id === run.taskId); if (task) task.state = "cancelled"; notify(); return true; },
      instruct(runId, text) { const run = runById(runId); if (!run || !text) return false; run.instructions.push({ at: now(), text }); emit(run, "note", { text: `instruction queued for the next checkpoint: "${text}"` }); edge("human", run.agentId, "instruction", "checkpoint"); notify(); return true; },
      retry(runId) { const run = runById(runId); if (!run || run.state !== "failed") return false; const agent = agentById(run.agentId); if (agent.currentRunId) return false; const r2 = startRun(run.agentId, "command", null, { plan: {} }); if (r2) { r2.attempt = run.attempt + 1; emit(r2, "note", { text: `manual retry of ${run.id}` }); agent.state = "idle"; } notify(); return Boolean(r2); },
      reassign(taskId, agentId) { const task = state.tasks.find((t) => t.id === taskId); if (!task) return false; const a = agentById(agentId); if (!a || a.clientId !== task.clientId) return false; task.agentId = agentId; task.state = "assigned"; emit(null, "note", { text: `task ${task.id} reassigned to ${a.name}` }, { clientId: task.clientId, agentId }); notify(); return true; },
      runNow(agentId) { const r = startRun(agentId, "command", null, { plan: {} }); notify(); return Boolean(r); },
      ackIncident(id) { const i = state.incidents.find((x) => x.id === id); if (!i || i.state !== "open") return false; i.state = "acknowledged"; notify(); return true; },
      resolveIncident(id) { const i = state.incidents.find((x) => x.id === id); if (!i || i.state === "resolved") return false; i.state = "resolved"; notify(); return true; },
      toggleSchedule(id) { const s = state.schedules.find((x) => x.id === id); if (!s) return false; s.enabled = !s.enabled; notify(); return true; }
    };

    // Derived views.
    const derived = {
      fleet() {
        const buckets = { running: [], waiting: [], idle: [], failed: [], paused: [], completed: [] };
        for (const a of state.agents) {
          const run = a.currentRunId ? runById(a.currentRunId) : null;
          const lastRun = state.runs.filter((r) => r.agentId === a.id).slice(-1)[0] || null;
          const item = { agent: a, run, lastRun, client: clientById(a.clientId) };
          if (run && (run.state === "running" || run.state === "queued")) buckets.running.push(item);
          else if (run && (run.state === "waiting_for_approval" || run.state === "waiting_for_input")) buckets.waiting.push(item);
          else if (run && run.state === "paused") buckets.paused.push(item);
          else if (a.state === "error") buckets.failed.push(item);
          else if (lastRun && lastRun.state === "succeeded" && now() - (lastRun.finishedAt || 0) < 30 * 60000) buckets.completed.push(item);
          else buckets.idle.push(item);
        }
        return buckets;
      },
      needsHuman() {
        return {
          approvals: state.approvals.filter((a) => a.state === "pending"),
          questions: state.questions.filter((q) => q.state === "open"),
          incidents: state.incidents.filter((i) => i.state === "open"),
          failedRuns: state.runs.filter((r) => r.state === "failed")
        };
      },
      graph() {
        const nodes = [{ id: "orchestrator", type: "orchestrator", label: "Orchestrator (pg-boss)" }, { id: "human", type: "human", label: "Humans" }, { id: "model", type: "service", label: "Model gateway" }, { id: "vault", type: "service", label: "Client vaults" }, { id: "xray", type: "service", label: "KPI registry" }, { id: "agency-vault", type: "service", label: "Agency vault" }, { id: "approvals", type: "service", label: "Approvals" }, { id: "notifications", type: "service", label: "Notifications" }, { id: "incidents", type: "service", label: "Incidents" }];
        for (const c of CLIENTS) for (const conn of c.connections) nodes.push({ id: "connector:" + conn, type: "connector", label: conn + " (" + c.name + ")", clientId: c.id });
        for (const a of state.agents) nodes.push({ id: a.id, type: "agent", label: a.name, clientId: a.clientId, state: a.state, runId: a.currentRunId });
        const recent = state.edges.filter((e) => now() - e.at < 20 * 60000);
        return { nodes, edges: recent };
      },
      summary() {
        const f = derived.fleet(); const h = derived.needsHuman();
        return { running: f.running.length, waiting: f.waiting.length, idle: f.idle.length, failed: f.failed.length, paused: f.paused.length, completed: f.completed.length, approvals: h.approvals.length, questions: h.questions.length, incidents: h.incidents.length, monthUsd: state.costs.monthUsd, cap: state.costs.monthCapUsd, runsTotal: state.runs.length, eventsTotal: eventSeq };
      }
    };

    fastForward(Date.now());
    let timer = null;
    const api = {
      state, actions, derived, CLIENTS, DEFINITIONS,
      subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
      tick() { state.clock += 20000 * opts.speed; step(false); },
      start(intervalMs) { if (timer) return; timer = setInterval(() => api.tick(), intervalMs || 1500); },
      stop() { if (timer) { clearInterval(timer); timer = null; } },
      running() { return Boolean(timer); },
      agentById, runById, clientById,
      fmtTime(t) { const d = new Date(t); return d.toISOString().slice(11, 16) + "Z"; },
      fmtAgo(t) { const s = Math.max(0, Math.round((now() - t) / 1000)); if (s < 60) return s + "s ago"; const m = Math.round(s / 60); if (m < 60) return m + " min ago"; return Math.round(m / 60) + " h ago"; },
      fmtUsd(v) { return "USD " + v.toFixed(2); },
      now
    };
    return api;
  }

  global.SBOSSim = { createSim, CLIENTS, DEFINITIONS, WORKERS };
})(typeof window !== "undefined" ? window : globalThis);
