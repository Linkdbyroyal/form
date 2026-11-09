import Link from "next/link";
import { Badge, inputClass, type Tone } from "./ui";
import type { DiffOp } from "@/lib/client/vault-helpers";

/**
 * Presentational pieces for the Knowledge Vault pages. Pure server components; no client JavaScript.
 */

const VERIFICATION_TONES: Record<string, Tone> = {
  unconfirmed: "neutral",
  hypothesis: "warning",
  evidence_backed: "cyan",
  verified: "success",
  approved_policy: "indigo",
  deprecated: "danger"
};

export function VerificationBadge({ value }: { value: string | null | undefined }) {
  if (!value) return <Badge>unknown</Badge>;
  return <Badge tone={VERIFICATION_TONES[value] ?? "neutral"}>{value.replaceAll("_", " ")}</Badge>;
}

const REQUEST_TONES: Record<string, Tone> = { open: "warning", verified: "success", rejected: "danger", merged: "neutral" };
export function RequestStateBadge({ value }: { value: string }) {
  return <Badge tone={REQUEST_TONES[value] ?? "neutral"}>{value}</Badge>;
}

const PROPOSAL_TONES: Record<string, Tone> = { pending: "warning", approved: "success", rejected: "danger" };
export function ProposalStateBadge({ value }: { value: string }) {
  return <Badge tone={PROPOSAL_TONES[value] ?? "neutral"}>{value}</Badge>;
}

/** Sub-navigation shared by the vault pages. Settings only for the client admin. */
export function VaultNav({ slug, active, showSettings }: { slug: string; active: "browse" | "review" | "facts" | "settings"; showSettings: boolean }) {
  const items: Array<{ key: typeof active; href: string; label: string }> = [
    { key: "browse", href: `/c/${slug}/vault`, label: "Browse" },
    { key: "review", href: `/c/${slug}/vault/review`, label: "Review queue" },
    { key: "facts", href: `/c/${slug}/vault/facts`, label: "Facts" }
  ];
  if (showSettings) items.push({ key: "settings", href: `/c/${slug}/vault/settings`, label: "Settings" });
  return (
    <nav className="flex flex-wrap gap-2 text-xs">
      {items.map((i) => (
        <Link key={i.key} href={i.href} className={`rounded-full border px-3 py-1 ${i.key === active ? "border-cyan/60 text-cyan" : "border-border text-muted hover:text-fg"}`}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

/** Line diff between an older revision (left, red) and the current document (right, green). */
export function DiffView({ ops }: { ops: DiffOp[] }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-xs leading-5">
      {ops.map((op, i) => (
        <div key={i} className={op.kind === "add" ? "bg-success/10 text-success" : op.kind === "del" ? "bg-danger/10 text-danger" : "text-muted"}>
          <span className="inline-block w-5 select-none text-faint">{op.kind === "add" ? "+" : op.kind === "del" ? "-" : " "}</span>
          {op.text || " "}
        </div>
      ))}
    </pre>
  );
}

/**
 * The input for one interview question, chosen by `answer_type`. Every variant submits under the name
 * `value` (multi_choice submits several), which `parseAnswerValue` turns into the typed answer.
 */
export function AnswerInput({ answerType, options, id }: { answerType: string; options: string[]; id: string }) {
  switch (answerType) {
    case "number":
      return <input id={id} name="value" type="number" step="any" required className={`${inputClass} max-w-xs`} placeholder="e.g. 12" />;
    case "boolean":
      return (
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1"><input type="radio" name="value" value="yes" required /> Yes</label>
          <label className="flex items-center gap-1"><input type="radio" name="value" value="no" /> No</label>
        </div>
      );
    case "single_choice":
      return (
        <div className="flex flex-col gap-1 text-sm">
          {options.length === 0 ? <span className="text-xs text-warning">This question offers no options; answer as free text.</span> : null}
          {options.length === 0 ? <input id={id} name="value" required className={inputClass} /> : null}
          {options.map((o) => (
            <label key={o} className="flex items-center gap-2"><input type="radio" name="value" value={o} required /> {o}</label>
          ))}
        </div>
      );
    case "multi_choice":
      return (
        <div className="flex flex-col gap-1 text-sm">
          {options.length === 0 ? <span className="text-xs text-warning">This question offers no options; answer as free text.</span> : null}
          {options.length === 0 ? <input id={id} name="value" required className={inputClass} /> : null}
          {options.map((o) => (
            <label key={o} className="flex items-center gap-2"><input type="checkbox" name="value" value={o} /> {o}</label>
          ))}
        </div>
      );
    case "date":
      return <input id={id} name="value" type="date" required className={`${inputClass} max-w-xs`} />;
    case "file":
    case "system_reference":
      return (
        <div className="space-y-1">
          <input id={id} name="value" required maxLength={4000} className={inputClass} placeholder={answerType === "file" ? "File name or location (for example: Dropbox/Finance/2025-Q3-report.pdf)" : "System and record reference (for example: Rentman project 4512)"} />
          <p className="text-xs text-faint">Attachments and live system references arrive in a later milestone (M5). Until then the reference is stored as text.</p>
        </div>
      );
    case "text":
    default:
      return <textarea id={id} name="value" required rows={3} maxLength={4000} className={inputClass} placeholder="Your answer" />;
  }
}
