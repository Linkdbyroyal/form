"use client";

import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";

/**
 * shadcn-style chart primitives on Recharts 3 (M3-03). The only client components of the dashboard.
 * They receive plain JSON from the server renderer: a short series of `ok` observations. Colours come
 * from the design tokens in globals.css (CSS variables), never hard-coded hex values.
 * `accessibilityLayer` adds keyboard navigation and ARIA roles to the chart.
 */
export interface ChartPoint {
  /** Short label for the x axis (period end date). */
  label: string;
  value: number;
}

export interface ChartConfig {
  label: string;
  unit: string;
  color?: string;
}

function ChartContainer({ children, config }: { children: React.ReactNode; config: ChartConfig }) {
  return (
    <figure className="h-56 w-full" aria-label={`${config.label} (${config.unit})`} style={{ ["--chart-1" as string]: config.color ?? "var(--sb-cyan)" }}>
      <ResponsiveContainer width="100%" height="100%">
        {children as React.ReactElement}
      </ResponsiveContainer>
    </figure>
  );
}

function ChartTooltip({ active, payload, label, unit }: Partial<TooltipContentProps<number, string>> & { unit: string }) {
  if (!active || !payload || payload.length === 0) return null;
  const v = payload[0]?.value;
  return (
    <div className="rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-fg shadow">
      <div className="text-faint">{String(label)}</div>
      <div className="font-medium">{typeof v === "number" ? v : String(v ?? "")} {unit === "count" ? "" : unit}</div>
    </div>
  );
}

const axisStyle = { fill: "var(--sb-text-faint)", fontSize: 11 } as const;

export function KpiTrendChart({ data, config }: { data: ChartPoint[]; config: ChartConfig }) {
  return (
    <ChartContainer config={config}>
      <LineChart data={data} accessibilityLayer margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--sb-border)" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tick={axisStyle} />
        <YAxis width={40} tickLine={false} axisLine={false} tick={axisStyle} />
        <Tooltip content={<ChartTooltip unit={config.unit} />} cursor={{ stroke: "var(--sb-border)" }} />
        <Line type="monotone" dataKey="value" name={config.label} stroke="var(--chart-1)" strokeWidth={2} dot={{ r: 3, fill: "var(--chart-1)" }} isAnimationActive={false} />
      </LineChart>
    </ChartContainer>
  );
}

export function KpiBarChart({ data, config }: { data: ChartPoint[]; config: ChartConfig }) {
  return (
    <ChartContainer config={config}>
      <BarChart data={data} accessibilityLayer margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--sb-border)" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tick={axisStyle} />
        <YAxis width={40} tickLine={false} axisLine={false} tick={axisStyle} />
        <Tooltip content={<ChartTooltip unit={config.unit} />} cursor={{ fill: "var(--sb-surface-2)" }} />
        <Bar dataKey="value" name={config.label} fill="var(--chart-1)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  );
}
