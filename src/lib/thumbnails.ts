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
 * Return the API route URL for a thumbnail.
 *
 * The bucket is private. All access goes through /api/thumbnail which uses
 * the Service Role Key server-side to create a short-lived signed URL.
 * Direct CDN paths are intentionally not returned here.
 */
export function thumbnailUrl(prefix: ThumbnailPrefix, id: number): string {
  return `/api/thumbnail/${prefix}/${id}`
}
