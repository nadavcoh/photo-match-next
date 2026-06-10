/**
 * src/middleware.ts
 *
 * Replaces Basic HTTP Auth with Supabase session-based authentication.
 *
 * Rules:
 *  1. Public paths (/login, /auth/callback, static assets) pass through freely.
 *  2. All other routes require an active Supabase session.
 *  3. Even if a session exists, the authenticated user's email MUST be exactly
 *     ALLOWED_EMAIL (case-insensitive). Any other account is signed out and
 *     bounced to /login immediately.
 *
 * The createServerClient call here is intentional — middleware runs on the
 * Edge Runtime and must use request/response cookies directly rather than
 * next/headers. The pattern below is the canonical Supabase SSR middleware
 * approach and correctly propagates refreshed tokens back to the browser.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

// ── Config ─────────────────────────────────────────────────────────────────────

const ALLOWED_EMAIL = 'Cohen.n@gmail.com'

/** Paths that must never require authentication. */
const PUBLIC_PREFIXES = ['/login', '/auth/callback']

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT for the ones starting with:
     *   - _next/static  (static files)
     *   - _next/image   (image optimisation files)
     *   - favicon.ico   (browser favicon)
     *   - icons/        (PWA icons)
     *   - manifest.json (PWA manifest)
     */
    '/((?!_next/static|_next/image|favicon.ico|icons|manifest\\.json).*)',
  ],
}

// ── Middleware ─────────────────────────────────────────────────────────────────

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Pass public paths straight through — no auth required.
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next()
  }

  // We build the response object inside the closure so the cookie setAll
  // handler can replace it whenever Supabase refreshes the session token.
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options?: object }[]) {
          // Propagate new cookies onto the outgoing request so downstream
          // Server Components and Route Handlers see the refreshed session.
          cookiesToSet.forEach(({ name, value, options }) =>
            request.cookies.set(name, value, options)
          )
          // Rebuild the response so the browser also receives the updated tokens.
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // ── IMPORTANT ──────────────────────────────────────────────────────────────
  // Always call getUser() (not getSession()) here.
  // getSession() reads directly from the cookie and cannot detect revoked
  // tokens. getUser() validates the JWT against the Supabase Auth server and
  // automatically refreshes an expired session.
  // ──────────────────────────────────────────────────────────────────────────
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // ── Not authenticated → redirect to login ──────────────────────────────────
  if (!user) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    return NextResponse.redirect(loginUrl)
  }

  // ── Authenticated but wrong email → destroy session + redirect ─────────────
  if (user.email?.toLowerCase() !== ALLOWED_EMAIL.toLowerCase()) {
    // Revoke the session server-side so the token cannot be reused.
    await supabase.auth.signOut()

    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.searchParams.set('error', 'unauthorized_email')

    const redirectResponse = NextResponse.redirect(loginUrl)

    // Also clear every sb-* cookie from the browser so the client cannot
    // attempt to rehydrate a session from a stale cookie on the next request.
    request.cookies
      .getAll()
      .filter((c) => c.name.startsWith('sb-'))
      .forEach((c) => redirectResponse.cookies.delete(c.name))

    return redirectResponse
  }

  // ── Authenticated and authorised → continue ────────────────────────────────
  return response
}
