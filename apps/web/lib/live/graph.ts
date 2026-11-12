/**
 * Flight Map model (ADR-024, slice 3): pure functions that turn the live snapshot plus recent communications into
 * nodes, aggregated edges and a deterministic sector layout, exactly like the approved composite prototype
 * (docs/proposals/live-mission-control/D.html): orchestrator in the centre, one sector per client with its agents
 * around it, shared services and connectors along the top, humans bottom left. No rendering library is needed for
 * this layout; React Flow stays an option for pan, zoom and very large fleets.
 */
import type { LiveAgent, LiveRun } from "./helpers";

export type CommunicationKind = "tool_call" | "model_call" | "approval_requested" | "approval_decided" | "question_created" | "instruction" | "dispatch" | "sync";

/** One recent communication, derived from run_events summaries the operator may read (identifiers and targets only). */
export interface LiveCommunication {
  runId: string | null;
  agentInstanceId: string | null;
  tenantId: string | null;
  kind: CommunicationKind;
  /** Logical target: "vault", "xray", "model", "approvals", "human", "agency-vault", "notifications", "connector:<provider>", "incidents". */
  target: string;
  label: string;
  at: string;
}

export interface GraphNode {
  id: string;
  type: "orchestrator" | "human" | "service" | "connector" | "sector" | "agent";
  label: string;
  tenantId?: string;
  state?: string;
  runId?: string | null;
  x: number;
  y: number;
  r: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: CommunicationKind;
  label: string;
  count: number;
  lastAt: string;
  hot: boolean;
  human: boolean;
}

export interface GraphModel {
  width: number;
  height: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  sectors: Array<{ tenantId: string; label: string; x: number; y: number; rx: number; ry: number }>;
}

const SERVICE_LABELS: Record<string, string> = { model: "Model gateway", vault: "Client vaults", xray: "KPI registry", "agency-vault": "Agency vault", approvals: "Approvals", notifications: "Notifications", incidents: "Incidents", human: "Humans", platform: "Platform" };

/** Maps a run_events summary to a communication target, using only the vocabulary the worker writes. */
export function targetFromSummary(kind: string, summary: string): { kind: CommunicationKind; target: string; label: string } | null {
  const s = summary.toLowerCase();
  if (kind === "model_call") return { kind: "model_call", target: "model", label: "model call" };
  if (kind === "approval_requested") return { kind: "approval_requested", target: "human", label: "approval requested" };
  if (kind === "approval_decided") return { kind: "approval_decided", target: "human", label: "approval decided" };
  if (kind === "question_created") return { kind: "question_created", target: "human", label: "question for the client" };
  if (kind === "note" && s.includes("operator instruction")) return { kind: "instruction", target: "human", label: "operator instruction" };
  if (kind === "tool_call") {
    if (s.includes("snapshot") || s.includes("vault") || s.includes("facts") || s.includes("document") || s.includes("findings")) return { kind: "tool_call", target: "vault", label: summary.slice(0, 60) };
    if (s.includes("kpi") || s.includes("observation") || s.includes("action")) return { kind: "tool_call", target: "xray", label: summary.slice(0, 60) };
    if (s.includes("nominat") || s.includes("knowledge")) return { kind: "tool_call", target: "agency-vault", label: summary.slice(0, 60) };
    if (s.includes("notif") || s.includes("mail") || s.includes("pumble")) return { kind: "tool_call", target: "notifications", label: summary.slice(0, 60) };
    const m = /connector[:\s]+([a-z]+)/.exec(s);
    if (m) return { kind: "tool_call", target: `connector:${m[1]}`, label: summary.slice(0, 60) };
    return { kind: "tool_call", target: "vault", label: summary.slice(0, 60) };
  }
  if (kind === "state_change" && (s.includes("queued") || s.includes("resumed") || s.includes("started"))) return { kind: "dispatch", target: "orchestrator", label: summary.slice(0, 40) };
  return null;
}

export interface GraphInput {
  agents: LiveAgent[];
  runs: LiveRun[];
  communications: LiveCommunication[];
  /** Connectors per tenant: provider keys in read_only or live phase. */
  connectors?: Array<{ tenantId: string; provider: string; live: boolean }>;
  now?: Date;
  /** Edges older than this are dropped (default 20 minutes); "hot" means younger than hotMs (default 2 minutes). */
  windowMs?: number;
  hotMs?: number;
  width?: number;
  height?: number;
  tenantFilter?: string | null;
}

