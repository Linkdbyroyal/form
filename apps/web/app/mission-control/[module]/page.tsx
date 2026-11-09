import { notFound } from "next/navigation";
import { Card, Status } from "@/components/ui";

const MODULES: Record<string, { title: string; milestone: string; text: string }> = {
  agents: { title: "Agents", milestone: "M1", text: "Agent definitions, instances per tenant, Agent Detail with assign task, feedback, pause, resume, stop, re-run." },
  tasks: { title: "Tasks", milestone: "M1", text: "AgentTask contract with owner, priority, due date and state machine." },
  runs: { title: "Runs & Traces", milestone: "M1", text: "Run timeline with steps, tools, inputs read, tokens, costs, outputs and masked secrets." },
  approvals: { title: "Approvals", milestone: "M1", text: "Approval queue. Risky actions are blocked by database constraints until approved." },
  skills: { title: "Agent Skills & Versions", milestone: "M1", text: "SKILL.md versions, release channels, eval results." },
  schedules: { title: "Schedules", milestone: "M1", text: "Cron and event schedules per agent instance, expected-by times and the stall alarm." },
  costs: { title: "Costs", milestone: "M1", text: "Token and API cost per tenant, agent and run; budget caps." },
  errors: { title: "Errors & Incidents", milestone: "M1", text: "Failed runs, dead-letter jobs, missed schedules, connection errors." },
  tools: { title: "Connected Tools", milestone: "M5", text: "Connections per tenant with phase metadata → read-only → sandbox → write and consent status." },
  "agency-vault": { title: "Agency Intelligence Vault", milestone: "M4", text: "Knowledge Library, Skills Registry, Interview Library, Industry Blueprints, Design System, Tech Watch, Pending Knowledge Reviews, Version History." }
};

export default async function ModulePlaceholder({ params }: { params: Promise<{ module: string }> }) {
  const { module } = await params;
  const m = MODULES[module];
  if (!m) notFound();
  return (
    <div className="space-y-6">
      <header><h1 className="text-2xl font-semibold">{m.title}</h1><p className="text-sm text-muted">{m.text}</p></header>
      <Card title="Status">
        <p className="text-sm"><Status state="planned" /> Scheduled for milestone {m.milestone}. This page is intentionally empty: no mock data is shown for features that do not exist yet.</p>
      </Card>
    </div>
  );
}
