import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Cookie the backend sets for the authenticated session (httpOnly JWT).
const SESSION_COOKIE = "enc_session";

// Prefixes that require an authenticated session.
const PROTECTED_PREFIXES = ["/surveys", "/members", "/settings"];

// Auth pages that a logged-in user should be bounced away from.
const AUTH_PAGES = ["/login", "/register"];

// Public auth-flow pages that must stay reachable with or without a session
// (recuperación de contraseña, verificación de email, invitaciones).
const PUBLIC_AUTH_PAGES = ["/forgot", "/reset", "/verify", "/accept-invite"];

// Next.js 16 renamed the middleware entrypoint to `proxy`. The NextResponse /
// matcher API is unchanged; only the filename and exported function name moved.
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = req.cookies.has(SESSION_COOKIE);

  // Public auth-flow pages are never gated (and never redirect away).
  if (PUBLIC_AUTH_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

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
