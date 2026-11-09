import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic edge guard: requests to protected surfaces without a session cookie go to /sign-in
 * before any server component runs. This only checks cookie presence; the authoritative checks
 * (session validity, roles, MFA, grants) run in `lib/request-context.ts` on every page.
 * It also forwards the pathname so server components can build a `next` parameter.
 */
export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-sbos-pathname", request.nextUrl.pathname);
  if (!getSessionCookie(request)) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = `?next=${encodeURIComponent(request.nextUrl.pathname)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/mission-control/:path*", "/c/:path*", "/account/:path*"]
};
