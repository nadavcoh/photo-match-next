import { NextRequest, NextResponse } from 'next/server'
import { v2 as cloudinary } from 'cloudinary'
import { findPublicId } from '@/lib/cloudinary-search'

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cloudinary/media
//
// Two-step server-side pipeline:
//
//   Step 1 — Cached lookup (findPublicId via cloudinary-search.ts)
//             Builds the full logical path from item.path + filename, splits it
//             at the last '/' to get the exact folder and filename that
//             Cloudinary Search expects, then queries (once per asset, globally).
//
//   Step 2 — Authenticated URL signing (cloudinary.url)
//             Generates a short-lived HMAC-SHA1 signed URL for the asset
//             stored under the `authenticated` delivery type.
//
// Request body:  { filename: string, path: string, resourceType: 'image' | 'video' }
// Response:      { url: string }
//
// ⚠️  Security: CLOUDINARY_API_SECRET stays server-side only.
// ─────────────────────────────────────────────────────────────────────────────

/** Signed URLs expire after this many seconds (Cloudinary enforces server-side). */
const SIGNED_URL_TTL = 3_600 // 1 hour

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Parse & validate body ───────────────────────────────────────────────

  let filename: string
  let resourceType: 'image' | 'video'

  try {
    const body = (await request.json()) as {
      filename?: unknown
      resourceType?: unknown
    }

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

  // ── 2. Build folder + filename for the Cloudinary Search expression ────────
  //
  //    item.filename already encodes the full relative path, e.g.:
  //      "Media/972525361536-1602045182@g.us/c/d/cde30200-d234-4b57-8c74-c7675aabcc72.jpg"
  //
  //    Steps:
  //      1. Strip the file extension to get the bare path stem.
  //      2. Prepend the top-level Cloudinary folder to form the absolute path.
  //      3. Split at the LAST '/' — everything before is the folder; everything
  //         after is the filename that Cloudinary Search's `filename` field holds.
  //
  //    Example:
  //      filename              = "Media/972525361536.../c/d/cde30200....jpg"
  //      filenameWithoutExt    = "Media/972525361536.../c/d/cde30200..."
  //      fullPath              = "gphoto_phash_media/Media/972525361536.../c/d/cde30200..."
  //      folder                = "gphoto_phash_media/Media/972525361536.../c/d"
  //      stem                  = "cde30200..."

  // 1. Strip extension (dot + 1-5 non-dot chars at end); no-op if already bare.
  const filenameWithoutExtension = filename.replace(/\.[^.]{1,5}$/, '')

  // 2-3. Prepend root folder, then split at last '/'.
  const fullPath = `gphoto_phash_media/${filenameWithoutExtension}`
  const folder   = fullPath.substring(0, fullPath.lastIndexOf('/'))
  const stem     = fullPath.substring(fullPath.lastIndexOf('/') + 1)

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
  //    call hits the Cloudinary Search API at most once per unique asset, ever.
  //    All subsequent calls are instant cache hits with zero API quota consumed.

  const publicId = await findPublicId(folder, stem)

  if (!publicId) {
    return NextResponse.json(
      { error: `No Cloudinary asset found — folder:"${folder}" filename:"${stem}"` },
      { status: 404 },
    )
  }

  // ── 5. Sign an authenticated-delivery URL ─────────────────────────────────
  //    type:       'authenticated' — matches the delivery type set during sync
  //                                  (CLI flag: -O type authenticated)
  //    sign_url:   true            — injects s--{HMAC-SHA1}-- into the URL path
  //    expires_at: <unix ts>       — embedded in the signature; tamper-proof
  //    transformation              — limit to 960 px wide while preserving the
  //                                  original aspect ratio (no height cap, no crop)

  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true })

  const expiresAt = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL

  try {
    const url = cloudinary.url(publicId, {
      resource_type: resourceType,
      type:          'authenticated',
      sign_url:      true,
      expires_at:    expiresAt,
      secure:        true,
      transformation: [{ crop: 'limit', width: 960 }],
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
