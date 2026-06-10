/**
 * src/lib/supabase-server.ts
 *
 * Server-side Supabase client using @supabase/ssr.
 * Safe to import from Route Handlers and Server Components (not middleware).
 * Uses next/headers cookies() to persist the session across requests.
 */
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // setAll was called from a Server Component — safe to ignore.
            // Middleware will handle session refreshes automatically.
          }
        },
      },
    }
  )
}
