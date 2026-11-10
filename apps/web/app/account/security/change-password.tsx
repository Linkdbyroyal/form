"use client";

import { useState, type FormEvent } from "react";
import { buttonSecondaryClass, inputClass } from "@/components/ui";
import { authClient } from "@/lib/auth-client";

/** Better Auth changePassword: current password required, other sessions revoked. */
export function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 12) return setError("The new password must be at least 12 characters.");
    if (next !== confirm) return setError("The confirmation does not match the new password.");
    if (next === current) return setError("Choose a password that differs from the current one.");
    setBusy(true);
    const { error: err } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
    setBusy(false);
    if (err) return setError(err.message ?? "Could not change the password");
    setDone(true);
    setCurrent("");
    setNext("");
    setConfirm("");
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-3 border-t border-border pt-4">
      <h2 className="text-sm font-semibold">Change password</h2>
      <p className="text-xs text-muted">At least 12 characters. Other sessions are signed out after the change.</p>
      <input className={inputClass} type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" />
      <input className={inputClass} type="password" autoComplete="new-password" minLength={12} required value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password (12+ characters)" />
      <input className={inputClass} type="password" autoComplete="new-password" minLength={12} required value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat new password" />
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      {done ? <p className="text-sm text-success">Password changed.</p> : null}
      <button type="submit" disabled={busy} className={buttonSecondaryClass}>{busy ? "Changing" : "Change password"}</button>
    </form>
  );
}
