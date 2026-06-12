/**
 * cloudinary-search.ts
 *
 * Server-side helper for looking up the real Cloudinary public_id of an asset
 * that was synced using Dynamic Folders mode.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * Cloudinary's "Dynamic Folders" sync mode assigns each uploaded file a random
 * Base64 string as its public_id, rather than using the original file path.
 * To display an asset we must first query the Search API to discover which
 * random public_id corresponds to a given original filename.
 *
 * The Search API is rate-limited to 500 requests / hour on the free tier.
 * A gallery rendering 50 items would exhaust that budget in seconds without
 * caching.
 *
 * ── Solution: unstable_cache with revalidate: false ──────────────────────────
 *
 * Next.js's unstable_cache wraps the raw search function so that:
 *   • The first call for a given (folder, filename) pair hits Cloudinary.
 *   • Every subsequent call — from any serverless invocation, any user, any
 *     point in time — is served from Next.js's persistent data cache instantly.
 *   • revalidate: false means the entry never auto-expires.  This is correct
 *     because Cloudinary public_ids are immutable: once an asset is uploaded
 *     its random public_id never changes.
 *
 * Manual invalidation: call revalidateTag('cloudinary') from a route handler
 * (e.g. after a re-sync) to flush all cached lookups.
 *
 * ── Security note ────────────────────────────────────────────────────────────
 *
 * This module is server-only (no 'use client' directive, no NEXT_PUBLIC_ vars).
 * CLOUDINARY_API_SECRET is consumed here and must never be exposed to the browser.
 */

import { unstable_cache } from 'next/cache'
import { v2 as cloudinary } from 'cloudinary'

// ── SDK configuration ────────────────────────────────────────────────────────

/**
 * Configures the Cloudinary SDK from server-only env vars.
 * Called inside the cached function so it always picks up the live env
 * (important for Vercel's per-invocation environment).
 */
function configureCloudinary(): boolean {
  const cloudName = (process.env.CLOUDINARY_CLOUD_NAME ?? '').trim()
  const apiKey    = (process.env.CLOUDINARY_API_KEY    ?? '').trim()
  const apiSecret = (process.env.CLOUDINARY_API_SECRET ?? '').trim()

  if (!cloudName || !apiKey || !apiSecret) {
    console.error(
      '[cloudinary-search] Missing env vars: ' +
      'CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET',
    )
    return false
  }

  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true })
  return true
}

// ── Raw search (uncached) ────────────────────────────────────────────────────

/**
 * Performs a live Cloudinary Search API call.
 *
 * Expression: folder="{folder}" AND filename="{stem}"
 *   folder   — the top-level Cloudinary folder (e.g. "gphoto_phash_media")
 *   stem     — the original filename WITHOUT extension (e.g. "Media-WA0022")
 *              The Search API's `filename` field stores the original stem even
 *              in Dynamic Folders mode.
 *
 * Returns the public_id of the first matching asset, or null if not found.
 *
 * ⚠️  Do NOT call this directly — always use the exported findPublicId() below
 *     so results are served from the persistent cache.
 */
async function _searchPublicId(folder: string, stem: string): Promise<string | null> {
  if (!configureCloudinary()) return null

  try {
    // The Search API expression uses quoted values so filenames with hyphens
    // or other special characters are matched exactly.
    const expression = `folder="${folder}" AND filename="${stem}"`

    const result = await cloudinary.search
      .expression(expression)
      .with_field('public_id')    // we only need the public_id field
      .max_results(1)             // at most one match expected
      .execute() as {
        resources: Array<{ public_id: string }>
        total_count: number
      }

    const publicId = result.resources[0]?.public_id ?? null

    if (publicId) {
      console.log(`[cloudinary-search] CACHE MISS — found: ${publicId} for "${folder}/${stem}"`)
    } else {
      console.warn(`[cloudinary-search] No asset found for folder="${folder}" filename="${stem}"`)
    }

    return publicId
  } catch (err) {
    console.error('[cloudinary-search] Search API call failed:', err)
    return null
  }
}

// ── Cached public_id lookup (the only export you should use) ─────────────────

/**
 * findPublicId(folder, stem) → string | null
 *
 * Returns the Cloudinary public_id for the asset whose original filename stem
 * matches `stem` inside `folder`.
 *
 * Caching behaviour:
 *   • Cache key  : ['cld-pid', folder, stem]  (one entry per unique asset)
 *   • TTL        : infinite (revalidate: false) — public_ids never change
 *   • Invalidate : revalidateTag('cloudinary') to bust all lookup entries
 *
 * The first call for any (folder, stem) pair hits the Cloudinary Search API.
 * Every subsequent call — regardless of which serverless instance handles the
 * request — is a cache hit and returns instantly with zero API quota consumed.
 */
export const findPublicId = unstable_cache(
  _searchPublicId,
  ['cld-pid'],              // cache namespace prefix
  {
    revalidate: false,      // never auto-expire; public_ids are immutable
    tags: ['cloudinary'],   // revalidateTag('cloudinary') flushes everything
  },
)
