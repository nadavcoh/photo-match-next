'use client'

/**
 * WAMediaPreview
 *
 * Full-width original-media preview (the synced WhatsApp photo/video, not
 * the small JPEG thumbnail) rendered below the thumbnail/metadata row inside
 * WAItemCard. Backed by Backblaze B2.
 *
 * Trigger condition (both must be true):
 * 1. The item is a WA item  — always guaranteed; WAItemCard is WA-only.
 * 2. item.filename starts with "Media".
 *
 * ── How URLs are resolved ─────────────────────────────────────────────────────
 *
 * item.filename already encodes the asset's full relative path
 * (e.g. "Media/972525361536-1602045182@g.us/c/d/cde30200....jpg"), and B2
 * object keys are exactly that path — no random-id translation step is
 * needed (unlike the old Cloudinary "Dynamic Folders" setup this replaced).
 *
 * 1. Client POSTs { filename } to /api/media.
 * 2. Server builds the B2 object key from filename (lib/b2.ts) and signs a
 *    short-lived presigned GET URL (HMAC, B2 credentials never leave the
 *    server — see lib/b2.ts).
 * 3. Client stores the signed URL in state and renders <img> or <video>.
 *
 * This component holds zero knowledge of B2 credentials, bucket names, or
 * key layout.
 */

import { useState, useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Route handler that builds the B2 object key from the filename and returns
 * a signed GET URL.
 */
const MEDIA_ENDPOINT = '/api/media'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WAMediaPreviewProps {
  /** Raw filename from the WA item (e.g. "Media-WA0123.jpg"). */
  filename: string | null | undefined
  /** No longer used — the full relative path is encoded in filename itself. */
  path?: string | null | undefined
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

export function WAMediaPreview({ filename, path, isImage, isVideo }: WAMediaPreviewProps) {
  const [urlState, setUrlState] = useState<UrlState>({ status: 'idle' })
  const videoRef = useRef<HTMLVideoElement>(null)

  // ── Fetch the server-resolved, signed URL ────────────────────────────────
  //
  //    The server does the heavy lifting (B2 key construction + signing).
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

    // The server owns all key-construction logic — we send just the raw filename.
    fetch(MEDIA_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ filename }),
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

  // ── Force Autoplay for Asynchronous Video ────────────────────────────────
  //    Bypasses React's synthetic rendering queue to ensure the browser
  //    sees the video as strictly muted, satisfying autoplay security policies.
  
  useEffect(() => {
    if (urlState.status === 'ready' && isVideo && videoRef.current) {
      // Force the DOM element to be muted
      videoRef.current.defaultMuted = true
      videoRef.current.muted = true

      // Explicitly command the browser to play
      videoRef.current.play().catch((err) => {
        console.warn('[WAMediaPreview] Autoplay blocked by strict browser policy:', err)
      })
    }
  }, [urlState, isVideo])

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
          style={{ width: '100%', height: 'auto', display: 'block' }}
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
        ref={videoRef}
        key={url}
        src={url}
        muted
        autoPlay
        loop
        playsInline
        style={{ width: '100%', height: 'auto', display: 'block' }}
      />
    </div>
  )
}
