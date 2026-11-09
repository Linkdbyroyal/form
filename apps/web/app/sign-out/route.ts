import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** POST /sign-out: revokes the Better Auth session and clears its cookies, then returns to /sign-in. */
export async function POST(request: Request) {
  const res = await auth.api.signOut({ headers: request.headers, asResponse: true });
  const redirectRes = new Response(null, { status: 303, headers: { Location: "/sign-in?signed_out=1" } });
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") redirectRes.headers.append("set-cookie", value);
  });
  return redirectRes;
}
