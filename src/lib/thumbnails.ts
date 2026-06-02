export type ThumbnailPrefix = 'wa' | 'hashes' | 'partner'

/**
 * Compute the deterministic storage path for a thumbnail.
 *
 * Convention:  {prefix}/{chunkDir}/{prefix}_{id}.jpg
 * Chunk dir:   floor(id / 1000) * 1000, zero-padded to 6 digits
 *
 * Examples:
 *   wa_8402      → wa/008000/wa_8402.jpg
 *   hashes_151973 → hashes/151000/hashes_151973.jpg
 *   partner_10   → partner/000000/partner_10.jpg
 */
export function thumbnailStoragePath(prefix: ThumbnailPrefix, id: number): string {
  const chunk = Math.floor(id / 1000) * 1000
  const chunkDir = String(chunk).padStart(6, '0')
  return `${prefix}/${chunkDir}/${prefix}_${id}.jpg`
}

/**
 * Build the fully-qualified public URL for a thumbnail in Supabase Storage.
 * The thumbnails bucket must be public.
 */
export function thumbnailPublicUrl(prefix: ThumbnailPrefix, id: number): string {
  const supabaseUrl = process.env.SUPABASE_URL
  if (!supabaseUrl) throw new Error('SUPABASE_URL environment variable is not set')
  const path = thumbnailStoragePath(prefix, id)
  return `${supabaseUrl}/storage/v1/object/public/thumbnails/${path}`
}
