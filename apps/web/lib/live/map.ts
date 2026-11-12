/**
 * Flight Map view helpers (ADR-024, slice 3): pure functions between the graph model (`graph.ts`) and the SVG
 * component. No I/O; unit-tested in test/live-map.test.ts.
 */
import type { GraphModel } from "./graph";
import type { LiveCommunication } from "./graph";
import type { LiveAgent, LiveRun, LiveSnapshot } from "./helpers";

/**
 * Three-letter code shown inside an agent node: initials for multi-word names ("Discovery Agent" -> "DA",
 * "KPI Intelligence Agent" -> "KIA"), otherwise the first three letters ("discovery" -> "DIS").
 */
export function agentCode(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
  if (words.length === 0) return "?";
  if (words.length >= 2) return words.slice(0, 3).map((w) => w[0]!.toUpperCase()).join("");
  return words[0]!.slice(0, 3).toUpperCase();
}

export type RingTone = "running" | "blocked" | "error" | "paused" | "idle";

/**
 * Ring colour of an agent node from the graph node state (run state folded by `buildGraph`, otherwise the
 * agent_instances state): cyan running, amber blocked (waiting for a human) or paused, red error, grey idle.
 */
export function ringToneForState(state: string | undefined): RingTone {
  switch (state) {
    case "running":
    case "queued":
      return "running";
    case "blocked":
    case "waiting_for_approval":
    case "waiting_for_input":
    case "interrupted":
      return "blocked";
    case "paused":
      return "paused";
    case "error":
    case "failed":
    case "timed_out":
    case "disabled":
      return "error";
    default:
      return "idle";
  }
}

/** Short label for a node ("Discovery Agent", "Model gateway", "rentman"), clipped for the SVG. */
export function clipLabel(label: string, max = 18): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

export interface CommunicationRow {
  key: string;
  at: string;
  from: string;
  to: string;
  label: string;
  kind: LiveCommunication["kind"];
  human: boolean;
  runId: string | null;
  tenantId: string | null;
}

const TARGET_LABELS: Record<string, string> = { model: "Model gateway", vault: "Client vaults", xray: "KPI registry", "agency-vault": "Agency vault", approvals: "Approvals", notifications: "Notifications", incidents: "Incidents", human: "Humans", orchestrator: "Orchestrator", platform: "Platform" };

export function targetLabel(target: string): string {
  if (target.startsWith("connector:")) return `connector ${target.slice("connector:".length)}`;
  return TARGET_LABELS[target] ?? target;
}

const HUMAN_KINDS: ReadonlySet<string> = new Set(["approval_requested", "approval_decided", "question_created", "instruction"]);

/**
 * Rows for the "Recent communications" list: newest first, capped (default 30), with from and to resolved to names
 * the same way `buildGraph` orients edges (dispatch from the orchestrator, decisions and instructions from humans).
 * The tenant filter drops communications of other tenants; communications without a tenant (platform) stay.
 */
export function communicationRows(communications: LiveCommunication[], agents: Pick<LiveAgent, "id" | "name" | "tenantName">[], opts: { limit?: number; tenantFilter?: string | null } = {}): CommunicationRow[] {
  const limit = opts.limit ?? 30;
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const rows: CommunicationRow[] = [];
  for (let i = communications.length - 1; i >= 0 && rows.length < limit; i--) {
    const c = communications[i]!;
    if (opts.tenantFilter && c.tenantId && c.tenantId !== opts.tenantFilter) continue;
    const agentName = c.agentInstanceId ? (names.get(c.agentInstanceId) ?? "agent") : "Orchestrator";
    const fromHuman = c.kind === "approval_decided" || c.kind === "instruction";
    const from = c.kind === "dispatch" ? "Orchestrator" : fromHuman ? "Humans" : agentName;
    const to = c.kind === "dispatch" || fromHuman ? agentName : targetLabel(c.target);
    rows.push({ key: `${c.runId ?? "platform"}:${c.at}:${i}`, at: c.at, from, to, label: c.label, kind: c.kind, human: HUMAN_KINDS.has(c.kind), runId: c.runId, tenantId: c.tenantId });
  }
  return rows;
}

export interface MapCounts {
  running: number;
  waiting: number;
  hotEdges: number;
  edges: number;
  agents: number;
}

/** Counts for the strip above the map, from the graph that is actually drawn. */
export function mapCounts(graph: Pick<GraphModel, "nodes" | "edges">): MapCounts {
  let running = 0, waiting = 0, agents = 0;
  for (const n of graph.nodes) {
    if (n.type !== "agent") continue;
    agents += 1;
    const tone = ringToneForState(n.state);
    if (tone === "running") running += 1;
    else if (tone === "blocked") waiting += 1;
  }
  return { running, waiting, hotEdges: graph.edges.filter((e) => e.hot).length, edges: graph.edges.length, agents };
}

/**
 * Run to open when an agent node is clicked: its current run (from the graph node or the agent row), otherwise the
 * most recent run the snapshot knows for that agent (timeline state changes in the last 45 minutes, then
 * communications in the last 20 minutes). Null when the snapshot has no run for the agent.
 */
export function latestRunForAgent(snapshot: Pick<LiveSnapshot, "agents" | "running" | "timeline" | "communications">, agentId: string, nodeRunId?: string | null): string | null {
  if (nodeRunId) return nodeRunId;
  const agent = snapshot.agents.find((a) => a.id === agentId);
  if (agent?.currentRunId) return agent.currentRunId;
  const alive = snapshot.running.filter((r: LiveRun) => r.agentInstanceId === agentId).sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt))[0];
  if (alive) return alive.id;
  let best: { runId: string; at: string } | null = null;
  for (const e of snapshot.timeline) if (e.agentInstanceId === agentId && (!best || e.at > best.at)) best = { runId: e.runId, at: e.at };
  for (const c of snapshot.communications) if (c.agentInstanceId === agentId && c.runId && (!best || c.at > best.at)) best = { runId: c.runId, at: c.at };
  return best?.runId ?? null;
}
