import type { ConnectorDescriptor } from "@sbos/connectors";
import { Badge, Card, Status } from "./ui";
import { connectionStatusTone, consentTone, PHASE_EXPLANATIONS, PHASES, phaseChangeKindTone, phaseLabel, phaseTone, readSummary, reviewOutcomeTone, scopesForPhase, syncStatusTone } from "@/lib/client/integration-helpers";

/** Presentational pieces shared by the Integration Center (client) and Connected Tools (Mission Control). Server components only. */

export function PhaseBadge({ phase }: { phase: string }) {
  return <Badge tone={phaseTone(phase)}>{phaseLabel(phase)}</Badge>;
}

export function ConnectionStatusBadge({ status }: { status: string }) {
  return <Badge tone={connectionStatusTone(status)}>{status.replaceAll("_", " ")}</Badge>;
}

export function ConsentBadge({ consent }: { consent: string }) {
  return <Badge tone={consentTone(consent)}>consent {consent}</Badge>;
}

export function SyncStatusBadge({ status }: { status: string }) {
  return <Badge tone={syncStatusTone(status)}>{status}</Badge>;
}

export function PhaseChangeKindBadge({ kind }: { kind: string }) {
  return <Badge tone={phaseChangeKindTone(kind)}>{kind.replaceAll("_", " ")}</Badge>;
}

export function ReviewOutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) return null;
  return <Badge tone={reviewOutcomeTone(outcome)}>review {outcome}</Badge>;
}

export function ModeBadge({ mode }: { mode: string }) {
  return mode === "sandbox" ? <Badge tone="warning">sandbox: simulated</Badge> : <Badge tone="success">live</Badge>;
}

/** The phase ladder with the current phase highlighted. */
export function PhaseLadder({ phase }: { phase: string }) {
  return (
    <ol className="flex flex-wrap items-center gap-1 text-xs">
      {PHASES.map((p, i) => {
        const current = p === phase;
        return (
          <li key={p} className="flex items-center gap-1">
            {i > 0 ? <span className="text-faint">&rarr;</span> : null}
            <span className={`rounded-full border px-2 py-0.5 ${current ? "border-cyan/60 text-cyan font-medium" : p === "write" ? "border-danger/30 text-faint line-through" : "border-border text-faint"}`} title={p === "write" ? "refused by the database in this release" : PHASE_EXPLANATIONS[p].text}>
              {phaseLabel(p)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Plain-language explanation of the phases and of what a provider reads and never reads. */
export function PhaseExplainer({ descriptor }: { descriptor: ConnectorDescriptor | null }) {
  return (
    <div className="space-y-3 text-sm">
      <dl className="grid gap-2 md:grid-cols-2">
        {PHASES.map((p) => (
          <div key={p} className="rounded-card border border-border p-3">
            <dt className="flex items-center gap-2 font-medium"><PhaseBadge phase={p} />{PHASE_EXPLANATIONS[p].title}{p === "write" ? <Badge tone="danger">refused</Badge> : null}</dt>
            <dd className="mt-1 text-xs text-muted">{PHASE_EXPLANATIONS[p].text}</dd>
          </div>
        ))}
      </dl>
      {descriptor ? (
        <div className="rounded-card border border-border p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">What {descriptor.displayName} read-only access reads</div>
          <ul className="mt-2 space-y-1 text-xs">
            {readSummary(descriptor).map((o) => (
              <li key={o.kind}>
                <span className="font-medium text-fg">{o.kind}</span>: <span className="font-mono text-muted">{o.fields}</span>
                <div className="text-faint">Never read: {o.excluded}</div>
              </li>
            ))}
          </ul>
          <div className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted">Scopes per phase</div>
          <ul className="mt-1 space-y-1 text-xs">
            {(["metadata", "read_only", "sandbox"] as const).map((p) => (
              <li key={p} className="flex flex-wrap items-start gap-2">
                <PhaseBadge phase={p} />
                <span className="text-muted">{scopesForPhase(descriptor, p).map((s) => `${s.scope}: ${s.gloss}`).join(" | ")}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 text-xs text-faint">Metrics derived: {descriptor.metrics.map((m) => `${m.name} = ${m.formula} [${m.sourceField}]`).join("; ")}. Vendor documentation: <span className="font-mono">{descriptor.docsUrl}</span></div>
        </div>
      ) : null}
    </div>
  );
}

/** The implementation status card every Milestone 5 page shows. */
export function IntegrationStatusCard({ implemented }: { implemented: string[] }) {
  return (
    <Card title="Implementation status">
      <ul className="space-y-1 text-sm">
        {implemented.map((item) => (
          <li key={item} className="flex items-start gap-2"><Status state="implemented" /><span>{item}</span></li>
        ))}
        <li className="flex items-start gap-2"><Status state="simulated" /><span>Sandbox connectors: deterministic synthetic fixtures per tenant, no network call, every reading labelled simulated.</span></li>
        <li className="flex items-start gap-2"><Status state="not_connected" /><span>Live connectors (Rentman, QuickBooks Online, Trengo, Dropbox): not connected (M5-05 to M5-07). Asking for live mode is an explicit error, never a silent fallback to fixtures.</span></li>
        <li className="flex items-start gap-2"><Status state="planned" /><span>Langfuse exporter: planned.</span></li>
        <li className="flex items-start gap-2"><Status state="not_connected" /><span>Write phase: refused by the database in this release.</span></li>
      </ul>
    </Card>
  );
}
