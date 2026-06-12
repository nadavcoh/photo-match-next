/**
 * src/lib/supabase-server.ts
 *
 * Server-side Supabase client using @supabase/ssr.
 * Safe to use in Route Handlers and Server Components (not middleware).
 * Reads the active session from Next.js cookies so the user's JWT is
 * automatically forwarded to every PostgREST / Storage request.
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
        setAll(cookiesToSet: { name: string; value: string; options?: object }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Called from a Server Component — session refresh handled by middleware.
          }
        },
      },
    }
  )
}
