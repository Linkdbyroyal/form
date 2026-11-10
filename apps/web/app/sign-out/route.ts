import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * POST /sign-out: revokes the Better Auth session and clears its cookies, then returns to /sign-in. An optional
 * form field `next` (a path on this site) is carried into the sign-in page, which is how "Switch account" returns
 * the next user to the page they were on.
 */
export async function POST(request: Request) {
  let next: string | null = null;
  try {
    const form = await request.formData();
    const raw = form.get("next");
    if (typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//")) next = raw;
  } catch {
    next = null;
  }
  const res = await auth.api.signOut({ headers: request.headers, asResponse: true });
  const location = next ? `/sign-in?signed_out=1&next=${encodeURIComponent(next)}` : "/sign-in?signed_out=1";
  const redirectRes = new Response(null, { status: 303, headers: { Location: location } });
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") redirectRes.headers.append("set-cookie", value);
  });
  return redirectRes;
}
