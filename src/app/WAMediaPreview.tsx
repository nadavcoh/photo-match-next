'use client'

/**
 * WAMediaPreview
 *
 * Renders a full-width Cloudinary media preview below the thumbnail/metadata
 * row inside WAItemCard.
 *
 * Trigger condition (both must be true):
 *   1. The item is a WA item  — guaranteed by context; the caller (WAItemCard)
 *      only renders this component for WA items.
 *   2. item.filename starts with "Media"
 *
 * Images  → <CldImage>  with crop="fill" and responsive sizes.
 * Videos  → native <video> with an optimised URL from getCldVideoUrl().
 *           (Avoids the extra CldVideoPlayer CSS import in a 'use client' file.)
 *
 * Requires:
 *   NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME set in .env.local
 */

import { CldImage, getCldVideoUrl } from 'next-cloudinary'
import type { CSSProperties } from 'react'

// ── Constants ────────────────────────────────────────────────────────────────

/** Cloudinary folder where WhatsApp media is stored. */
const CLOUDINARY_FOLDER = 'gphoto_phash_media/Media'

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strips the file extension (if any) and returns a Cloudinary public_id.
 *
 * "Media-WA0022.mp4" → "gphoto_phash_media/Media/Media-WA0022"
 * "Media-WA0022"     → "gphoto_phash_media/Media/Media-WA0022"  (no extension — safe)
 */
function toPublicId(filename: string): string {
  // Only strip if there is an extension-like suffix (dot + 1–5 non-dot chars at end)
  const base = filename.replace(/\.[^.]{1,5}$/, '')
  return `${CLOUDINARY_FOLDER}/${base}`
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WAMediaPreviewProps {
  /** The raw filename from the WA item (e.g. "Media-WA0123.jpg"). */
  filename: string | null | undefined
  /** True when item.filetype contains "image". */
  isImage: boolean
  /** True when item.filetype contains "video". */
  isVideo: boolean
}

// ── Component ─────────────────────────────────────────────────────────────────

export function WAMediaPreview({ filename, isImage, isVideo }: WAMediaPreviewProps) {
  // ── Guard: trigger conditions ────────────────────────────────────────────

  // No filename, or doesn't start with "Media" → nothing to show.
  if (!filename?.startsWith('Media')) return null

  // Only handle image or video; skip unknown filetypes.
  if (!isImage && !isVideo) return null

  // Env-var guard: if the cloud name is missing the Cloudinary URLs will be
  // malformed — log a warning and degrade gracefully.
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME
  if (!cloudName) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        '[WAMediaPreview] NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME is not set. ' +
        'Add it to .env.local to enable the full-width media preview.'
      )
    }
    return null
  }

  // ── Shared wrapper styles ────────────────────────────────────────────────

  const wrapStyle: CSSProperties = {
    borderTop: '1px solid var(--border)',
    overflow: 'hidden',
    lineHeight: 0, // collapses the small gap below inline/block media elements
  }

  const publicId = toPublicId(filename)

  // ── Image branch ─────────────────────────────────────────────────────────

  if (isImage) {
    return (
      <div style={wrapStyle}>
        <CldImage
          // public_id in Cloudinary (no file extension)
          src={publicId}
          // Intrinsic dimensions — used for aspect-ratio calculation.
          // 4:3 is a reasonable default; Cloudinary crop="fill" will handle
          // any actual source ratio without letterboxing.
          width={960}
          height={720}
          alt={filename}
          // crop="fill" — scales and crops to fill the requested dimensions
          // without distorting the image, equivalent to object-fit: cover.
          crop={{ type: 'fill' }}
          // Responsive: full card width up to the 960 px max-width container.
          sizes="(max-width: 960px) 100vw, 960px"
          style={{
            width: '100%',
            height: 'auto',
            display: 'block',
            objectFit: 'cover',
          }}
        />
      </div>
    )
  }

  // ── Video branch ─────────────────────────────────────────────────────────

  // getCldVideoUrl returns an optimised Cloudinary streaming URL for the asset.
  // We pair it with a plain <video> tag so there's no extra CSS to import.
  const videoSrc = getCldVideoUrl({ src: publicId })

  return (
    <div style={{ ...wrapStyle, background: '#000' }}>
      <video
        src={videoSrc}
        // Autoplay muted loop gives the feel of an inline preview / GIF.
        muted
        autoPlay
        loop
        playsInline
        controls={false}
        style={{
          width: '100%',
          display: 'block',
          // Cap height so very tall videos don't push content off-screen.
          maxHeight: 420,
          objectFit: 'cover',
        }}
      />
    </div>
  )
}
