/**
 * src/lib/supabase-client.ts
 *
 * Browser-side Supabase client using @supabase/ssr.
 * Safe to import from 'use client' components only.
 * Creates a new client instance per call (singleton handled internally by the package).
 */
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
