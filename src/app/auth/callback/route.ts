/**
 * src/app/auth/callback/route.ts
 *
 * OAuth callback route — Supabase redirects here after GitHub auth with a
 * one-time `code` query parameter.  This handler:
 *   1. Exchanges the code for a user session (PKCE flow).
 *   2. Persists the session tokens as HttpOnly cookies via @supabase/ssr.
 *   3. Redirects the browser to the originally-requested page (or /).
 *
 * On any failure, the user is sent to /login?error=auth_error so they see
 * a human-readable message rather than a blank error screen.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url)

  const code = searchParams.get('code')
  // `next` lets us send the user back to the page they originally tried to
  // reach before being redirected to login.  Defaults to /.
  const next = searchParams.get('next') ?? '/'

  if (!code) {
    // No code in the URL — something went wrong on GitHub's side.
    return NextResponse.redirect(`${origin}/login?error=auth_error`)
  }

  const cookieStore = await cookies()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options?: object }[]) {
          // Persist the session tokens in HttpOnly cookies so middleware and
          // Server Components can read them on subsequent requests.
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )

  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    console.error('[/auth/callback] exchangeCodeForSession failed:', error.message)
    return NextResponse.redirect(`${origin}/login?error=auth_error`)
  }

  // Session established — send the user to their destination.
  // The middleware will immediately validate the session and email before
  // serving the page, so no extra check is needed here.
  return NextResponse.redirect(`${origin}${next}`)
}
