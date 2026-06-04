import { NextRequest, NextResponse } from 'next/server'
import { thumbnailStoragePath, ThumbnailPrefix } from '@/lib/thumbnails'

const VALID_PREFIXES = new Set<ThumbnailPrefix>(['wa', 'hashes', 'partner'])

interface Params {
  params: Promise<{ prefix: string; id: string }>
}

export async function GET(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { prefix, id: idStr } = await params

  if (!VALID_PREFIXES.has(prefix as ThumbnailPrefix)) {
    return NextResponse.json({ error: 'Invalid prefix' }, { status: 400 })
  }

  const id = parseInt(idStr, 10)
  if (!Number.isFinite(id) || id < 0) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  // Build the CDN URL directly — never call thumbnailUrl() here.
  // thumbnailUrl() falls back to /api/thumbnail/... when SUPABASE_URL is unset,
  // which would redirect back to this same route and cause an infinite loop.
  const supabaseUrl = (process.env.SUPABASE_URL ?? '').trim()
  if (!supabaseUrl) {
    return NextResponse.json(
      { error: 'SUPABASE_URL is not configured — cannot resolve thumbnail' },
      { status: 503 }
    )
  }

  const path = thumbnailStoragePath(prefix as ThumbnailPrefix, id)
  const url = `${supabaseUrl}/storage/v1/object/public/thumbnails/${path}`
  return NextResponse.redirect(url, {
    status: 302,
    headers: {
      // Let the browser cache the redirect for one hour
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
