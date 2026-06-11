/**
 * src/lib/supabase-client.ts
 *
 * Browser-side Supabase client using @supabase/ssr.
 * Only import from 'use client' components.
 */
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
