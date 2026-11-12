"use client";

import { useMemo, type KeyboardEvent } from "react";
import { buildGraph, edgePath, type GraphEdge, type GraphModel, type GraphNode, type LiveCommunication } from "@/lib/live/graph";
import { fmtAgo, type LiveAgent, type LiveConnector, type LiveRun } from "@/lib/live/helpers";
import { agentCode, clipLabel, ringToneForState } from "@/lib/live/map";

/**
 * Flight Map (ADR-024 composite D, slice 3): inline SVG of the graph model from `buildGraph`. Orchestrator in the
 * centre, one sector per client with its agents around it, services and connectors along the top, humans bottom
 * left. Edges aggregate communications of the last 20 minutes; cyan glow and dashed flow for the last 2 minutes,
 * amber for anything that involves a human. Colours come from the theme tokens through `.sb-map` in globals.css.
 * Clicking or pressing Enter on an agent node asks the board to open its run in the shared inspector drawer.
 */
export interface FlightMapInput {
  agents: LiveAgent[];
  runs: LiveRun[];
  communications: LiveCommunication[];
  connectors: LiveConnector[];
  tenantFilter: string | null;
  now: Date;
}

/** Memoised graph model, shared by the map, the counts strip and the communications list on the board. */
export function useFlightMapModel({ agents, runs, communications, connectors, tenantFilter, now }: FlightMapInput): GraphModel {
  return useMemo(() => buildGraph({ agents, runs, communications, connectors, tenantFilter, now }), [agents, runs, communications, connectors, tenantFilter, now]);
}

export function FlightMap({ model, now, selectedRunId, onSelectAgent }: { model: GraphModel; now: Date; selectedRunId: string | null; onSelectAgent: (node: GraphNode) => void }) {
  const byId = useMemo(() => new Map(model.nodes.map((n) => [n.id, n])), [model.nodes]);
  const sectorByTenant = useMemo(() => new Map(model.sectors.map((s) => [s.tenantId, s])), [model.sectors]);
  const agentCount = model.nodes.filter((n) => n.type === "agent").length;

  return (
    <div className="sb-map h-[360px] w-full md:h-[520px]">
      <svg viewBox={`0 0 ${model.width} ${model.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Live agent map: ${agentCount} agents, ${model.edges.length} communications in the last 20 minutes`} className="block h-full w-full">
        {model.sectors.map((s) => (
          <g key={s.tenantId}>
            <ellipse className="sector" cx={s.x} cy={s.y} rx={s.rx} ry={s.ry} />
            <text className="lbl" x={s.x} y={s.y - s.ry - 8} textAnchor="middle">{s.label}</text>
          </g>
        ))}
        {model.edges.map((e) => {
          const a = byId.get(e.from), b = byId.get(e.to);
          if (!a || !b) return null;
          return (
            <path key={e.id} className={edgeClass(e)} d={edgePath(a, b)}>
              <title>{edgeTitle(e, a, b, now)}</title>
            </path>
          );
        })}
        {model.nodes.map((n) => (
          <MapNode key={n.id} node={n} width={model.width} sector={n.tenantId ? sectorByTenant.get(n.tenantId) : undefined} selected={n.type === "agent" && n.runId !== null && n.runId === selectedRunId} onSelect={onSelectAgent} />
        ))}
      </svg>
    </div>
  );
}

