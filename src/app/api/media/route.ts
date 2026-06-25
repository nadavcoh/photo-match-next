/**
 * src/app/api/media/route.ts
 *
 * Replaces the old /api/cloudinary/media route.
 *
 * Given a WA item's raw filename (which encodes its full relative path),
 * builds the corresponding Backblaze B2 object key and returns a short-lived
 * presigned GET URL. Unlike the old Cloudinary flow, there is no
 * search/lookup step — B2 object keys are exactly the path on disk, so the
 * key is derived with a single string operation (see lib/b2.ts).
 *
 * Request body:  { filename: string }
 * Response:      { url: string }
 *
 * ⚠️  Security: B2 application key credentials stay server-side only —
 *     see lib/b2.ts for the required env vars.
 */

import { NextRequest, NextResponse } from 'next/server'
import { buildMediaKey, getSignedMediaUrl } from '@/lib/b2'

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Parse & validate body ───────────────────────────────────────────────

  let filename: string

  try {
    const body = (await request.json()) as { filename?: unknown }

    if (typeof body.filename !== 'string' || !body.filename.trim()) {
      return NextResponse.json(
        { error: 'filename is required and must be a non-empty string' },
        { status: 400 },
      )
    }

    filename = body.filename.trim()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // ── 2. Build the B2 object key and sign a GET URL ──────────────────────────

  const key = buildMediaKey(filename)
  const url = await getSignedMediaUrl(key)

  if (!url) {
    return NextResponse.json(
      { error: `No media object found for key "${key}"` },
      { status: 404 },
    )
  }

  return NextResponse.json(
    { url },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
