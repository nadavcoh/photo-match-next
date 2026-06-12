'use client'

/**
 * WAMediaPreview
 *
 * Full-width Cloudinary media preview rendered below the thumbnail/metadata row
 * inside WAItemCard.
 *
 * Trigger condition (both must be true):
 *   1. The item is a WA item  — always guaranteed; WAItemCard is WA-only.
 *   2. item.filename starts with "Media".
 *
 * ── How URLs are resolved (Dynamic Folders) ──────────────────────────────────
 *
 * Assets were synced using Cloudinary's Dynamic Folders mode, which assigns
 * each file a random Base64 public_id rather than the original file path.
 * This component does NOT know or construct the public_id — all of that work
 * happens server-side in /api/cloudinary/media:
 *
 *   1. Client POSTs { filename, resourceType } to /api/cloudinary/media.
 *
 *   2. Server strips the extension to get the filename stem, then calls
 *      findPublicId() which is wrapped in Next.js unstable_cache:
 *        • First call per stem  → live Cloudinary Search API query.
 *        • All later calls      → instant cache hit, zero API quota used.
 *      (revalidate: false means the cached public_id never auto-expires,
 *       which is correct because Cloudinary public_ids are immutable.)
 *
 *   3. Server signs the discovered public_id with CLOUDINARY_API_SECRET
 *      (type: 'authenticated', HMAC-SHA1, expires in 1 h) and returns { url }.
 *
 *   4. Client stores the signed URL in state and renders <img> or <video>.
 *
 * The API secret and all Cloudinary credentials never reach the browser.
 * This component holds zero knowledge of the Cloudinary folder structure.
 */

import { useState, useEffect } from 'react'
import type { CSSProperties } from 'react'

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Route handler that resolves the Dynamic Folders public_id (via cached search)
 * and returns a signed authenticated-delivery URL.
 */
const MEDIA_ENDPOINT = '/api/cloudinary/media'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WAMediaPreviewProps {
  /** Raw filename from the WA item (e.g. "Media-WA0123.jpg"). */
  filename: string | null | undefined
  /** True when item.filetype contains "image". */
  isImage: boolean
  /** True when item.filetype contains "video". */
  isVideo: boolean
}

/** Internal state machine for the async URL fetch. */
type UrlState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error' }

// ── Component ─────────────────────────────────────────────────────────────────

export function WAMediaPreview({ filename, isImage, isVideo }: WAMediaPreviewProps) {
  const [urlState, setUrlState] = useState<UrlState>({ status: 'idle' })

  // ── Fetch the server-resolved, signed URL ────────────────────────────────
  //
  //    The server does the heavy lifting (Cloudinary search + signing).
  //    This effect re-runs whenever the item changes (filename / media type).
  //    The cleanup flag prevents a stale in-flight fetch from overwriting state
  //    that already belongs to the next item.

  useEffect(() => {
    const qualifies = filename?.startsWith('Media') && (isImage || isVideo)

    if (!qualifies || !filename) {
      setUrlState({ status: 'idle' })
      return
    }

    let cancelled = false
    setUrlState({ status: 'loading' })

    const resourceType = isVideo ? 'video' : 'image'

    // The server owns all path/public_id logic — we send just the raw filename.
    fetch(MEDIA_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ filename, resourceType }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Media endpoint returned HTTP ${res.status}`)
        return res.json() as Promise<{ url: string }>
      })
      .then(({ url }) => {
        if (!cancelled) setUrlState({ status: 'ready', url })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.error('[WAMediaPreview] Failed to get signed URL:', err)
          setUrlState({ status: 'error' })
        }
      })

    return () => { cancelled = true }
  }, [filename, isImage, isVideo])

  // ── Guard: trigger condition ─────────────────────────────────────────────

  if (!filename?.startsWith('Media') || (!isImage && !isVideo)) return null

  // ── Shared wrapper ────────────────────────────────────────────────────────

  const wrapStyle: CSSProperties = {
    borderTop:  '1px solid var(--border)',
    overflow:   'hidden',
    lineHeight: 0,
  }

  // ── Loading skeleton ─────────────────────────────────────────────────────

  if (urlState.status === 'idle' || urlState.status === 'loading') {
    return (
      <div style={{
        ...wrapStyle,
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        minHeight:      72,
        lineHeight:     'normal',
        background:     'var(--border)',
        opacity:        0.6,
      }}>
        <span style={{ fontSize: '.78rem', color: 'var(--muted, #888)', lineHeight: 'normal' }}>
          Loading preview…
        </span>
      </div>
    )
  }

  // ── Error: fail silently — the thumbnail row above is still visible ───────

  if (urlState.status === 'error') return null

  const { url } = urlState

  // ── Image branch ─────────────────────────────────────────────────────────

  if (isImage) {
    return (
      <div style={wrapStyle}>
        <img
          src={url}
          alt={filename ?? ''}
          style={{ width: '100%', height: 'auto', display: 'block', objectFit: 'cover' }}
        />
      </div>
    )
  }

  // ── Video branch ─────────────────────────────────────────────────────────
  //    key={url} forces React to remount <video> when the item changes so the
  //    browser doesn't continue playing the previous video.

  return (
    <div style={{ ...wrapStyle, background: '#000' }}>
      <video
        key={url}
        src={url}
        muted
        autoPlay
        loop
        playsInline
        style={{ width: '100%', display: 'block', maxHeight: 420, objectFit: 'cover' }}
      />
    </div>
  )
}
