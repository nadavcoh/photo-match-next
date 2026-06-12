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
 * Private-delivery signing flow
 * ──────────────────────────────
 *   Because assets are stored under Cloudinary's `private` delivery type, raw
 *   Cloudinary URLs are inaccessible without an HMAC-SHA1 signature that
 *   incorporates the API secret.  Generating that signature client-side would
 *   leak the secret, so the work is delegated to the server:
 *
 *     1. On mount, POST /api/cloudinary/sign { publicId, resourceType }.
 *     2. The route handler signs the URL with CLOUDINARY_API_SECRET (server-only)
 *        and returns { url }.  The signed URL expires in 1 hour.
 *     3. The signed URL is stored in local state and rendered in a plain
 *        <img> or <video> tag.  No Cloudinary credentials ever reach the browser.
 *
 *   The pattern mirrors how SignedImage already handles Supabase thumbnails.
 */

import { useState, useEffect } from 'react'
import type { CSSProperties } from 'react'

// ── Constants ────────────────────────────────────────────────────────────────

/** Cloudinary folder where WhatsApp media is stored. */
const CLOUDINARY_FOLDER = 'gphoto_phash_media'

/** Route handler that signs private Cloudinary URLs (API secret lives here). */
const SIGN_ENDPOINT = '/api/cloudinary/sign'

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the Cloudinary public_id for a given filename.
 *
 * The extension is intentionally preserved because assets were synced via
 * `cloudinary sync`, which stores the extension as part of the public_id:
 *
 *   "Media-WA0022.mp4" → "gphoto_phash_media/Media-WA0022.mp4"  ✓
 *   "Media-WA0022"     → "gphoto_phash_media/Media-WA0022"       ✓ (no-op)
 */
function toPublicId(filename: string): string {
  return `${CLOUDINARY_FOLDER}/${filename}`
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WAMediaPreviewProps {
  /** Raw filename from the WA item (e.g. "Media-WA0123.jpg"). */
  filename: string | null | undefined
  /** True when item.filetype contains "image". */
  isImage: boolean
  /** True when item.filetype contains "video". */
  isVideo: boolean
}

/** Internal state machine for the async signed-URL fetch. */
type UrlState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error' }

// ── Component ─────────────────────────────────────────────────────────────────

export function WAMediaPreview({ filename, isImage, isVideo }: WAMediaPreviewProps) {
  const [urlState, setUrlState] = useState<UrlState>({ status: 'idle' })

  // ── Fetch a signed private-delivery URL from the server ──────────────────
  //
  //    Re-runs whenever the item changes (filename / type switch).
  //    The cleanup function sets `cancelled = true` so a stale in-flight fetch
  //    cannot overwrite state that belongs to a newer item.

  useEffect(() => {
    const qualifies = filename?.startsWith('Media') && (isImage || isVideo)

    if (!qualifies || !filename) {
      setUrlState({ status: 'idle' })
      return
    }

    let cancelled = false
    setUrlState({ status: 'loading' })

    const publicId     = toPublicId(filename)
    const resourceType = isVideo ? 'video' : 'image'

    fetch(SIGN_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ publicId, resourceType }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Sign endpoint returned HTTP ${res.status}`)
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

    return () => {
      cancelled = true
    }
  }, [filename, isImage, isVideo])

  // ── Guard: trigger condition (mirrors useEffect guard, keeps render pure) ──

  if (!filename?.startsWith('Media') || (!isImage && !isVideo)) return null

  // ── Shared wrapper ────────────────────────────────────────────────────────

  const wrapStyle: CSSProperties = {
    borderTop:  '1px solid var(--border)',
    overflow:   'hidden',
    lineHeight: 0, // eliminates the gap beneath inline/block media elements
  }

  // ── Loading skeleton ─────────────────────────────────────────────────────

  if (urlState.status === 'idle' || urlState.status === 'loading') {
    return (
      <div
        style={{
          ...wrapStyle,
          display:         'flex',
          alignItems:      'center',
          justifyContent:  'center',
          minHeight:       72,
          lineHeight:      'normal',
          background:      'var(--border)',
          opacity:         0.6,
        }}
      >
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
          style={{
            width:      '100%',
            height:     'auto',
            display:    'block',
            objectFit:  'cover',
          }}
        />
      </div>
    )
  }

  // ── Video branch ─────────────────────────────────────────────────────────
  //
  //    `key={url}` forces React to unmount/remount the <video> element whenever
  //    the signed URL changes (e.g. item navigation), preventing the browser
  //    from continuing to play the previous item's video.

  return (
    <div style={{ ...wrapStyle, background: '#000' }}>
      <video
        key={url}
        src={url}
        muted
        autoPlay
        loop
        playsInline
        style={{
          width:      '100%',
          display:    'block',
          maxHeight:  420,
          objectFit:  'cover',
        }}
      />
    </div>
  )
}
