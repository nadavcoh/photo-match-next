import { NextRequest, NextResponse } from 'next/server'
import { v2 as cloudinary } from 'cloudinary'
import { findPublicId } from '@/lib/cloudinary-search'

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cloudinary/media
//
// Two-step server-side pipeline:
//
//   Step 1 — Cached lookup (findPublicId via cloudinary-search.ts)
//             Translates the local filename into the real Cloudinary public_id
//             that was assigned by Dynamic Folders.  The result is cached
//             forever in Next.js's data cache; the Cloudinary Search API is
//             called at most ONCE per unique filename, globally.
//
//   Step 2 — Authenticated URL signing (cloudinary.url)
//             Generates a short-lived HMAC-SHA1 signed URL for the asset
//             stored under the `authenticated` delivery type.
//
// Request body:  { filename: string, resourceType: 'image' | 'video' }
// Response:      { url: string }
//
// ⚠️  Security: CLOUDINARY_API_SECRET stays server-side only.
// ─────────────────────────────────────────────────────────────────────────────

/** Folder used when searching Cloudinary for the asset. */
const CLOUDINARY_FOLDER = 'gphoto_phash_media'

/** Signed URLs expire after this many seconds (Cloudinary enforces server-side). */
const SIGNED_URL_TTL = 3_600 // 1 hour

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Parse & validate body ───────────────────────────────────────────────

  let filename: string
  let resourceType: 'image' | 'video'

  try {
    const body = (await request.json()) as { filename?: unknown; resourceType?: unknown }

    if (typeof body.filename !== 'string' || !body.filename.trim()) {
      return NextResponse.json(
        { error: 'filename is required and must be a non-empty string' },
        { status: 400 },
      )
    }

    filename     = body.filename.trim()
    resourceType = body.resourceType === 'video' ? 'video' : 'image'
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // ── 2. Derive the filename stem (no extension) ────────────────────────────
  //    Cloudinary's Search API `filename` field stores the original stem even
  //    in Dynamic Folders mode, so we strip the extension before searching.
  //    The regex only removes a trailing dot + 1-5 non-dot chars, so stems
  //    without extensions pass through unchanged.

  const stem = filename.replace(/\.[^.]{1,5}$/, '')

  // ── 3. Env-var guard ──────────────────────────────────────────────────────

  const cloudName = (process.env.CLOUDINARY_CLOUD_NAME ?? '').trim()
  const apiKey    = (process.env.CLOUDINARY_API_KEY    ?? '').trim()
  const apiSecret = (process.env.CLOUDINARY_API_SECRET ?? '').trim()

  if (!cloudName || !apiKey || !apiSecret) {
    console.error('[cloudinary/media] Missing CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET')
    return NextResponse.json(
      { error: 'Cloudinary is not configured on the server' },
      { status: 503 },
    )
  }

  // ── 4. Cached Dynamic-Folder public_id lookup ─────────────────────────────
  //    findPublicId is wrapped in unstable_cache (revalidate: false), so this
  //    call hits the Cloudinary Search API at most once per unique stem, ever.
  //    All subsequent calls are instant cache hits with zero API quota consumed.

  const publicId = await findPublicId(CLOUDINARY_FOLDER, stem)

  if (!publicId) {
    return NextResponse.json(
      { error: `No Cloudinary asset found for folder="${CLOUDINARY_FOLDER}" filename="${stem}"` },
      { status: 404 },
    )
  }

  // ── 5. Sign an authenticated-delivery URL ─────────────────────────────────
  //    type:       'authenticated' — matches the delivery type set during sync
  //                                  (CLI flag: -O type authenticated)
  //    sign_url:   true            — injects s--{HMAC-SHA1}-- into the URL path
  //    expires_at: <unix ts>       — embedded in the signature; tamper-proof
  //    transformation              — images only: fill-crop to the card slot

  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true })

  const expiresAt = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL

  try {
    const url = cloudinary.url(publicId, {
      resource_type: resourceType,
      type:          'authenticated',
      sign_url:      true,
      expires_at:    expiresAt,
      secure:        true,
      ...(resourceType === 'image' && {
        transformation: [{ crop: 'fill', width: 960, height: 720 }],
      }),
    })

    return NextResponse.json(
      { url },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    console.error('[cloudinary/media] cloudinary.url() threw:', err)
    return NextResponse.json({ error: 'Failed to generate signed URL' }, { status: 500 })
  }
}