function MapNode({ node, width, sector, selected, onSelect }: { node: GraphNode; width: number; sector?: { x: number; y: number }; selected: boolean; onSelect: (node: GraphNode) => void }) {
  const isAgent = node.type === "agent";
  const tone = isAgent ? ringToneForState(node.state) : null;
  const cls = ["node", node.type, tone ?? "", selected ? "sel" : ""].filter(Boolean).join(" ");
  const label = node.type === "connector" ? node.label.split(" ")[0]! : node.label;
  const name = isAgent ? agentLabelPlacement(node, sector, width) : { x: node.x, y: node.y + node.r + 13, anchor: "middle" as const, maxChars: 22 };
  const onKeyDown = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(node);
    }
  };
  const title = isAgent ? `${node.label} · ${node.state ?? "idle"}${node.runId ? " · open run" : ""}` : node.label;
  return (
    <g
      className={cls}
      data-node={node.id}
      role={isAgent ? "button" : undefined}
      tabIndex={isAgent ? 0 : undefined}
      aria-label={isAgent ? `${node.label}, ${node.state ?? "idle"}; opens its run` : undefined}
      aria-pressed={isAgent ? selected : undefined}
      onClick={isAgent ? () => onSelect(node) : undefined}
      onKeyDown={isAgent ? onKeyDown : undefined}
    >
      <title>{title}</title>
      <circle cx={node.x} cy={node.y} r={node.r} />
      {isAgent ? (
        <text className="code" x={node.x} y={node.y + 3.5} textAnchor="middle">{agentCode(node.label)}</text>
      ) : null}
      <text className={isAgent ? "name" : "lbl"} x={name.x} y={name.y} textAnchor={name.anchor}>{clipLabel(label, name.maxChars)}</text>
    </g>
  );
}

/** Average glyph width of the 11 px label font in viewBox units, used to clip a name to the space before the map edge. */
const GLYPH_W = 6.2;

/**
 * Agent names sit on the outward side of their sector (left of nodes on the left half, right of nodes on the right
 * half, above or below at the top and bottom), so the names of agents on one ring do not overlap in the middle.
 * `maxChars` keeps a side label inside the map width (at least 8 characters, at most 24).
 */
export function agentLabelPlacement(node: { x: number; y: number; r: number }, sector?: { x: number; y: number }, width = 1100): { x: number; y: number; anchor: "start" | "middle" | "end"; maxChars: number } {
  const fit = (available: number) => Math.max(8, Math.min(24, Math.floor(available / GLYPH_W)));
  if (!sector) return { x: node.x, y: node.y + node.r + 13, anchor: "middle", maxChars: 24 };
  const dx = node.x - sector.x, dy = node.y - sector.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  if (ux > 0.35) { const x = node.x + node.r + 5; return { x, y: node.y + 4, anchor: "start", maxChars: fit(width - x - 4) }; }
  if (ux < -0.35) { const x = node.x - node.r - 5; return { x, y: node.y + 4, anchor: "end", maxChars: fit(x - 4) }; }
  return uy < 0 ? { x: node.x, y: node.y - node.r - 6, anchor: "middle", maxChars: 24 } : { x: node.x, y: node.y + node.r + 13, anchor: "middle", maxChars: 24 };
}

function edgeClass(e: GraphEdge): string {
  return ["edge", e.hot ? "hot" : "", e.human ? "human" : ""].filter(Boolean).join(" ");
}

function edgeTitle(e: GraphEdge, a: GraphNode, b: GraphNode, now: Date): string {
  return `${a.label} → ${b.label}: ${e.label} (${e.count}×, last ${fmtAgo(e.lastAt, now)})`;
}

/** Legend under the map; the same vocabulary as the composite. */
export function FlightMapLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted" aria-label="Map legend">
      <li><i className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-indigo align-middle" aria-hidden /> centre: orchestrator (pg-boss)</li>
      <li><i className="mr-1 inline-block h-2.5 w-2.5 rounded-full border-2 border-cyan align-middle" aria-hidden /> agent running</li>
      <li><i className="mr-1 inline-block h-2.5 w-2.5 rounded-full border-2 border-warning align-middle" aria-hidden /> agent waiting for a human or paused</li>
      <li><i className="mr-1 inline-block h-2.5 w-2.5 rounded-full border-2 border-danger align-middle" aria-hidden /> agent in error</li>
      <li><i className="mr-1 inline-block h-2.5 w-2.5 rounded-full border-2 border-border align-middle" aria-hidden /> agent idle</li>
      <li><i className="mr-1 inline-block h-0.5 w-4 bg-cyan align-middle shadow-[0_0_4px_var(--sb-cyan)]" aria-hidden /> activity in the last 2 minutes</li>
      <li><i className="mr-1 inline-block h-0.5 w-4 bg-warning align-middle" aria-hidden /> human interaction</li>
      <li><i className="mr-1 inline-block h-0.5 w-4 bg-border align-middle" aria-hidden /> older activity (20 minutes)</li>
      <li>sectors: one per client; top: services and connectors; bottom left: humans</li>
    </ul>
  );
}
