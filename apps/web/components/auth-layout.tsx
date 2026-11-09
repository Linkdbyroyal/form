import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Card } from "./ui";

/** Narrow centred layout for sign-in, verification, invitation and security pages. */
export function AuthLayout({ title, intro, children, footer }: { title: string; intro?: string; children?: ReactNode; footer?: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-12">
      <Link href="/" className="mb-6 block text-xs uppercase tracking-[0.25em] text-faint">Second Brain Business OS</Link>
      <Card title={title} footer={footer}>
        {intro ? <p className="mb-4 text-sm text-muted">{intro}</p> : null}
        {children}
      </Card>
      <div className="mt-4 flex gap-2"><Badge tone="success">Implemented</Badge><Badge tone="cyan">Better Auth 1.7</Badge></div>
    </main>
  );
}
