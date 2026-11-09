import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, type Tone } from "./ui";

/**
 * Small presentational pieces shared by the Mission Control agent pages and the Client Workspace pages.
 * Pure server components; no client JavaScript.
 */

const RUN_TONES: Record<string, Tone> = {
  queued: "neutral",
  running: "cyan",
  waiting_for_input: "warning",
  waiting_for_approval: "warning",
  paused: "warning",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
  timed_out: "danger",
  interrupted: "warning"
};

const AGENT_TONES: Record<string, Tone> = {
  active: "success",
  idle: "neutral",
  running: "cyan",
  paused: "warning",
  blocked: "warning",
  error: "danger",
  disabled: "neutral"
};

const TASK_TONES: Record<string, Tone> = {
  draft: "neutral",
  open: "neutral",
  assigned: "cyan",
  in_progress: "cyan",
  waiting_input: "warning",
  waiting_approval: "warning",
  done: "success",
  cancelled: "neutral",
  failed: "danger"
};

const APPROVAL_TONES: Record<string, Tone> = { pending: "warning", approved: "success", rejected: "danger", expired: "neutral", withdrawn: "neutral" };
const RISK_TONES: Record<string, Tone> = { low: "neutral", medium: "cyan", high: "warning", critical: "danger" };
const INCIDENT_TONES: Record<string, Tone> = { open: "danger", acknowledged: "warning", resolved: "success" };
const QUESTION_TONES: Record<string, Tone> = { draft: "neutral", open: "cyan", answered: "success", skipped: "neutral", superseded: "neutral" };
const CLASSIFICATION_TONES: Record<string, Tone> = { public: "neutral", internal: "neutral", confidential: "warning", restricted: "danger" };

export type StateKind = "run" | "agent" | "task" | "approval" | "risk" | "incident" | "question" | "classification";

const TONE_TABLE: Record<StateKind, Record<string, Tone>> = {
  run: RUN_TONES,
  agent: AGENT_TONES,
  task: TASK_TONES,
  approval: APPROVAL_TONES,
  risk: RISK_TONES,
  incident: INCIDENT_TONES,
  question: QUESTION_TONES,
  classification: CLASSIFICATION_TONES
};

export function StateBadge({ kind, value }: { kind: StateKind; value: string }) {
  return <Badge tone={TONE_TABLE[kind][value] ?? "neutral"}>{value.replaceAll("_", " ")}</Badge>;
}

/** Marks a content column the operator role cannot read (column-level grant). Never a placeholder for data that exists elsewhere. */
export function Masked({ what }: { what?: string }) {
  return (
    <span title={what ? `${what}: content column, not granted to the operator role` : "content column, not granted to the operator role"}>
      <Badge tone="indigo">Masked</Badge>
    </span>
  );
}

export function SimulatedBadge({ simulated }: { simulated: boolean }) {
  return simulated ? <Badge tone="warning">simulated</Badge> : <Badge tone="success">live</Badge>;
}

export function TriggerBadge({ trigger }: { trigger: string }) {
  return <Badge tone={trigger === "schedule" ? "indigo" : trigger === "command" ? "cyan" : "neutral"}>{trigger}</Badge>;
}

/** Result banner after a server action redirect (`?ok=` or `?error=`). */
export function Notice({ ok, error }: { ok: string | null; error: string | null }) {
  if (error) {
    return (
      <div role="alert" className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
        <span className="font-medium">Action refused:</span> {error}
      </div>
    );
  }
  if (ok) {
    return (
      <div role="status" className="rounded-card border border-success/40 bg-success/10 px-4 py-3 text-sm text-success">
        {ok}
      </div>
    );
  }
  return null;
}

export function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-faint">
          <tr>
            {head.map((h) => (
              <th key={h} className="py-2 pr-3 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {empty ? <div className="pt-2">{empty}</div> : null}
    </div>
  );
}

export function Tr({ children }: { children: ReactNode }) {
  return <tr className="border-t border-border align-top">{children}</tr>;
}

export function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`py-2 pr-3 ${className}`}>{children}</td>;
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-muted">{children}</span>;
}

export function ShortId({ id }: { id: string }) {
  return <span className="font-mono text-xs text-faint" title={id}>{id.slice(0, 8)}</span>;
}

export function PageHeader({ title, children, crumbs }: { title: string; children: ReactNode; crumbs?: Array<{ href?: string; label: string }> }) {
  return (
    <header>
      {crumbs ? (
        <div className="text-xs text-faint">
          {crumbs.map((c, i) => (
            <span key={`${c.label}-${i}`}>
              {i > 0 ? " / " : ""}
              {c.href ? <Link href={c.href} className="underline">{c.label}</Link> : c.label}
            </span>
          ))}
        </div>
      ) : null}
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="text-sm text-muted">{children}</p>
    </header>
  );
}

/** Filter links built from a query-string value. */
export function FilterBar({ basePath, param, current, options }: { basePath: string; param: string; current: string | null; options: Array<{ value: string | null; label: string }> }) {
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {options.map((o) => {
        const active = (o.value ?? null) === current;
        const href = o.value ? `${basePath}?${param}=${encodeURIComponent(o.value)}` : basePath;
        return (
          <Link key={o.label} href={href} className={`rounded-full border px-3 py-1 ${active ? "border-cyan/60 text-cyan" : "border-border text-muted hover:text-fg"}`}>
            {o.label}
          </Link>
        );
      })}
    </div>
  );
}

export const smallButtonClass = "inline-flex items-center justify-center rounded-md border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50";
export const smallPrimaryClass = "inline-flex items-center justify-center rounded-md bg-blue px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo disabled:opacity-50";
export const smallDangerClass = "inline-flex items-center justify-center rounded-md border border-danger/40 px-3 py-1.5 text-xs text-danger hover:bg-danger/10 disabled:opacity-50";
export const selectClass = "rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-fg focus:border-cyan/60 focus:outline-none";
