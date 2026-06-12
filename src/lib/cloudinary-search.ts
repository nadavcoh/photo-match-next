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
 * `folder` and `filename` must already be correctly split by the caller —
 * see media/route.ts for the exact lastIndexOf('/') logic.
 *
 *   folder   — full folder path up to (not including) the filename
 *              e.g. "gphoto_phash_media/Media/972525361536.../c/d"
 *   filename — asset filename stem WITHOUT extension or folder prefix
 *              e.g. "cde30200-d234-4b57-8c74-c7675aabcc72"
 *
 * FIX 1: .with_field('public_id') has been removed.
 *   public_id is returned by default; explicitly requesting it via with_field()
 *   throws "Invalid with_field options 'public_id'" — a 400 Bad Request.
 *
 * FIX 2: Expression uses colon-quote syntax (field:"value") instead of
 *   equals-quote (field="value"), and adds type:authenticated to narrow results
 *   to the correct delivery type.
 *
 * Returns the public_id of the first matching asset, or null if not found.
 *
 * ⚠️  Do NOT call this directly — always use the exported findPublicId() below
 *     so results are served from the persistent cache.
 */
async function _searchPublicId(folder: string, filename: string): Promise<string | null> {
  if (!configureCloudinary()) return null

  try {
    // Colon-quote syntax: field:"value"
    //   • Handles multi-segment paths and special characters correctly.
    //   • type:authenticated narrows to the correct delivery type, preventing
    //     false matches against assets uploaded with a different type.
    const expression =
      `asset_folder:"${folder}" AND filename:"${filename}" AND type:authenticated`

    const result = await cloudinary.search
      .expression(expression)
      .max_results(1)   // at most one match expected per asset
      .execute() as {
        resources: Array<{ public_id: string }>
        total_count: number
      }

    const publicId = result.resources[0]?.public_id ?? null

    if (publicId) {
      console.log(
        `[cloudinary-search] CACHE MISS — found ${publicId}` +
        ` for folder:"${folder}" filename:"${filename}"`,
      )
    } else {
      console.warn(
        `[cloudinary-search] No asset found — expression: ${expression}`,
      )
    }

    return publicId
  } catch (err) {
    console.error('[cloudinary-search] Search API call failed:', err)
    return null
  }
}

// ── Cached public_id lookup (the only export you should use) ─────────────────

/**
 * findPublicId(folder, filename) → string | null
 *
 * Returns the Cloudinary public_id for the asset identified by the given
 * folder path and filename stem.  Both must be pre-split correctly — see
 * media/route.ts for the exact splitting logic.
 *
 * Caching behaviour:
 *   • Cache key  : ['cld-pid', folder, filename]  (one entry per unique asset)
 *   • TTL        : infinite (revalidate: false) — public_ids never change
 *   • Invalidate : revalidateTag('cloudinary') to bust all lookup entries
 *
 * The first call for any (folder, filename) pair hits the Cloudinary Search API.
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
