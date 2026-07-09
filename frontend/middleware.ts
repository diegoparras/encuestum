import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Cookie the backend sets for the authenticated session (httpOnly JWT).
const SESSION_COOKIE = "enc_session";

// Prefixes that require an authenticated session.
const PROTECTED_PREFIXES = ["/surveys", "/members", "/settings"];

const AUTH_PAGES = ["/login", "/register"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = req.cookies.has(SESSION_COOKIE);

  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
  const isAuthPage = AUTH_PAGES.includes(pathname);

  // Not logged in trying to reach a protected route → send to login.
  if (isProtected && !hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Already logged in but on login/register → send to the app.
  if (isAuthPage && hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/surveys";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

// Only run on app routes. Excludes `/`, `/s/*` (public), `/api`, and static
// assets. The matcher below skips Next internals and anything with a file
// extension, plus the public survey pages and api routes.
export const config = {
  matcher: [
    "/((?!api|s/|_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)",
  ],
};
