import type { SecretReader } from "./types";

/**
 * Secret handling (M5-04). A `secret_ref` such as `env:RENTMAN_TOKEN_NORTHLINE` names a variable in the
 * worker's environment (Railway variables per connection). The web app never constructs a SecretReader.
 */
const REF_RE = /^env:([A-Z][A-Z0-9_]{2,80})$/;

export function parseSecretRef(ref: string): { kind: "env"; name: string } {
  const m = REF_RE.exec(ref);
  if (!m || !m[1]) throw new Error(`secret reference "${ref}" must look like env:VARIABLE_NAME`);
  return { kind: "env", name: m[1] };
}

export class EnvSecretReader implements SecretReader {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  async read(ref: string): Promise<string | null> {
    const { name } = parseSecretRef(ref);
    const value = this.env[name];
    return value && value.length > 0 ? value : null;
  }
}

/** A reader that holds nothing: used for sandbox connectors and in the metadata phase. */
export class NoSecretReader implements SecretReader {
  async read(): Promise<string | null> {
    return null;
  }
}

const TOKEN_PATTERNS = [/sk-[A-Za-z0-9]{8,}/g, /Bearer\s+[A-Za-z0-9._-]{16,}/g, /[A-Za-z0-9_-]{40,}/g];

/** Masks known secret values and anything that looks like a token before text reaches logs, run events or sync_runs. */
export function maskSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const s of knownSecrets) {
    if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  }
  for (const re of TOKEN_PATTERNS) out = out.replace(re, "[redacted]");
  return out.slice(0, 1000);
}
