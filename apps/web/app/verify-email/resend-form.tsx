"use client";

import { useState, type FormEvent } from "react";
import { buttonSecondaryClass, inputClass } from "@/components/ui";
import { authClient } from "@/lib/auth-client";

export function ResendVerificationForm({ defaultEmail }: { defaultEmail: string }) {
  const [email, setEmail] = useState(defaultEmail);
  const [state, setState] = useState<"idle" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const { error } = await authClient.sendVerificationEmail({ email, callbackURL: "/verify-email?verified=1" });
    if (error) {
      setState("error");
      setMessage(error.message ?? "Could not send");
      return;
    }
    setState("sent");
    setMessage("If an account exists for this address, a new verification link has been sent.");
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input className={inputClass} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
      <button type="submit" className={`${buttonSecondaryClass} w-full`}>Resend verification link</button>
      {message ? <p className={`text-sm ${state === "error" ? "text-danger" : "text-success"}`}>{message}</p> : null}
    </form>
  );
}
