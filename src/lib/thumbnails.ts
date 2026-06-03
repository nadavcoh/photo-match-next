export type ThumbnailPrefix = 'wa' | 'hashes' | 'partner'

/**
 * Compute the deterministic Supabase Storage path for a thumbnail.
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

/**
 * Return the best available URL for a thumbnail.
 *
 * When SUPABASE_URL is set (always true in production) the image is served
 * directly from Supabase Storage CDN — no server round-trip or redirect.
 * Falls back to our own /api/thumbnail proxy for local dev without SUPABASE_URL.
 */
export function thumbnailUrl(prefix: ThumbnailPrefix, id: number): string {
  const supabaseUrl = (process.env.SUPABASE_URL ?? '').trim()
  if (supabaseUrl) {
    const path = thumbnailStoragePath(prefix, id)
    return `${supabaseUrl}/storage/v1/object/public/thumbnails/${path}`
  }
  return `/api/thumbnail/${prefix}/${id}`
}
