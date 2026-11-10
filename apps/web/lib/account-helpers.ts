/** Pure helpers for the account menu and the no-access page (unit tested). */

/** Initials for the avatar: first letters of up to two words of the name, else the first letter of the e-mail. */
export function initialsOf(name: string, email: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  if (words.length === 1 && words[0]!.length > 0) return words[0]!.slice(0, 2).toUpperCase();
  return (email[0] ?? "?").toUpperCase();
}

/**
 * Where an authenticated user without the required role goes. Never /sign-in: the sign-in page sends a signed-in
 * user straight back to `next`, which looped forever for an account without memberships (observed on staging).
 */
export function noAccessPath(area: string): string {
  const safe = area.startsWith("/") && !area.startsWith("//") ? area : "/";
  return `/no-access?area=${encodeURIComponent(safe)}`;
}
