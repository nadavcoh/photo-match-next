import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { thumbnailStoragePath, ThumbnailPrefix } from '@/lib/thumbnails'

// Module-level singleton — reused across invocations in the same worker.
let _admin: SupabaseClient | undefined

export function getSupabaseAdmin(): SupabaseClient {
  if (!_admin) {
    const url = (process.env.SUPABASE_URL ?? '').trim()
    const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
    if (!url || !key)
      throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set')
    _admin = createClient(url, key, { auth: { persistSession: false } })
  }
  return _admin
}

const BUCKET = 'thumbnails'

/**
 * Download raw JPEG bytes for one thumbnail from the private bucket.
 * Returns null on any error (missing file, bad env vars, network, etc.)
 */
export async function downloadThumbnailBytes(
  prefix: ThumbnailPrefix,
  id: number,
): Promise<Buffer | null> {
  try {
    const path = thumbnailStoragePath(prefix, id)
    const { data, error } = await getSupabaseAdmin()
      .storage.from(BUCKET)
      .download(path)
    if (error || !data) return null
    return Buffer.from(await data.arrayBuffer())
  } catch {
    return null
  }
}
