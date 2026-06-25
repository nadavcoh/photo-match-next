/**
 * src/lib/b2.ts
 *
 * Server-side helper for resolving and signing Backblaze B2 URLs for the
 * full-size original WhatsApp media shown in <WAMediaPreview> (the synced
 * "Media/…" photo/video files) — NOT the small JPEG thumbnails, which live in
 * Supabase Storage and are handled by thumbnails.ts.
 *
 * ── Why this replaced Cloudinary ─────────────────────────────────────────────
 *
 * The previous implementation used Cloudinary's "Dynamic Folders" sync mode,
 * which assigns every uploaded asset a random Base64 public_id instead of
 * keeping the original file path. That forced a rate-limited Search API
 * lookup (cached via unstable_cache) just to translate a known filename into
 * Cloudinary's internal id before a URL could even be signed.
 *
 * Backblaze B2 has no equivalent renaming step — an object's key IS its path.
 * As long as the sync pipeline uploads files to B2 preserving the same
 * relative path stored in wa.filename (e.g.
 * "Media/972525361536-1602045182@g.us/c/d/cde30200....jpg"), the object key
 * is built with a single string concatenation. No search, no cache needed.
 *
 * ── Auth model ────────────────────────────────────────────────────────────────
 *
 * Talks to B2 via its S3-Compatible API using the standard AWS SDK v3 S3
 * client, pointed at B2's endpoint/region. Credentials are a B2 Application
 * Key (NOT the account master key) scoped to the single media bucket —
 * equivalent to an AWS access key id / secret access key pair.
 *
 * GET URLs are short-lived presigned URLs computed locally (pure HMAC, no
 * network round-trip to generate), so the credentials and bucket name never
 * reach the browser.
 *
 * ── Required env vars ────────────────────────────────────────────────────────
 *   B2_APPLICATION_KEY_ID  — from a B2 Application Key (not the master key)
 *   B2_APPLICATION_KEY     — the matching secret
 *   B2_BUCKET_NAME         — bucket holding the synced media
 *   B2_ENDPOINT            — e.g. "https://s3.us-west-004.backblazeb2.com"
 *   B2_REGION              — e.g. "us-west-004" (must match the bucket's region)
 *   B2_MEDIA_PREFIX        — optional. Key prefix applied to every lookup,
 *                            e.g. "wa-media" if files live under a top-level
 *                            folder rather than at the bucket root. Mirrors
 *                            the old `gphoto_phash_media/` Cloudinary folder.
 *                            Leave unset if filenames are stored at bucket root.
 *
 * ── Note on lost Cloudinary transforms ───────────────────────────────────────
 *
 * The old route applied `crop: 'limit', width: 960` on the fly. B2 is plain
 * object storage with no on-the-fly image transforms, so this route now
 * serves the original file as-is. <WAMediaPreview> already renders it at
 * `width: 100%; height: auto`, so this only matters for bandwidth — if that
 * becomes a problem, resize at upload time (the sync pipeline) or add a
 * sharp-based resize step here (sharp is already a dependency, used in
 * pixelDistance.ts) before returning the URL.
 */

import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// ── Config ──────────────────────────────────────────────────────────────────

/** Presigned GET URLs expire after this many seconds. */
const SIGNED_URL_TTL = 3_600 // 1 hour

/** Optional key prefix — see B2_MEDIA_PREFIX above. Normalised: no leading/trailing slash. */
const MEDIA_PREFIX = (process.env.B2_MEDIA_PREFIX ?? '').trim().replace(/^\/+|\/+$/g, '')

// Lazily constructed and cached for the lifetime of the serverless instance.
let _client: S3Client | null = null

function getClient(): S3Client | null {
  if (_client) return _client

  const keyId    = (process.env.B2_APPLICATION_KEY_ID ?? '').trim()
  const appKey   = (process.env.B2_APPLICATION_KEY    ?? '').trim()
  const endpoint = (process.env.B2_ENDPOINT           ?? '').trim()
  const region   = (process.env.B2_REGION             ?? '').trim()

  if (!keyId || !appKey || !endpoint || !region) {
    console.error(
      '[b2] Missing one or more required env vars: ' +
      'B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, B2_ENDPOINT, B2_REGION',
    )
    return null
  }

  _client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId: keyId, secretAccessKey: appKey },
  })
  return _client
}

function getBucket(): string | null {
  const bucket = (process.env.B2_BUCKET_NAME ?? '').trim()
  return bucket || null
}

// ── Key construction ──────────────────────────────────────────────────────────

/**
 * Builds the B2 object key for a WA item's full-size media, given the raw
 * `filename` value already stored on the wa row (which encodes the full
 * relative path, extension included — e.g.
 * "Media/972525361536-1602045182@g.us/c/d/cde30200....jpg").
 */
export function buildMediaKey(filename: string): string {
  const clean = filename.replace(/^\/+/, '')
  return MEDIA_PREFIX ? `${MEDIA_PREFIX}/${clean}` : clean
}

// ── Signed URL ─────────────────────────────────────────────────────────────────

/**
 * Returns a short-lived presigned GET URL for the given object key, or null
 * if B2 isn't configured, the object doesn't exist, or signing fails.
 *
 * Performs one HeadObject existence check before signing so callers get a
 * clean "not found" instead of a presigned URL that 404s in the browser —
 * matching the old Cloudinary route's behaviour, which the client already
 * handles gracefully (WAMediaPreview fails silently on a non-OK response).
 */
export async function getSignedMediaUrl(key: string): Promise<string | null> {
  const client = getClient()
  const bucket = getBucket()
  if (!client || !bucket) return null

  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  } catch {
    // Object missing, wrong credentials, etc. — treat uniformly as "not found".
    return null
  }

  try {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key })
    return await getSignedUrl(client, command, { expiresIn: SIGNED_URL_TTL })
  } catch (err) {
    console.error('[b2] Failed to presign URL:', err)
    return null
  }
}
