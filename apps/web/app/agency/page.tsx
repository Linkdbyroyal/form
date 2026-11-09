import { Card, Status } from "@/components/ui";
import { Shell } from "@/components/shell";

export default function AgencyVault() {
  return (
    <Shell title="Agency Vault" subtitle="Second Brain intelligence" nav={[{ href: "/agency", label: "Overview", milestone: "M4" }]}>
      <header><h1 className="text-2xl font-semibold">Agency Intelligence Vault</h1></header>
      <Card title="Status">
        <p className="text-sm"><Status state="planned" /> Milestone 4. Knowledge Library, Skills Registry, Interview Library, Industry Blueprints, Design System, Tech Watch, Pending Knowledge Reviews, Version History. Contains only Second Brain's own or explicitly released generic knowledge.</p>
      </Card>
    </Shell>
  );
}
