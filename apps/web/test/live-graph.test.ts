import { describe, expect, it } from "vitest";
import { buildGraph, edgePath, targetFromSummary, type LiveCommunication } from "../lib/live/graph";
import type { LiveAgent, LiveRun } from "../lib/live/helpers";

/** Flight Map model (slice 3): pure layout and aggregation, no database. */
const agent = (id: string, tenantId: string, tenantName: string, definitionKey: string, state = "idle"): LiveAgent => ({ id, tenantId, tenantSlug: tenantName.toLowerCase(), tenantName, definitionKey, name: definitionKey, state, currentRunId: null, lastActivityAt: null });
const run = (id: string, agentInstanceId: string, tenantId: string, state: LiveRun["state"]): LiveRun => ({ id, tenantId, tenantSlug: "t", tenantName: "T", agentInstanceId, agentName: "a", definitionKey: "d", trigger: "command", state, attempt: 1, startedAt: null, createdAt: "2026-11-12T10:00:00Z", step: null, steps: [], tokensInput: 0, tokensOutput: 0, costUsd: 0, simulated: false, lastEventAt: null, lastEventSummary: null, lastEventKind: null } as LiveRun);
const now = new Date("2026-11-12T10:30:00Z");
const comm = (agentInstanceId: string, kind: LiveCommunication["kind"], target: string, minutesAgo: number, tenantId = "t1"): LiveCommunication => ({ runId: "r", agentInstanceId, tenantId, kind, target, label: kind, at: new Date(now.getTime() - minutesAgo * 60000).toISOString() });

describe("flight map model", () => {
  it("maps run event summaries to targets using the worker's vocabulary only", () => {
    expect(targetFromSummary("tool_call", "read snapshot for finance: 3 answers")).toMatchObject({ kind: "tool_call", target: "vault" });
    expect(targetFromSummary("tool_call", "kpi observed closed_projects")).toMatchObject({ target: "xray" });
    expect(targetFromSummary("tool_call", "connector: rentman 112 records")).toMatchObject({ target: "connector:rentman" });
    expect(targetFromSummary("model_call", "claude-sonnet-5-5: questions drafted")).toMatchObject({ kind: "model_call", target: "model" });
    expect(targetFromSummary("approval_requested", "approval x")).toMatchObject({ target: "human" });
    expect(targetFromSummary("note", "operator instruction queued for the next checkpoint (51 characters)")).toMatchObject({ kind: "instruction", target: "human" });
    expect(targetFromSummary("checkpoint", "step persist")).toBeNull();
  });
  it("lays out one sector per client, agents around it, services on top, and aggregates edges in the window", () => {
    const agents = [agent("a1", "t1", "Northline", "discovery"), agent("a2", "t1", "Northline", "finance"), agent("b1", "t2", "Harbour", "discovery")];
    const runs = [run("r1", "a1", "t1", "running"), run("r2", "b1", "t2", "waiting_for_approval")];
    const comms = [comm("a1", "tool_call", "vault", 1), comm("a1", "tool_call", "vault", 5), comm("a1", "model_call", "model", 30), comm("b1", "approval_requested", "human", 3, "t2"), comm("a1", "dispatch", "orchestrator", 1)];
    const g = buildGraph({ agents, runs, communications: comms, connectors: [{ tenantId: "t1", provider: "rentman", live: true }], now });
    expect(g.sectors.map((s) => s.label)).toEqual(["Harbour", "Northline · live"]);
    expect(g.nodes.find((n) => n.id === "a1")).toMatchObject({ type: "agent", state: "running", runId: "r1" });
    expect(g.nodes.find((n) => n.id === "b1")).toMatchObject({ state: "blocked", runId: "r2" });
    expect(g.nodes.filter((n) => n.type === "service" || n.type === "connector").map((n) => n.id)).toContain("connector:rentman");
    expect(g.nodes.filter((n) => n.type === "service").every((n) => n.y === 38)).toBe(true);
    const vaultEdge = g.edges.find((e) => e.from === "a1" && e.to === "vault");
    expect(vaultEdge).toMatchObject({ count: 2, hot: true, human: false });
    expect(g.edges.find((e) => e.kind === "model_call")).toBeUndefined(); // 30 minutes old, outside the 20 minute window
    expect(g.edges.find((e) => e.kind === "approval_requested")).toMatchObject({ from: "b1", to: "human", human: true });
    expect(g.edges.find((e) => e.kind === "dispatch")).toMatchObject({ from: "orchestrator", to: "a1" });
    // Agents stay inside their sector ellipse.
    for (const n of g.nodes.filter((n) => n.type === "agent")) { const s = g.sectors.find((x) => x.tenantId === n.tenantId)!; expect(Math.abs(n.x - s.x)).toBeLessThanOrEqual(s.rx); expect(Math.abs(n.y - s.y)).toBeLessThanOrEqual(s.ry); }
  });
  it("filters by tenant and draws a bowed path", () => {
    const g = buildGraph({ agents: [agent("a1", "t1", "N", "d"), agent("b1", "t2", "H", "d")], runs: [], communications: [comm("b1", "tool_call", "vault", 1, "t2")], now, tenantFilter: "t1" });
    expect(g.sectors).toHaveLength(1);
    expect(g.edges).toHaveLength(0);
    expect(edgePath({ x: 0, y: 0 }, { x: 100, y: 0 })).toBe("M0,0 Q50,15 100,0");
  });
});
