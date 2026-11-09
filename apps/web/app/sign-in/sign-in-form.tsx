"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { buttonClass, buttonSecondaryClass, inputClass } from "@/components/ui";
import { authClient } from "@/lib/auth-client";

type ProviderId = "google" | "microsoft";

export function SignInForm({ next, providers }: { next: string; providers: ProviderId[] }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setUnverified(false);
    const { error: err } = await authClient.signIn.email({ email, password, callbackURL: next });
    setBusy(false);
    if (err) {
      if (err.status === 403) {
        // requireEmailVerification: Better Auth sent a fresh verification mail before answering 403.
        setUnverified(true);
        return;
      }
      setError(err.message ?? "Sign-in failed");
      return;
    }
    // A user with TOTP enabled is redirected to /two-factor by the twoFactor client plugin.
    window.location.href = next;
  }

  async function social(provider: ProviderId) {
    setError(null);
    const { error: err } = await authClient.signIn.social({ provider, callbackURL: next });
    if (err) setError(err.message ?? `Sign-in with ${provider} failed`);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <label className="block text-sm">
        <span className="text-muted">E-mail</span>
        <input className={`${inputClass} mt-1`} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="block text-sm">
        <span className="text-muted">Password</span>
        <input className={`${inputClass} mt-1`} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {unverified ? (
        <p className="text-sm text-warning">
          This e-mail address is not verified yet. A new verification link has been sent. <Link href={`/verify-email?email=${encodeURIComponent(email)}`} className="underline">Details</Link>
        </p>
      ) : null}
      <button type="submit" disabled={busy} className={`${buttonClass} w-full`}>{busy ? "Signing in" : "Sign in"}</button>
      <div className="flex justify-between text-xs text-muted">
        <Link href="/forgot-password" className="underline">Forgot password</Link>
        <Link href="/verify-email" className="underline">Resend verification</Link>
      </div>
      {providers.length > 0 ? (
        <div className="space-y-2 border-t border-border pt-3">
          {providers.map((p) => (
            <button key={p} type="button" onClick={() => social(p)} className={`${buttonSecondaryClass} w-full`}>
              Continue with {p === "google" ? "Google" : "Microsoft"}
            </button>
          ))}
        </div>
      ) : (
        <p className="border-t border-border pt-3 text-xs text-faint">Google and Microsoft sign-in: not connected (set GOOGLE_* or MICROSOFT_* environment variables).</p>
      )}
    </form>
  );
}
