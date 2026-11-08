/**
 * src/lib/thumbnails.ts
 *
 * Deterministic object keys for the small JPEG thumbnails.
 *
 * The thumbnails live in an IDrive e2 bucket (see e2.ts), no longer in
 * Supabase Storage. The key layout is unchanged, and the phash scrapers
 * (thumb_store.py) build the very same keys.
 *
 * `thumbnail_url` on WAItem / candidates starts out as one of these keys
 * inside /api/match; the route downloads bytes by key for the pixel
 * distance and then replaces it with a presigned e2 URL before responding,
 * so the browser only ever sees a URL it can put in <img src>.
 */

export type ThumbnailPrefix = 'wa' | 'hashes' | 'partner'

/**
 * Deterministic object key for one thumbnail.
 *
 * Convention:  {prefix}/{chunkDir}/{prefix}_{id}.jpg
 * Chunk dir:   floor(id / 1000) * 1000, zero-padded to 6 digits
 *
 * Examples:
 *   wa_8402       → wa/008000/wa_8402.jpg
 *   hashes_151973 → hashes/151000/hashes_151973.jpg
 *   partner_10    → partner/000000/partner_10.jpg
 */
export function thumbnailStoragePath(prefix: ThumbnailPrefix, id: number): string {
  const chunk = Math.floor(id / 1000) * 1000
  const chunkDir = String(chunk).padStart(6, '0')
  return `${prefix}/${chunkDir}/${prefix}_${id}.jpg`
}

/** Same as thumbnailStoragePath — the key used inside the API route. */
export function thumbnailUrl(prefix: ThumbnailPrefix, id: number): string {
  return thumbnailStoragePath(prefix, id)
}
