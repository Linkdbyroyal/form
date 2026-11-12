import { describe, expect, it } from "vitest";
import { buildGraph, type LiveCommunication } from "../lib/live/graph";
import type { LiveAgent, LiveRun, LiveSnapshot } from "../lib/live/helpers";
import { agentCode, clipLabel, communicationRows, latestRunForAgent, mapCounts, ringToneForState, targetLabel } from "../lib/live/map";

/** Flight Map view helpers (ADR-024, slice 3): pure functions between the graph model and the SVG; the snapshot reads need Postgres and are checked manually. */
const now = new Date("2026-11-12T10:30:00Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60000).toISOString();
const agent = (id: string, tenantId: string, name: string, state = "idle", currentRunId: string | null = null): LiveAgent => ({ id, tenantId, tenantSlug: tenantId, tenantName: tenantId === "t1" ? "Northline" : "Harbour", definitionKey: name.toLowerCase().replaceAll(" ", "-"), name, state, currentRunId, lastActivityAt: null });
const run = (id: string, agentInstanceId: string, state: LiveRun["state"], startedAt: string | null = ago(5)): LiveRun => ({ id, tenantId: "t1", tenantSlug: "t1", tenantName: "Northline", agentInstanceId, agentName: "a", definitionKey: "d", trigger: "command", state, attempt: 1, startedAt, createdAt: ago(6), step: null, steps: [], tokensInput: 0, tokensOutput: 0, costUsd: 0, toolCalls: 0, modelCalls: 0, simulated: true, lastEventAt: null, lastEventSummary: null, lastEventKind: null });
const comm = (agentInstanceId: string | null, kind: LiveCommunication["kind"], target: string, minutesAgo: number, runId: string | null = "r1", tenantId: string | null = "t1", label: string = kind): LiveCommunication => ({ runId, agentInstanceId, tenantId, kind, target, label, at: ago(minutesAgo) });

describe("agent codes and labels", () => {
  it("uses initials for multi-word names and the first three letters otherwise", () => {
    expect(agentCode("CEO Intelligence Agent")).toBe("CIA");
    expect(agentCode("CFO & Finance Agent")).toBe("CFA");
    expect(agentCode("Discovery & Interview Agent")).toBe("DIA");
    expect(agentCode("Performance & Continuous Improvement Agent")).toBe("PCI");
    expect(agentCode("discovery")).toBe("DIS");
    expect(agentCode("KPI")).toBe("KPI");
    expect(agentCode("  ")).toBe("?");
  });
  it("clips long labels and names targets", () => {
    expect(clipLabel("Model gateway")).toBe("Model gateway");
    expect(clipLabel("Performance & Continuous Improvement Agent", 18)).toBe("Performance & Con…");
    expect(targetLabel("connector:rentman")).toBe("connector rentman");
    expect(targetLabel("vault")).toBe("Client vaults");
    expect(targetLabel("something-new")).toBe("something-new");
  });
});

describe("ring tones", () => {
  it("maps graph node states and raw agent states to the four ring colours", () => {
    expect(ringToneForState("running")).toBe("running");
    expect(ringToneForState("queued")).toBe("running");
    expect(ringToneForState("blocked")).toBe("blocked");
    expect(ringToneForState("waiting_for_input")).toBe("blocked");
    expect(ringToneForState("paused")).toBe("paused");
    expect(ringToneForState("error")).toBe("error");
    expect(ringToneForState("failed")).toBe("error");
    expect(ringToneForState("idle")).toBe("idle");
    expect(ringToneForState(undefined)).toBe("idle");
    expect(ringToneForState("anything else")).toBe("idle");
  });
});

describe("communication rows", () => {
  const agents = [agent("a1", "t1", "Discovery & Interview Agent"), agent("b1", "t2", "Finance Agent")];
  it("lists newest first, resolves names and orientation like the graph, and caps the list", () => {
    const comms = [comm("a1", "tool_call", "vault", 10, "r1", "t1", "read snapshot for finance"), comm("b1", "approval_requested", "human", 4, "r2", "t2"), comm(null, "dispatch", "orchestrator", 3, null, null), comm("a1", "approval_decided", "human", 2, "r1"), comm("a1", "model_call", "model", 1, "r1"), comm("a1", "tool_call", "connector:rentman", 0.5, "r1")];
    const rows = communicationRows(comms, agents);
    expect(rows.map((r) => r.kind)).toEqual(["tool_call", "model_call", "approval_decided", "dispatch", "approval_requested", "tool_call"]);
    expect(rows[0]).toMatchObject({ from: "Discovery & Interview Agent", to: "connector rentman", runId: "r1", human: false });
    expect(rows[1]).toMatchObject({ from: "Discovery & Interview Agent", to: "Model gateway" });
    expect(rows[2]).toMatchObject({ from: "Humans", to: "Discovery & Interview Agent", human: true });
    expect(rows[3]).toMatchObject({ from: "Orchestrator", to: "Orchestrator", runId: null });
    expect(rows[4]).toMatchObject({ from: "Finance Agent", to: "Humans", human: true });
    expect(rows[5]).toMatchObject({ label: "read snapshot for finance", to: "Client vaults" });
    expect(communicationRows(comms, agents, { limit: 2 })).toHaveLength(2);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
  it("applies the tenant filter but keeps platform communications without a tenant", () => {
    const comms = [comm("a1", "tool_call", "vault", 1, "r1", "t1"), comm("b1", "tool_call", "vault", 1, "r2", "t2"), comm(null, "dispatch", "orchestrator", 1, null, null)];
    const rows = communicationRows(comms, agents, { tenantFilter: "t2" });
    expect(rows.map((r) => r.from)).toEqual(["Orchestrator", "Finance Agent"]);
    expect(communicationRows([comm("zz", "tool_call", "vault", 1)], agents)[0]).toMatchObject({ from: "agent" });
  });
});

describe("map counts", () => {
  it("counts running and waiting agents and hot edges from the drawn graph", () => {
    const agents = [agent("a1", "t1", "Discovery", "idle"), agent("a2", "t1", "Finance", "idle"), agent("a3", "t1", "Ops", "error")];
    const runs = [run("r1", "a1", "running"), run("r2", "a2", "waiting_for_approval")];
    const comms = [comm("a1", "tool_call", "vault", 1), comm("a1", "tool_call", "vault", 1.5), comm("a2", "approval_requested", "human", 3, "r2"), comm("a3", "model_call", "model", 15, "r0")];
    const g = buildGraph({ agents, runs, communications: comms, now });
    expect(mapCounts(g)).toEqual({ running: 1, waiting: 1, hotEdges: 1, edges: 3, agents: 3 });
    expect(mapCounts({ nodes: [], edges: [] })).toEqual({ running: 0, waiting: 0, hotEdges: 0, edges: 0, agents: 0 });
  });
});

describe("latest run for an agent", () => {
  const base = (): Pick<LiveSnapshot, "agents" | "running" | "timeline" | "communications"> => ({
    agents: [agent("a1", "t1", "Discovery", "idle", null), agent("a2", "t1", "Finance", "running", "cur2"), agent("a3", "t1", "Ops")],
    running: [run("alive1", "a1", "queued", null)],
    timeline: [{ runId: "old3", agentInstanceId: "a3", agentName: "Ops", tenantName: "Northline", to: "succeeded", at: ago(30), seq: 9 }, { runId: "older3", agentInstanceId: "a3", agentName: "Ops", tenantName: "Northline", to: "succeeded", at: ago(40), seq: 9 }],
    communications: [comm("a3", "tool_call", "vault", 12, "comm3")]
  });
  it("prefers the node's run, then the agent's current run, then alive runs, then the newest timeline or communication run", () => {
    expect(latestRunForAgent(base(), "a1", "node1")).toBe("node1");
    expect(latestRunForAgent(base(), "a2", null)).toBe("cur2");
    expect(latestRunForAgent(base(), "a1", null)).toBe("alive1");
    expect(latestRunForAgent(base(), "a3", null)).toBe("comm3");
    const s = base();
    s.communications = [];
    expect(latestRunForAgent(s, "a3", null)).toBe("old3");
    expect(latestRunForAgent(s, "nobody", null)).toBeNull();
  });
});

describe("agent label placement", () => {
  it("puts the name on the outward side of the sector so ring labels do not overlap, clipped to the map edge", async () => {
    const { agentLabelPlacement } = await import("../components/live/flight-map");
    const sector = { x: 500, y: 300 };
    expect(agentLabelPlacement({ x: 596, y: 300, r: 18 }, sector)).toEqual({ x: 619, y: 304, anchor: "start", maxChars: 24 });
    expect(agentLabelPlacement({ x: 404, y: 300, r: 18 }, sector)).toEqual({ x: 381, y: 304, anchor: "end", maxChars: 24 });
    expect(agentLabelPlacement({ x: 500, y: 240, r: 18 }, sector)).toEqual({ x: 500, y: 216, anchor: "middle", maxChars: 24 });
    expect(agentLabelPlacement({ x: 500, y: 360, r: 18 }, sector)).toEqual({ x: 500, y: 391, anchor: "middle", maxChars: 24 });
    expect(agentLabelPlacement({ x: 500, y: 300, r: 18 })).toEqual({ x: 500, y: 331, anchor: "middle", maxChars: 24 });
    // Near the right edge of a 1100 wide map: 1100 - 1021 - 4 = 75 units, 12 characters.
    expect(agentLabelPlacement({ x: 998, y: 300, r: 18 }, { x: 902, y: 300 }, 1100)).toEqual({ x: 1021, y: 304, anchor: "start", maxChars: 12 });
    expect(agentLabelPlacement({ x: 30, y: 300, r: 18 }, { x: 120, y: 300 }, 1100).maxChars).toBe(8);
  });
});
