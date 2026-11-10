import Link from "next/link";
import type { ReactNode } from "react";
import { AccountMenu } from "./account-menu";

export interface NavItem {
  href: string;
  label: string;
  milestone: "M0" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6";
}

export async function Shell({ title, subtitle, nav, children }: { title: string; subtitle: string; nav: NavItem[]; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* Small screens: top bar with title, account menu and a scrollable navigation. */}
      <div className="border-b border-border bg-surface md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <div>
            <Link href="/" className="block text-[10px] uppercase tracking-[0.2em] text-faint">Second Brain</Link>
            <div className="text-base font-semibold sb-gradient-text">{title}</div>
          </div>
          <AccountMenu align="right" />
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg">{item.label}</Link>
          ))}
        </nav>
      </div>
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface md:flex">
        <div className="px-5 py-5">
          <Link href="/" className="block text-xs uppercase tracking-[0.2em] text-faint">Second Brain</Link>
          <div className="mt-1 text-lg font-semibold sb-gradient-text">{title}</div>
          <div className="text-xs text-muted">{subtitle}</div>
        </div>
        <div className="mx-5 h-px sb-gradient-bar opacity-60" />
        <nav className="mt-3 flex flex-col gap-0.5 px-3">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg">
              <span>{item.label}</span>
              <span className="text-[10px] text-faint">{item.milestone}</span>
            </Link>
          ))}
        </nav>
        <div className="mt-auto border-t border-border px-3 py-3">
          <AccountMenu align="left" />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8">{children}</main>
        <footer className="border-t border-border px-4 py-3 text-[11px] text-faint">
          Second Brain Business OS v0.1.0 · synthetic data only · every page states what is implemented, simulated or not connected
        </footer>
      </div>
    </div>
  );
}

export const MISSION_CONTROL_NAV: NavItem[] = [
  { href: "/mission-control", label: "Overview", milestone: "M0" },
  { href: "/mission-control/clients", label: "Client Workspaces", milestone: "M0" },
  { href: "/mission-control/agents", label: "Agents", milestone: "M1" },
  { href: "/mission-control/tasks", label: "Tasks", milestone: "M1" },
  { href: "/mission-control/runs", label: "Runs & Traces", milestone: "M1" },
  { href: "/mission-control/approvals", label: "Approvals", milestone: "M1" },
  { href: "/mission-control/skills", label: "Agent Skills & Versions", milestone: "M1" },
  { href: "/mission-control/schedules", label: "Schedules", milestone: "M1" },
  { href: "/mission-control/costs", label: "Costs", milestone: "M1" },
  { href: "/mission-control/errors", label: "Errors & Incidents", milestone: "M1" },
  { href: "/mission-control/tools", label: "Connected Tools", milestone: "M5" },
  { href: "/mission-control/agency-vault", label: "Agency Intelligence Vault", milestone: "M4" },
  { href: "/mission-control/tech-watch", label: "Tech Watch", milestone: "M6" },
  { href: "/mission-control/governance", label: "Data governance", milestone: "M6" },
  { href: "/mission-control/team", label: "Agency Team", milestone: "M1" }
];

/** Navigation for agency staff without an operator role (agency_reviewer, agency_consultant): the Agency Intelligence Vault only. */
export const AGENCY_STAFF_NAV: NavItem[] = [
  { href: "/agency", label: "Overview", milestone: "M4" },
  { href: "/mission-control/agency-vault", label: "Knowledge Library", milestone: "M4" },
  { href: "/mission-control/agency-vault/reviews", label: "Pending Knowledge Reviews", milestone: "M4" },
  { href: "/mission-control/agency-vault/templates", label: "Templates & adoptions", milestone: "M4" },
  { href: "/mission-control/agency-vault/history", label: "Version History", milestone: "M4" },
  { href: "/mission-control/tech-watch", label: "Tech Watch", milestone: "M6" }
];

export function clientNav(slug: string): NavItem[] {
  return [
    { href: `/c/${slug}`, label: "Workspace", milestone: "M0" },
    { href: `/c/${slug}/dashboard`, label: "CEO Dashboard", milestone: "M3" },
    { href: `/c/${slug}/x-ray`, label: "Business X-Ray", milestone: "M3" },
    { href: `/c/${slug}/inbox`, label: "Interview Inbox", milestone: "M2" },
    { href: `/c/${slug}/actions`, label: "Action Center", milestone: "M3" },
    { href: `/c/${slug}/agents`, label: "Client Agent Center", milestone: "M1" },
    { href: `/c/${slug}/integrations`, label: "Integration Center", milestone: "M5" },
    { href: `/c/${slug}/vault`, label: "Knowledge Vault", milestone: "M2" },
    { href: `/c/${slug}/retention`, label: "Data & Retention", milestone: "M6" }
  ];
}
