"use client";

import { useState, type FormEvent } from "react";
import { buttonClass, inputClass } from "@/components/ui";
import { authClient } from "@/lib/auth-client";
import { createAccountFromInvitation } from "./actions";

export function AcceptInvitationButton({ invitationId, destination }: { invitationId: string; destination: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function accept() {
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.organization.acceptInvitation({ invitationId });
    setBusy(false);
    if (err) {
      setError(err.message ?? "Could not accept the invitation");
      return;
    }
    window.location.href = destination;
  }
  return (
    <div className="space-y-2">
      <button type="button" onClick={accept} disabled={busy} className={`${buttonClass} w-full`}>Accept invitation</button>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}

export function InvitationSignUpForm({ invitationId, email }: { invitationId: string; email: string }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await createAccountFromInvitation({ invitationId, name, password });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDone(true);
  }

  if (done) {
    return <p className="text-sm text-success">Account created. Check {email} for the verification link, then sign in; you will return to this invitation.</p>;
  }
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input className={inputClass} type="email" value={email} disabled />
      <input className={inputClass} type="text" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
      <input className={inputClass} type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (12+ characters)" />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <button type="submit" disabled={busy} className={`${buttonClass} w-full`}>Create account</button>
    </form>
  );
}
