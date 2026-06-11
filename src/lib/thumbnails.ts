/**
 * src/lib/thumbnails.ts
 *
 * Shared helpers for computing Supabase Storage object paths for thumbnails.
 *
 * With the service-role-key proxy removed, thumbnail_url values are now raw
 * storage paths (e.g. "wa/008000/wa_8402.jpg") rather than API route paths.
 * The browser SignedImage component calls supabase.storage.createSignedUrl()
 * directly with these paths, and the server-side match route downloads bytes
 * via the authenticated SSR client.
 */

export type ThumbnailPrefix = 'wa' | 'hashes' | 'partner'

/** The Supabase Storage bucket that holds all thumbnails. */
export const THUMBNAILS_BUCKET = 'thumbnails'

/**
 * Deterministic Supabase Storage object path for one thumbnail.
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
 * Returns the Supabase Storage object path for a thumbnail.
 *
 * Formerly returned an API route path (/api/thumbnail/…). Now returns the
 * raw storage path so callers can interact with Supabase Storage directly
 * using the authenticated client, without a server-side proxy.
 */
export function thumbnailUrl(prefix: ThumbnailPrefix, id: number): string {
  return thumbnailStoragePath(prefix, id)
}
