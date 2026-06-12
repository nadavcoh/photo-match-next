import { NextRequest, NextResponse } from 'next/server'
import { v2 as cloudinary } from 'cloudinary'

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cloudinary/sign
//
// Generates a short-lived signed URL for a Cloudinary asset stored under the
// `private` delivery type.  The Cloudinary API secret is consumed exclusively
// here — it is a server-only env var and must never appear in any
// NEXT_PUBLIC_ variable or in client-side code.
//
// Request body:  { publicId: string, resourceType: 'image' | 'video' }
// Response:      { url: string }  — HMAC-SHA1 signed, expires in SIGNED_URL_TTL
// ─────────────────────────────────────────────────────────────────────────────

/** Only public_ids under this prefix can be signed by this endpoint.
 *  Prevents the route from being weaponised to sign arbitrary Cloudinary assets. */
const ALLOWED_FOLDER_PREFIX = 'gphoto_phash_media/'

/** Signed URLs expire after this many seconds.
 *  Cloudinary enforces the expiry server-side via the `expires_at` field
 *  which is included in the HMAC-SHA1 signature itself. */
const SIGNED_URL_TTL = 3_600 // 1 hour

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Parse & validate the request body ───────────────────────────────────

  let publicId: string
  let resourceType: 'image' | 'video'

  try {
    const body = (await request.json()) as { publicId?: unknown; resourceType?: unknown }

    if (typeof body.publicId !== 'string' || !body.publicId.trim()) {
      return NextResponse.json({ error: 'publicId is required and must be a non-empty string' }, { status: 400 })
    }

    publicId = body.publicId.trim()
    resourceType = body.resourceType === 'video' ? 'video' : 'image'
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // ── 2. Guard: publicId must be within the allowed folder ───────────────────
  //    This is a defence-in-depth check — the middleware already enforces
  //    Supabase session auth, so only authenticated users can reach this route.
  //    The folder check additionally prevents signing arbitrary Cloudinary paths.

  if (!publicId.startsWith(ALLOWED_FOLDER_PREFIX)) {
    return NextResponse.json(
      { error: `publicId must start with "${ALLOWED_FOLDER_PREFIX}"` },
      { status: 403 },
    )
  }

  // ── 3. Guard: required server-only env vars ────────────────────────────────

  const cloudName = (process.env.CLOUDINARY_CLOUD_NAME ?? '').trim()
  const apiKey    = (process.env.CLOUDINARY_API_KEY    ?? '').trim()
  const apiSecret = (process.env.CLOUDINARY_API_SECRET ?? '').trim()

  if (!cloudName || !apiKey || !apiSecret) {
    console.error(
      '[cloudinary/sign] One or more required env vars are missing: ' +
      'CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET',
    )
    return NextResponse.json(
      { error: 'Cloudinary is not configured on the server' },
      { status: 503 },
    )
  }

  // ── 4. Configure the Cloudinary SDK ───────────────────────────────────────
  //    Configured per-request rather than at module scope so that env vars
  //    are always read from the live process environment (works correctly in
  //    both local dev and Vercel's serverless runtime).

  cloudinary.config({
    cloud_name: cloudName,
    api_key:    apiKey,
    api_secret: apiSecret,
    secure:     true,   // always use https://
  })

  // ── 5. Generate a signed private-delivery URL ──────────────────────────────
  //
  //    sign_url:   true       — injects s--{HMAC-SHA1}-- into the URL path
  //    type:       'private'  — matches the delivery type used when syncing assets
  //    expires_at: <unix ts>  — Cloudinary validates this server-side; it is
  //                             included in the signature so it cannot be tampered
  //    transformation         — applied to images only (fill-crop to card width)

  const expiresAt = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL

  try {
    const url = cloudinary.url(publicId, {
      resource_type: resourceType,
      type:          'private',
      sign_url:      true,
      expires_at:    expiresAt,
      secure:        true,
      ...(resourceType === 'image' && {
        // Crop to fill the full-width card slot (960 × 720, 4:3).
        // The transformation is part of the signed URL — clients cannot swap it.
        transformation: [{ crop: 'fill', width: 960, height: 720 }],
      }),
    })

    return NextResponse.json(
      { url },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    console.error('[cloudinary/sign] cloudinary.url() threw:', err)
    return NextResponse.json({ error: 'Failed to generate signed URL' }, { status: 500 })
  }
}
