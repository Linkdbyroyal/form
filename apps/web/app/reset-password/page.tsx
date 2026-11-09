"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { AuthLayout } from "@/components/auth-layout";
import { buttonClass, inputClass } from "@/components/ui";
import { authClient } from "@/lib/auth-client";

function ResetForm() {
  const params = useSearchParams();
  const token = params.get("token");
  const invalid = params.get("error");
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setError(null);
    const { error: err } = await authClient.resetPassword({ newPassword: password, token });
    if (err) {
      setError(err.message ?? "Reset failed");
      return;
    }
    setDone(true);
  }

  if (invalid || !token) {
    return <p className="text-sm text-danger">This reset link is invalid or expired. <Link href="/forgot-password" className="underline">Request a new one</Link>.</p>;
  }
  if (done) {
    return <p className="text-sm text-success">Password updated. <Link href="/sign-in" className="underline">Sign in</Link>.</p>;
  }
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input className={inputClass} type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password (12+ characters)" />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <button type="submit" className={`${buttonClass} w-full`}>Set new password</button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthLayout title="Set a new password">
      <Suspense fallback={null}>
        <ResetForm />
      </Suspense>
    </AuthLayout>
  );
}
