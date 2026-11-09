import type { ReactNode } from "react";

export function Card({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="sb-card p-5">
      {title ? <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{title}</h3> : null}
      <div>{children}</div>
      {footer ? <div className="mt-4 border-t border-border pt-3 text-xs text-faint">{footer}</div> : null}
    </section>
  );
}

export type Tone = "neutral" | "cyan" | "success" | "warning" | "danger" | "indigo";

const toneClass: Record<Tone, string> = {
  neutral: "border-border text-muted",
  cyan: "border-cyan/40 text-cyan",
  success: "border-success/40 text-success",
  warning: "border-warning/40 text-warning",
  danger: "border-danger/40 text-danger",
  indigo: "border-indigo/40 text-indigo"
};

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneClass[tone]}`}>{children}</span>;
}

export function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="sb-card p-4">
      <div className="text-xs uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-fg">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}

/** Explicit implementation status label. Required by the product rule: no mockups presented as working features. */
export function Status({ state }: { state: "implemented" | "simulated" | "not_connected" | "planned" }) {
  const map = {
    implemented: { label: "Implemented", tone: "success" as Tone },
    simulated: { label: "Simulated", tone: "warning" as Tone },
    not_connected: { label: "Not connected", tone: "danger" as Tone },
    planned: { label: "Planned", tone: "neutral" as Tone }
  };
  const s = map[state];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function DevBanner() {
  return (
    <div className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning">
      Development mode: no authentication is active (Milestone 0). Every request acts as the seeded development operator. Replaced by ticket M1-01.
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-card border border-dashed border-border p-6 text-center text-sm text-muted">{children}</div>;
}
