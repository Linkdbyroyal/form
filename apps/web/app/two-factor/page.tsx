"use client";

import { useState, type FormEvent } from "react";
import { AuthLayout } from "@/components/auth-layout";
import { buttonClass, inputClass } from "@/components/ui";
import { authClient } from "@/lib/auth-client";

/** Second step of sign-in for users with TOTP enabled. */
export default function TwoFactorPage() {
  const [code, setCode] = useState("");
  const [trust, setTrust] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.twoFactor.verifyTotp({ code: code.trim(), trustDevice: trust });
    setBusy(false);
    if (err) {
      setError(err.message ?? "Invalid code");
      return;
    }
    const next = new URLSearchParams(window.location.search).get("next");
    window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  }

  return (
    <AuthLayout title="Two-factor verification" intro="Enter the 6-digit code from your authenticator app.">
      <form onSubmit={onSubmit} className="space-y-3">
        <input className={inputClass} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} /> Trust this device for 30 days
        </label>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <button type="submit" disabled={busy} className={`${buttonClass} w-full`}>Verify</button>
      </form>
    </AuthLayout>
  );
}