export function buildGraph(input: GraphInput): GraphModel {
  const now = input.now ?? new Date();
  const windowMs = input.windowMs ?? 20 * 60000, hotMs = input.hotMs ?? 2 * 60000;
  const W = input.width ?? 1100, H = input.height ?? 520;
  const tenants = new Map<string, { id: string; name: string; live: boolean }>();
  for (const a of input.agents) if (!input.tenantFilter || a.tenantId === input.tenantFilter) tenants.set(a.tenantId, { id: a.tenantId, name: a.tenantName, live: false });
  for (const c of input.connectors ?? []) { const t = tenants.get(c.tenantId); if (t && c.live) t.live = true; }
  const tenantList = [...tenants.values()].sort((a, b) => a.name.localeCompare(b.name));
  const centres: Array<[number, number]> = tenantList.length === 1 ? [[W / 2, H * 0.6]] : tenantList.length === 2 ? [[W * 0.21, H * 0.58], [W * 0.79, H * 0.58]] : [[W * 0.18, H * 0.54], [W * 0.82, H * 0.54], [W / 2, H * 0.78]];
  const nodes: GraphNode[] = [{ id: "orchestrator", type: "orchestrator", label: "Orchestrator (pg-boss)", x: W / 2, y: H * 0.42, r: 28 }, { id: "human", type: "human", label: "Humans", x: W * 0.08, y: H * 0.9, r: 16 }];
  const sectors: GraphModel["sectors"] = [];
  const runByAgent = new Map(input.runs.map((r) => [r.agentInstanceId, r]));
  tenantList.forEach((t, i) => {
    const [sx, sy] = centres[Math.min(i, centres.length - 1)]!;
    sectors.push({ tenantId: t.id, label: `${t.name}${t.live ? " · live" : ""}`, x: sx, y: sy, rx: 138, ry: 94 });
    const agents = input.agents.filter((a) => a.tenantId === t.id).sort((a, b) => a.definitionKey.localeCompare(b.definitionKey));
    agents.forEach((a, j) => {
      const ang = -Math.PI / 2 + (j / Math.max(1, agents.length)) * Math.PI * 2;
      const run = runByAgent.get(a.id);
      const state = run ? (["running", "queued"].includes(run.state) ? "running" : ["waiting_for_approval", "waiting_for_input"].includes(run.state) ? "blocked" : run.state === "paused" ? "paused" : a.state) : a.state;
      nodes.push({ id: a.id, type: "agent", label: a.name, tenantId: t.id, state, runId: run?.id ?? null, x: Math.round(sx + Math.cos(ang) * 96), y: Math.round(sy + Math.sin(ang) * 60), r: 18 });
    });
  });
  // Services and connectors along the top, in a stable order.
  const serviceIds = new Set<string>(["model", "vault", "xray", "agency-vault", "approvals", "notifications", "incidents"]);
  for (const c of input.connectors ?? []) if (!input.tenantFilter || c.tenantId === input.tenantFilter) serviceIds.add(`connector:${c.provider}`);
  for (const c of input.communications) if (c.target.startsWith("connector:")) serviceIds.add(c.target);
  const services = [...serviceIds];
  services.forEach((id, i) => nodes.push({ id, type: id.startsWith("connector:") ? "connector" : "service", label: SERVICE_LABELS[id] ?? id.replace("connector:", ""), x: Math.round(70 + (i * (W - 140)) / Math.max(1, services.length - 1)), y: 38, r: 13 }));
  // Edges: aggregate per (from, to, kind) within the window.
  const edgeMap = new Map<string, GraphEdge>();
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const c of input.communications) {
    const at = new Date(c.at).getTime();
    if (!Number.isFinite(at) || now.getTime() - at > windowMs) continue;
    if (input.tenantFilter && c.tenantId && c.tenantId !== input.tenantFilter) continue;
    const agent = c.agentInstanceId ?? "orchestrator";
    const from = c.kind === "dispatch" ? "orchestrator" : c.kind === "approval_decided" || c.kind === "instruction" ? "human" : agent;
    const to = c.kind === "dispatch" ? agent : c.kind === "approval_decided" || c.kind === "instruction" ? agent : c.target;
    if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) continue;
    const key = `${from}>${to}>${c.kind}`;
    const prev = edgeMap.get(key);
    const human = ["approval_requested", "approval_decided", "question_created", "instruction"].includes(c.kind);
    if (prev) { prev.count += 1; if (c.at > prev.lastAt) { prev.lastAt = c.at; prev.label = c.label; } }
    else edgeMap.set(key, { id: key, from, to, kind: c.kind, label: c.label, count: 1, lastAt: c.at, hot: false, human });
  }
  const edges = [...edgeMap.values()].map((e) => ({ ...e, hot: now.getTime() - new Date(e.lastAt).getTime() < hotMs })).sort((a, b) => a.lastAt.localeCompare(b.lastAt));
  return { width: W, height: H, nodes, edges, sectors };
}

/** Quadratic path between two nodes with a slight bow so parallel edges stay visible. */
export function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const mx = (a.x + b.x) / 2 + (a.y - b.y) * 0.15, my = (a.y + b.y) / 2 + (b.x - a.x) * 0.15;
  return `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`;
}
