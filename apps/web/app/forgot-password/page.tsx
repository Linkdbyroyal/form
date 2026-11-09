"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthLayout } from "@/components/auth-layout";
import { buttonClass, inputClass } from "@/components/ui";
import { authClient } from "@/lib/auth-client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const { error: err } = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    if (err) {
      setError(err.message ?? "Request failed");
      return;
    }
    setDone(true);
  }

  return (
    <AuthLayout title="Forgot password" intro="Enter your e-mail address. If an account exists, you receive a link to set a new password.">
      {done ? (
        <p className="text-sm text-success">If an account exists for this address, a reset link has been sent. <Link href="/sign-in" className="underline">Back to sign-in</Link></p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3">
          <input className={inputClass} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <button type="submit" className={`${buttonClass} w-full`}>Send reset link</button>
        </form>
      )}
    </AuthLayout>
  );
}
