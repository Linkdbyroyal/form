import Link from "next/link";
import { Badge, Status } from "@/components/ui";

const surfaces = [
  { href: "/mission-control", title: "Mission Control", text: "Operators: clients, agents, runs, approvals, costs. Cross-client metadata, content only with a grant.", state: "implemented" as const, note: "shell + client workspaces" },
  { href: "/c/northline-events", title: "Client Workspace", text: "CEO and staff: dashboards, questions, actions and the client's own Knowledge Vault.", state: "implemented" as const, note: "shell + org map + systems register" },
  { href: "/agency", title: "Agency Intelligence Vault", text: "Second Brain team: methods, skills, templates, research. Never contains client content.", state: "planned" as const, note: "Milestone 4" }
];

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <div className="text-xs uppercase tracking-[0.25em] text-faint">Second Brain AI Agency</div>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">
        <span className="sb-gradient-text">Business Transformation OS</span>
      </h1>
      <p className="mt-4 max-w-2xl text-muted">
        Multi-tenant platform where specialised AI agents diagnose a company, ask only the questions that close an evidence gap, redesign processes, build approved automations and monitor results. Agents run on our backend on schedule, event or command, and every risky action waits for a human.
      </p>
      <div className="mt-3 flex gap-2">
        <Badge tone="warning">Milestone 0: foundation</Badge>
        <Badge tone="cyan">Synthetic data only</Badge>
      </div>
      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {surfaces.map((s) => (
          <Link key={s.href} href={s.href} className="sb-card block p-5 transition hover:border-cyan/40">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{s.title}</h2>
              <Status state={s.state} />
            </div>
            <p className="mt-2 text-sm text-muted">{s.text}</p>
            <p className="mt-3 text-xs text-faint">{s.note}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
