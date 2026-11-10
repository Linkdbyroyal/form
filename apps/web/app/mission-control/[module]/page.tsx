import { notFound } from "next/navigation";
import { Card, Status } from "@/components/ui";

/**
 * Placeholder for Mission Control modules that are not built yet. Implemented modules (agents, tasks, runs,
 * approvals, schedules, costs, errors, vaults, agency-vault, tools) have their own routes and take precedence over this catch-all.
 */
const MODULES: Record<string, { title: string; milestone: string; text: string }> = {
  skills: { title: "Agent Skills & Versions", milestone: "M1", text: "SKILL.md versions, release channels, eval results. The data model (skills, skill_versions, skill_release_channels) exists and is pinned by agent instances. The read-only Skills Registry is a view of the Agency Intelligence Vault; skill releases (a new immutable version moving the stable channel, with a test result and rollback) now go through the Upgrade Center under Tech Watch (M6). A skill editing UI is not built yet." }
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
