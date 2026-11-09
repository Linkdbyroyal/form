import { notFound } from "next/navigation";
import { Card, Status } from "@/components/ui";

/**
 * Placeholder for Mission Control modules that are not built yet. Implemented modules (agents, tasks, runs,
 * approvals, schedules, costs, errors) have their own routes and take precedence over this catch-all.
 */
const MODULES: Record<string, { title: string; milestone: string; text: string }> = {
  skills: { title: "Agent Skills & Versions", milestone: "M1", text: "SKILL.md versions, release channels, eval results. The data model (skills, skill_versions, skill_release_channels) exists and is pinned by agent instances; the management UI is not built yet." },
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
