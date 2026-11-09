"use client";

import QRCode from "qrcode";
import { useEffect, useState, type FormEvent } from "react";
import { buttonClass, buttonSecondaryClass, inputClass } from "@/components/ui";
import { authClient } from "@/lib/auth-client";

/**
 * Better Auth twoFactor enrolment: (1) password -> TOTP URI + backup codes, (2) first code verifies
 * and flips `user.twoFactorEnabled` to true. Functional, not pretty.
 */
export function TotpEnrollment({ enabled }: { enabled: boolean }) {
  const [password, setPassword] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [svg, setSvg] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);

  useEffect(() => {
    if (!totpUri) return;
    QRCode.toString(totpUri, { type: "svg", margin: 1, width: 192 }).then(setSvg).catch(() => setSvg(null));
  }, [totpUri]);

  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: err } = await authClient.twoFactor.enable({ password, issuer: "Second Brain Business OS" });
    setBusy(false);
    if (err || !data || data.method !== "totp") {
      setError(err?.message ?? "Could not start enrolment");
      return;
    }
    setTotpUri(data.totpURI);
    setBackupCodes(data.backupCodes);
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.twoFactor.verifyTotp({ code: code.trim() });
    setBusy(false);
    if (err) {
      setError(err.message ?? "Invalid code");
      return;
    }
    setVerified(true);
    window.location.href = "/account/security";
  }

  async function disable(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.twoFactor.disable({ password });
    setBusy(false);
    if (err) {
      setError(err.message ?? "Could not disable");
      return;
    }
    window.location.href = "/account/security";
  }

  if (enabled && !totpUri) {
    return (
      <form onSubmit={disable} className="space-y-3 border-t border-border pt-4">
        <p className="text-sm text-muted">TOTP is active. To disable it (not allowed in practice for operator roles: Mission Control closes again), confirm your password.</p>
        <input className={inputClass} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Current password" />
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <button type="submit" disabled={busy} className={buttonSecondaryClass}>Disable TOTP</button>
      </form>
    );
  }

  if (!totpUri) {
    return (
      <form onSubmit={start} className="space-y-3 border-t border-border pt-4">
        <p className="text-sm text-muted">Step 1: confirm your password to generate a TOTP secret.</p>
        <input className={inputClass} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Current password" />
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <button type="submit" disabled={busy} className={buttonClass}>Generate TOTP secret</button>
      </form>
    );
  }

  return (
    <div className="space-y-4 border-t border-border pt-4">
      <p className="text-sm text-muted">Step 2: scan the QR code or paste the URI into your authenticator app, then enter the current 6-digit code.</p>
      {svg ? <div className="inline-block rounded-md bg-white p-2" dangerouslySetInnerHTML={{ __html: svg }} /> : null}
      <textarea readOnly className={`${inputClass} font-mono text-xs`} rows={3} value={totpUri} />
      <details className="text-xs text-muted">
        <summary className="cursor-pointer">Backup codes (store them now; shown once)</summary>
        <ul className="mt-2 grid grid-cols-2 gap-1 font-mono">{backupCodes.map((c) => <li key={c}>{c}</li>)}</ul>
      </details>
      <form onSubmit={verify} className="space-y-3">
        <input className={inputClass} inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <button type="submit" disabled={busy || verified} className={buttonClass}>{verified ? "Verified" : "Verify and enable"}</button>
      </form>
    </div>
  );
}
