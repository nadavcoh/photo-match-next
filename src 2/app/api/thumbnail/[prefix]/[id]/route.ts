import { NextRequest, NextResponse } from 'next/server'
import { thumbnailPublicUrl, ThumbnailPrefix } from '@/lib/thumbnails'

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

  try {
    const url = thumbnailPublicUrl(prefix as ThumbnailPrefix, id)
    return NextResponse.redirect(url, {
      status: 302,
      headers: {
        // Let the browser cache the redirect for one hour
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
