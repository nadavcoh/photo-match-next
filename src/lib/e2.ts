/**
 * src/lib/e2.ts
 *
 * Server-side helper for the small JPEG thumbnails, which live in an IDrive e2
 * bucket (S3-compatible). Thumbnails used to be in Supabase Storage; moving
 * them out removed ~250k rows from storage.objects (the biggest table in the
 * database).
 *
 * This is deliberately separate from b2.ts, which signs URLs for the
 * full-size WhatsApp originals in Backblaze B2.
 *
 * Key layout (unchanged from the Supabase days — see thumbnails.ts):
 *   {prefix}/{chunk:06d}/{prefix}_{id}.jpg
 *
 * ── Required env vars ────────────────────────────────────────────────────────
 *   E2_ACCESS_KEY_ID      — read-only e2 access key, limited to the bucket
 *   E2_SECRET_ACCESS_KEY  — the matching secret
 *   E2_ENDPOINT           — the account's e2 S3 endpoint, https://… (from the
 *                           e2 console, shown per region)
 *   E2_REGION             — the bucket's region name, e.g. "us-east-1" style
 *                           value shown in the e2 console
 *   E2_BUCKET             — optional, defaults to "thumbnails"
 *   E2_PATH_STYLE         — optional, defaults to path-style addressing; set
 *                           to "false" to use virtual-hosted style
 *
 * Presigning is a pure local HMAC (no network call), so signing a whole
 * page of thumbnails costs nothing. Unlike b2.ts there is no HeadObject
 * before signing: a missing object just fails to load in the browser and
 * <SignedImage> shows its placeholder.
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

/** Presigned GET URLs expire after this many seconds. */
const SIGNED_URL_TTL = 3_600 // 1 hour

let _client: S3Client | null = null

function getClient(): S3Client | null {
  if (_client) return _client

  const keyId    = (process.env.E2_ACCESS_KEY_ID     ?? '').trim()
  const secret   = (process.env.E2_SECRET_ACCESS_KEY ?? '').trim()
  const endpoint = (process.env.E2_ENDPOINT          ?? '').trim()
  const region   = (process.env.E2_REGION            ?? '').trim()

  if (!keyId || !secret || !endpoint || !region) {
    console.error(
      '[e2] Missing one or more required env vars: ' +
      'E2_ACCESS_KEY_ID, E2_SECRET_ACCESS_KEY, E2_ENDPOINT, E2_REGION',
    )
    return null
  }

  _client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId: keyId, secretAccessKey: secret },
    forcePathStyle: (process.env.E2_PATH_STYLE ?? 'true').trim().toLowerCase() !== 'false',
    // Newer SDK versions add CRC32 checksums to every request by default,
    // which several S3-compatible stores reject. Only when the API requires it.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  return _client
}

function getBucket(): string {
  return (process.env.E2_BUCKET ?? '').trim() || 'thumbnails'
}

/**
 * Short-lived presigned GET URL for one thumbnail key, or null if e2 isn't
 * configured or signing fails.
 */
export async function presignThumbnailUrl(key: string): Promise<string | null> {
  const client = getClient()
  if (!client || !key) return null
  try {
    return await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: getBucket(), Key: key }),
      { expiresIn: SIGNED_URL_TTL },
    )
  } catch (err) {
    console.error('[e2] Failed to presign URL:', err)
    return null
  }
}

/**
 * Raw JPEG bytes for one thumbnail (server-side, for pixel-distance
 * computation), or null when the object is missing or e2 is unreachable.
 */
export async function downloadThumbnailBytes(key: string): Promise<Buffer | null> {
  const client = getClient()
  if (!client) return null
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: getBucket(), Key: key }))
    if (!res.Body) return null
    return Buffer.from(await res.Body.transformToByteArray())
  } catch (err) {
    // A missing thumbnail is expected for some rows; anything else (bad
    // credentials, network) must be visible in the Vercel logs.
    const name = (err as { name?: string })?.name
    if (name !== 'NoSuchKey' && name !== 'NotFound') {
      console.error(`[e2] Failed to download ${key}:`, err)
    }
    return null
  }
}
