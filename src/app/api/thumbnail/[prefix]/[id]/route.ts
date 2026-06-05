import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { thumbnailStoragePath, ThumbnailPrefix } from '@/lib/thumbnails'

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  SECURITY: The Service Role Key grants full, unrestricted access to your
//    Supabase project, bypassing ALL Row Level Security policies.
//
//    • NEVER import or use this key in client-side code or browser bundles.
//    • NEVER log it, expose it in responses, or commit it to source control.
//    • It must only ever exist in server-side Route Handlers like this one,
//      loaded exclusively from environment variables at runtime.
// ─────────────────────────────────────────────────────────────────────────────

const BUCKET = 'thumbnails'
const SIGNED_URL_TTL_SECONDS = 60
const VALID_PREFIXES = new Set<ThumbnailPrefix>(['wa', 'hashes', 'partner'])

interface Params {
  params: Promise<{ prefix: string; id: string }>
}

export async function GET(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  // ── Validate route params ──────────────────────────────────────────────────

  const { prefix, id: idStr } = await params

  if (!VALID_PREFIXES.has(prefix as ThumbnailPrefix)) {
    return NextResponse.json({ error: 'Invalid prefix' }, { status: 400 })
  }

  const id = parseInt(idStr, 10)
  if (!Number.isFinite(id) || id < 0) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  // ── Guard: both env vars must be present ──────────────────────────────────

  const supabaseUrl = (process.env.SUPABASE_URL ?? '').trim()
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[thumbnail] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set')
    return NextResponse.json(
      { error: 'Storage is not configured on the server' },
      { status: 503 }
    )
  }

  // ── Create a server-only Supabase client with the Service Role Key ─────────
  //    persistSession: false — this is a stateless server route; no cookies/JWT.

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  })

  // ── Generate a short-lived signed URL for the private bucket ──────────────

  const storagePath = thumbnailStoragePath(prefix as ThumbnailPrefix, id)

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)

  if (error || !data?.signedUrl) {
    console.error('[thumbnail] createSignedUrl failed:', error?.message)
    return NextResponse.json(
      { error: 'Could not generate signed URL' },
      { status: 500 }
    )
  }

  return NextResponse.json(
    { signedUrl: data.signedUrl },
    {
      headers: {
        // Signed URLs are single-use and expire in 60 s — never cache this response.
        'Cache-Control': 'no-store',
      },
    }
  )
}
