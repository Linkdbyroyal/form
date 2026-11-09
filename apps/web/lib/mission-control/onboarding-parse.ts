/**
 * Pure parsers for the client onboarding wizard (M3-09). Kept outside the "use server" module so they
 * can be exported synchronously and unit tested.
 */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/;
const KEY_RE = /^[a-z0-9_]{1,40}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const LOCALES = ["en", "nl", "pap"] as const;
const API_CAPABILITIES = ["api", "mcp", "webhook", "export", "none"] as const;
type ApiCapability = (typeof API_CAPABILITIES)[number];
const CLIENT_ROLES = ["client_admin", "department_manager", "client_employee"] as const;

export interface DepartmentLine {
  key: string;
  name: string;
  headRole: string | null;
}

export interface SystemLine {
  name: string;
  vendor: string | null;
  function: string;
  departmentKey: string | null;
  apiCapabilities: ApiCapability[];
}

/** Parses one department per line: `key|name|head role`. Head role is optional and must be a client role. */
export function parseDepartments(text: string): DepartmentLine[] {
  const out: DepartmentLine[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [key = "", name = "", headRole = ""] = line.split("|").map((s) => s.trim());
    if (!KEY_RE.test(key)) throw new Error(`department key "${key}" must be lowercase letters, digits or underscores`);
    if (!name) throw new Error(`department ${key} needs a name`);
    if (headRole && !(CLIENT_ROLES as readonly string[]).includes(headRole)) throw new Error(`department ${key}: head role must be one of ${CLIENT_ROLES.join(", ")}`);
    if (seen.has(key)) throw new Error(`department key ${key} appears twice`);
    seen.add(key);
    out.push({ key, name: name.slice(0, 120), headRole: headRole || null });
  }
  return out;
}

/** Parses one system per line: `name|vendor|function|department key|capabilities comma list`. */
export function parseSystems(text: string, departmentKeys: ReadonlySet<string>): SystemLine[] {
  const out: SystemLine[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [name = "", vendor = "", fn = "", departmentKey = "", caps = ""] = line.split("|").map((s) => s.trim());
    if (!name) throw new Error("a system line needs a name");
    if (!fn) throw new Error(`system ${name} needs a function (what it is used for)`);
    if (departmentKey && !departmentKeys.has(departmentKey)) throw new Error(`system ${name}: department key "${departmentKey}" is not in the departments list`);
    const apiCapabilities = caps
      ? caps.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean).map((c) => {
          if (!(API_CAPABILITIES as readonly string[]).includes(c)) throw new Error(`system ${name}: capability "${c}" must be one of ${API_CAPABILITIES.join(", ")}`);
          return c as ApiCapability;
        })
      : (["none"] as ApiCapability[]);
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw new Error(`system ${name} appears twice`);
    seen.add(lower);
    out.push({ name: name.slice(0, 120), vendor: vendor || null, function: fn.slice(0, 300), departmentKey: departmentKey || null, apiCapabilities: apiCapabilities.length > 0 ? apiCapabilities : ["none"] });
  }
  return out;
}

