'use client'

import {
  useState,
  useEffect,
  useCallback,
  useRef,
  JSX,
} from 'react'
import type { ReactNode, CSSProperties, ChangeEvent } from 'react'
import type {
  MatchResponse,
  HashCandidate,
  Candidate,
  UndoState,
  SearchMode,
  QueueResponse,
} from '@/lib/types'
import { WAMediaPreview } from '@/components/WAMediaPreview'
import { createClient } from '@/lib/supabase-client'
import { trackMatchRequest } from '@/lib/inflight'

// ── Helpers ────────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString()
}

function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null || !isFinite(bytes) || bytes < 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i > 0 && v < 10 ? 1 : 0)} ${units[i]}`
}

function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return ''
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// Absolute resolution thresholds — not a comparison to the wa item, since
// wa has no size/resolution column of its own (see table_wa.txt: only
// duration, hash_bit, video_thumb_hash_bit exist there). Tune these
// constants if the actual capture/compression pipeline differs.
//   Video   — classified by short side (orientation-independent):
//               ≥1080 px → 1080p+, ≥720 px → 720p, else <720p
//   Image   — classified by total megapixels:
//               ≥8MP → full smartphone-camera resolution
//               ≥1.5MP → WhatsApp "HD" quality range
//               below that → WhatsApp default/low-res compression
function resolutionVariant(sizeStr: string | null | undefined, isVideo: boolean): '' | 'good' | 'ok' | 'bad' {
  const m = sizeStr?.match(/(\d+)\s*[x×]\s*(\d+)/i)
  if (!m) return ''
  const w = parseInt(m[1], 10)
  const h = parseInt(m[2], 10)
  if (!w || !h) return ''

  if (isVideo) {
    const shortSide = Math.min(w, h)
    if (shortSide >= 1080) return 'good'
    if (shortSide >= 720)  return 'ok'
    return 'bad'
  }

  const megapixels = (w * h) / 1_000_000
  if (megapixels >= 8)   return 'good'
  if (megapixels >= 1.5) return 'ok'
  return 'bad'
}

// Same tiering philosophy as resolutionVariant, applied to file size instead
// of pixel dimensions — same absolute-threshold reasoning applies (no wa
// reference to compare against). These byte cutoffs are a rough proxy for
// the resolution tiers (full-quality capture vs. WhatsApp HD vs. WhatsApp
// default/low-res compression) — tune them if real files cluster elsewhere.
// Takes bytes (filesize_bytes — the only file-size field; the legacy filesize
// text column was merged into it).
const MB = 1024 * 1024
function filesizeVariant(bytes: number | null, isVideo: boolean): '' | 'good' | 'ok' | 'bad' {
  if (bytes == null) return ''

  if (isVideo) {
    if (bytes >= 8 * MB) return 'good' // roughly 1080p+ territory
    if (bytes >= 1 * MB) return 'ok'   // roughly 720p / WhatsApp-compressed
    return 'bad'
  }

  if (bytes >= 2 * MB)   return 'good' // full smartphone-camera photo
  if (bytes >= 0.2 * MB) return 'ok'   // WhatsApp "HD" quality range
  return 'bad'                          // WhatsApp default/low-res compression
}

// Approximate JPEG quality (1-100), estimated server-side from the
// quantization table. NULL for non-JPEG files. Thresholds are a judgment
// call — smartphone camera JPEGs are typically 90+, WhatsApp's own
// compression commonly lands in the 60s-70s.
function jpegQualityVariant(q: number | null): '' | 'good' | 'ok' | 'bad' {
  if (q == null) return ''
  if (q >= 85) return 'good'
  if (q >= 65) return 'ok'
  return 'bad'
}

// Chroma subsampling, derived from ffprobe's pix_fmt (no column stores this
// pre-formatted — see frontend_changes.md). Ordering reflects how much
// chroma detail is retained: 4:4:4 (full) > 4:2:2 > 4:2:0. Note 4:2:0 being
// "red" doesn't mean something's wrong — it's the near-universal default for
// consumer photos/video, not a defect.
function chromaInfo(pixelFormat: string | null): { label: string; variant: '' | 'good' | 'ok' | 'bad' } | null {
  if (!pixelFormat) return null
  const pf = pixelFormat.toLowerCase()
  if (/^(yuvj?444|rgb|bgr|gbrp)/.test(pf)) return { label: '4:4:4', variant: 'good' }
  if (/^yuvj?422/.test(pf))                return { label: '4:2:2', variant: 'ok' }
  if (/^(yuvj?420|nv12|nv21)/.test(pf))     return { label: '4:2:0', variant: 'ok' }
  return { label: pixelFormat, variant: '' } // unrecognized pix_fmt — show raw value, no color
}

// HDR/wide-gamut indicator from bit_depth + color_primaries. Neither field
// alone is a great signal (10-bit alone is common for ordinary video codecs;
// non-bt709 primaries alone is rare/noisy) — flag "HDR" (green — a genuine
// step up) only when both a >8-bit depth AND non-standard primaries line
// up; "SDR" (yellow — the ordinary baseline, not something to celebrate) when
// neither does; a middle "N-bit"/bare-primaries-name (yellow) when only one
// signal fires. `smpte432` (Display P3) is common on plain, non-HDR iPhone
// photos, so it's treated as standard/ordinary here, not wide-gamut.
// Renders nothing when both inputs are NULL (pre-migration rows, or ffprobe
// couldn't determine them) rather than implying "SDR" from missing data.
const STANDARD_PRIMARIES = ['bt709', 'smpte170m', 'smpte432', 'bt470bg']
function hdrInfo(bitDepth: number | null, colorPrimaries: string | null): { label: string; variant: '' | 'good' | 'ok' | 'bad' } | null {
  if (bitDepth == null && !colorPrimaries) return null
  const highBitDepth = bitDepth != null && bitDepth > 8
  const wideGamut = colorPrimaries != null && !STANDARD_PRIMARIES.includes(colorPrimaries.toLowerCase())
  if (!highBitDepth && !wideGamut) return { label: 'SDR', variant: 'ok' }
  if (highBitDepth && wideGamut)   return { label: 'HDR', variant: 'good' }
  return { label: highBitDepth ? `${bitDepth}-bit` : (colorPrimaries as string), variant: 'ok' }
}

// color_range: "pc" (full 0-255) keeps more of the file's tonal data than
// the "tv" (limited 16-235) convention most consumer video/JPEG uses — tv
// isn't a defect, it's just the default, hence 'ok' rather than 'good'.
// Anything else is an unrecognized value, flagged for visibility.
function colorRangeInfo(range: string | null): { label: string; variant: '' | 'good' | 'ok' | 'bad' } | null {
  if (!range) return null
  const r = range.toLowerCase()
  if (r === 'pc') return { label: 'full-range', variant: 'good' }
  if (r === 'tv') return { label: 'limited-range', variant: 'ok' }
  return { label: range, variant: 'bad' }
}

// color_space/color_transfer, folded into one "profile" badge. Ordinary
// SD/HD combos (bt709 or smpte170m space with a bt709-style transfer — e.g.
// "bt709/bt709", "smpte170m/bt709") are just the everyday baseline, so they
// land on yellow rather than green. Green is reserved for a genuinely wider
// space paired with an HDR-style transfer curve (e.g. BT.2020 + HLG, like
// "bt2020nc/arib-std-b67") — an actual step up, not just "standard". Red is
// for values that don't match anything recognized on either axis.
const ORDINARY_COLOR_SPACES = ['bt709', 'smpte170m', 'bt470bg']
const WIDE_COLOR_SPACES = ['bt2020nc', 'bt2020c', 'bt2020']
const ORDINARY_COLOR_TRANSFERS = ['bt709', 'iec61966-2-1', 'smpte170m']
const HDR_COLOR_TRANSFERS = ['arib-std-b67', 'smpte2084']
function colorProfileInfo(space: string | null, transfer: string | null): { label: string; variant: '' | 'good' | 'ok' | 'bad' } | null {
  if (!space && !transfer) return null
  const label = [space, transfer].filter(Boolean).join('/')
  const spaceLower = space?.toLowerCase() ?? ''
  const transferLower = transfer?.toLowerCase() ?? ''

  const spaceIsWide = WIDE_COLOR_SPACES.includes(spaceLower)
  const transferIsHdr = HDR_COLOR_TRANSFERS.includes(transferLower)
  if (spaceIsWide && transferIsHdr) return { label, variant: 'good' }

  const spaceIsOrdinary = space == null || ORDINARY_COLOR_SPACES.includes(spaceLower)
  const transferIsOrdinary = transfer == null || ORDINARY_COLOR_TRANSFERS.includes(transferLower)
  if (spaceIsOrdinary && transferIsOrdinary) return { label, variant: 'ok' }

  const spaceRecognized = spaceIsOrdinary || spaceIsWide
  const transferRecognized = transferIsOrdinary || transferIsHdr
  if (!spaceRecognized && !transferRecognized) return { label, variant: 'bad' }

  return { label, variant: 'ok' }
}

// "How close is this candidate's duration to the WA item's own duration" —
// wa does have a duration column, so this stays a relative comparison.
// Green when very close, yellow when in the same ballpark, red when clearly
// different. Returns '' (neutral grey) when either side is missing.
function closenessVariant(candidate: number | null, wa: number | null): '' | 'good' | 'ok' | 'bad' {
  if (candidate == null || wa == null || wa === 0) return ''
  const deviation = Math.abs(candidate / wa - 1)
  if (deviation <= 0.05) return 'good'
  if (deviation <= 0.25) return 'ok'
  return 'bad'
}

function hammingClass(d: number | null | undefined): '' | 'good' | 'ok' | 'bad' {
  if (d == null) return ''
  if (d <= 5)  return 'good'
  if (d <= 12) return 'ok'
  return 'bad'
}

// Video H:/T: distances come from two hash spaces that were never designed
// to sit on the same good/ok/bad scale (videohash2 vs. imagehash-on-first-
// frame), so they get a simpler 2-tier treatment: green when clearly close,
// otherwise neutral grey — no yellow/red implying "bad" for what may just be
// a differently-scaled hash.
function lowDistanceVariant(d: number | null | undefined): '' | 'good' {
  if (d == null) return ''
  return d <= 5 ? 'good' : ''
}

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  // /api/match* requests are counted so the warm-up stays out of their way.
  const res = url.startsWith('/api/match')
    ? await trackMatchRequest(() => fetch(url, opts))
    : await fetch(url, opts)
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
    throw new Error(body.error ?? res.statusText)
  }
  return res.json() as Promise<T>
}

// ── Toast ──────────────────────────────────────────────────────────────────────

interface ToastMsg { id: number; msg: string; type: 'success' | 'error' | 'info' }
let _toastId = 0

function Toasts({ toasts, remove }: { toasts: ToastMsg[]; remove: (id: number) => void }): JSX.Element {
  return (
    <div style={{
      position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
      zIndex: 999, display: 'flex', flexDirection: 'column', gap: 8,
      pointerEvents: 'none', width: 'min(360px, 90vw)',
    }}>
      {toasts.map((t) => (
        <div key={t.id} onClick={() => remove(t.id)} style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 12, padding: '10px 16px',
          fontSize: '.82rem', color: 'var(--text)',
          boxShadow: '0 4px 20px rgba(0,0,0,.4)',
          animation: 'toast-in .25s ease', pointerEvents: 'all',
          display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
          borderLeft: `3px solid var(--${t.type === 'success' ? 'green' : t.type === 'error' ? 'red' : 'blue'})`,
        }}>
          {t.msg}
        </div>
      ))}
    </div>
  )
}

function useToast() {
  const [toasts, setToasts] = useState<ToastMsg[]>([])
  const toast = useCallback((msg: string, type: ToastMsg['type'] = 'info', duration = 3000) => {
    const id = ++_toastId
    setToasts((prev: ToastMsg[]) => [...prev, { id, msg, type }])
    setTimeout(() => setToasts((prev: ToastMsg[]) => prev.filter((t) => t.id !== id)), duration)
  }, [])
  const remove = useCallback((id: number) => {
    setToasts((prev: ToastMsg[]) => prev.filter((t) => t.id !== id))
  }, [])
  return { toasts, toast, remove }
}

// ── SmallBadge ─────────────────────────────────────────────────────────────────

interface BadgeProps { children: ReactNode; style?: CSSProperties; variant?: 'good' | 'ok' | 'bad' }

function SmallBadge({ children, style, variant }: BadgeProps): JSX.Element {
  const variantStyle: CSSProperties =
    variant === 'good' ? { background: 'rgba(34,197,94,.15)',  color: '#4ade80' } :
    variant === 'ok'   ? { background: 'rgba(234,179,8,.15)',  color: '#facc15' } :
    variant === 'bad'  ? { background: 'rgba(239,68,68,.15)',  color: '#f87171' } :
    {}
  return (
    <span style={{
      fontSize: '.6rem', fontWeight: 700, padding: '1px 6px',
      borderRadius: 8, background: 'var(--border)', color: 'var(--dim)',
      ...variantStyle, ...style,
    }}>
      {children}
    </span>
  )
}

// ── SignedImage ────────────────────────────────────────────────────────────────
//
// `src` is a short-lived presigned IDrive e2 URL minted by /api/match (see
// src/lib/e2.ts). It is empty when e2 isn't configured on the server, and it
// can expire if a page sits open for over an hour — both just show the
// placeholder (↻ reloads the item with fresh URLs).

function SignedImage({ src, style }: { src: string; style?: CSSProperties }): JSX.Element {
  const [failed, setFailed] = useState(!src)

  useEffect(() => { setFailed(!src) }, [src])

  if (failed || !src) {
    return (
      <div style={{ ...style, background: 'var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2rem', color: 'var(--muted)' }}>
        🖼️
      </div>
    )
  }

  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      style={style}
      onError={() => setFailed(true)}
    />
  )
}

// ── CandidateCard ─────────────────────────────────────────────────────────────

interface CandidateCardProps {
  c: Candidate
  isSelected: boolean
  isAuto: boolean
  isPartnerOnly: boolean
  isVideo: boolean
  waDuration: number | null
}

function CandidateCard({ c, isSelected, isAuto, isPartnerOnly, isVideo, waDuration }: CandidateCardProps): JSX.Element {
  const hDist = c.hamming
  const tDist = c.thumb_hamming
  const isPartner = c.source === 'partner'

  // H (videohash2-to-videohash2 or imagehash-to-imagehash) is a single
  // well-calibrated distance either way — full good/ok/bad coloring.
  // T (first-frame hash) mixes two source pipelines for videos (see
  // match_hashes_video), so it keeps the simpler green/grey treatment.
  const hVariant = hammingClass(hDist)
  const tVariant = isVideo ? lowDistanceVariant(tDist) : ''

  const durationVariant = closenessVariant(c.duration, waDuration)
  const resVariant = resolutionVariant(c.size, isVideo)

  const filesizeDisplay = fmtBytes(c.filesize_bytes)
  const fsVariant = filesizeVariant(c.filesize_bytes, isVideo)

  const jpegQVariant = jpegQualityVariant(c.jpeg_quality)
  const chroma = chromaInfo(c.pixel_format)
  const hdr = hdrInfo(c.bit_depth, c.color_primaries)
  const colorProfile = colorProfileInfo(c.color_space, c.color_transfer)
  const colorRange = colorRangeInfo(c.color_range)

  return (
    <div style={{
      background: 'var(--surface)',
      border: `2px solid ${isSelected ? 'var(--green)' : isAuto ? 'var(--yellow)' : 'var(--border)'}`,
      borderRadius: 'var(--radius)', overflow: 'hidden',
      cursor: isPartnerOnly ? 'default' : 'pointer',
      opacity: isPartnerOnly ? 0.85 : 1,
      transition: 'border-color .15s', position: 'relative',
    }}>
      {isAuto && !isSelected && (
        <div style={{
          position: 'absolute', top: 6, left: 6, fontSize: '.55rem',
          fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px',
          background: 'var(--yellow)', color: '#09090b',
          padding: '2px 6px', borderRadius: 6, zIndex: 1,
        }}>Auto ⚡</div>
      )}
      {isSelected && (
        <div style={{
          position: 'absolute', top: 6, right: 6, width: 22, height: 22,
          borderRadius: '50%', background: 'var(--green)', color: 'white',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '.75rem', fontWeight: 700, zIndex: 1,
        }}>✓</div>
      )}
      <SignedImage
        src={c.thumbnail_url}
        style={{ width: '100%', aspectRatio: '1', objectFit: 'contain', background: 'var(--border)', display: 'block' }}
      />
      <div style={{ padding: 8 }}>
        <div style={{ fontSize: '.7rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 4 }}>
          {c.filename || ''}
        </div>
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginBottom: 4 }}>
          <SmallBadge style={{ background: isPartner ? 'rgba(59,130,246,.15)' : 'rgba(168,85,247,.15)', color: isPartner ? '#60a5fa' : '#c084fc' }}>
            {isPartner ? 'Partner' : 'Hashes'}
          </SmallBadge>
          {'origin' in c && c.origin && <SmallBadge>{String(c.origin)}</SmallBadge>}
          {hDist != null && (
            <SmallBadge variant={hVariant || undefined}>H:{hDist}</SmallBadge>
          )}
          {tDist != null && (
            <SmallBadge variant={tVariant || undefined}>T:{tDist}</SmallBadge>
          )}
          {'pixel_dist' in c && c.pixel_dist != null && (
            <SmallBadge variant={c.pixel_dist <= 5 ? 'good' : c.pixel_dist <= 15 ? 'ok' : 'bad'}>
              Px:{c.pixel_dist}
            </SmallBadge>
          )}
          {c.duration != null && (
            <SmallBadge variant={durationVariant || undefined}>⏱ {fmtDuration(c.duration)}</SmallBadge>
          )}
          {c.size && (
            <SmallBadge variant={resVariant || undefined}>{c.size}</SmallBadge>
          )}
          {filesizeDisplay && (
            <SmallBadge variant={fsVariant || undefined}>{filesizeDisplay}</SmallBadge>
          )}
          {c.jpeg_quality != null && (
            <SmallBadge variant={jpegQVariant || undefined}>Q:{c.jpeg_quality}</SmallBadge>
          )}
          {chroma && (
            <SmallBadge variant={chroma.variant || undefined}>{chroma.label}</SmallBadge>
          )}
          {hdr && (
            <SmallBadge variant={hdr.variant || undefined}>{hdr.label}</SmallBadge>
          )}
          {colorProfile && (
            <SmallBadge variant={colorProfile.variant || undefined}>{colorProfile.label}</SmallBadge>
          )}
          {colorRange && (
            <SmallBadge variant={colorRange.variant || undefined}>{colorRange.label}</SmallBadge>
          )}
          {'camera_name' in c && c.camera_name && (
            <SmallBadge style={{ background: 'rgba(34,197,94,.1)', color: '#4ade80' }}>📷</SmallBadge>
          )}
          {'location' in c && c.location && (
            <SmallBadge style={{ background: 'rgba(59,130,246,.1)', color: '#60a5fa' }}>📍</SmallBadge>
          )}
        </div>
        <div style={{ fontSize: '.6rem', color: 'var(--muted)' }}>
          {fmtDate(c.timestamp)}
        </div>
        {c.url && (
          <div style={{ fontSize: '.6rem', marginTop: 2 }}>
            <a href={c.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>🔗 link</a>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Btn ────────────────────────────────────────────────────────────────────────

type BtnVariant = 'primary' | 'ghost' | 'green' | 'red' | 'yellow' | 'blue'

interface BtnProps {
  onClick?: () => void
  disabled?: boolean
  loading?: boolean
  variant?: BtnVariant
  children: ReactNode
  style?: CSSProperties
}

const BTN_BG: Record<BtnVariant, string> = {
  primary: 'var(--accent)', ghost: 'var(--surface)', green: 'var(--green)',
  red: 'var(--red)', yellow: 'var(--yellow)', blue: 'var(--blue)',
}
const BTN_COLOR: Record<BtnVariant, string> = {
  primary: 'white', ghost: 'var(--dim)', green: 'white',
  red: 'white', yellow: '#09090b', blue: 'white',
}

function Btn({ onClick, disabled, loading, variant = 'ghost', children, style }: BtnProps): JSX.Element {
  return (
    <button onClick={onClick} disabled={disabled ?? loading} style={{
      border: variant === 'ghost' ? '1px solid var(--border)' : 'none',
      borderRadius: 20, padding: '6px 14px',
      fontSize: '.78rem', fontWeight: 600, cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', gap: 5,
      background: BTN_BG[variant], color: BTN_COLOR[variant],
      opacity: disabled ?? loading ? 0.45 : 1,
      transition: 'opacity .15s', ...style,
    }}>
      {loading ? '…' : children}
    </button>
  )
}

// ── PanelRow ───────────────────────────────────────────────────────────────────

function PanelRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 0', borderBottom: '1px solid var(--border)', gap: 12,
    }}>
      <span style={{ fontSize: '.85rem', color: 'var(--dim)' }}>{label}</span>
      {children}
    </div>
  )
}

// ── SettingsPanel ──────────────────────────────────────────────────────────────

interface SettingsPanelProps {
  open: boolean
  onClose: () => void
  autoAdvance: boolean
  showPartner: boolean
  onAutoAdvanceChange: (v: boolean) => void
  onShowPartnerChange: (v: boolean) => void
  onSignOut: () => void
  version: string | null
}

function SettingsPanel({
  open, onClose, autoAdvance, showPartner,
  onAutoAdvanceChange, onShowPartnerChange, onSignOut, version,
}: SettingsPanelProps): JSX.Element | null {
  if (!open) return null
  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) onClose() }} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)',
      zIndex: 200, display: 'flex', alignItems: 'flex-end',
    }}>
      <div style={{
        background: 'var(--surface)', borderRadius: '20px 20px 0 0',
        padding: '20px 18px 32px', width: '100%', maxHeight: '85vh',
        overflowY: 'auto', animation: 'slide-up .3s ease',
      }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 16 }}>⚙️ Settings</h2>

        <div style={{ fontSize: '.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.8px', color: 'var(--muted)', margin: '0 0 8px' }}>
          Version
        </div>
        <PanelRow label="App version">
          <span style={{ fontFamily: 'monospace', fontSize: '.78rem', color: 'var(--accent)' }}>
            {version ?? '…'}
          </span>
        </PanelRow>

        <div style={{ fontSize: '.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.8px', color: 'var(--muted)', margin: '16px 0 8px' }}>
          Options
        </div>
        <PanelRow label="Auto-advance after commit">
          <input type="checkbox" checked={autoAdvance}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onAutoAdvanceChange(e.target.checked)}
            style={{ width: 18, height: 18, cursor: 'pointer' }} />
        </PanelRow>
        <PanelRow label="Show partner candidates">
          <input type="checkbox" checked={showPartner}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onShowPartnerChange(e.target.checked)}
            style={{ width: 18, height: 18, cursor: 'pointer' }} />
        </PanelRow>

        {/* ── Account ───────────────────────────────────────────────────── */}
        <div style={{ fontSize: '.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.8px', color: 'var(--muted)', margin: '16px 0 8px' }}>
          Account
        </div>
        <div style={{ paddingTop: 4 }}>
          <button
            onClick={onSignOut}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 8, padding: '10px 0',
              background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.25)',
              borderRadius: 12, color: '#f87171',
              fontSize: '.85rem', fontWeight: 600, cursor: 'pointer',
            }}
          >
            ↪ Sign out
          </button>
        </div>

        <div style={{ marginTop: 20 }}>
          <button onClick={onClose} style={{
            width: '100%', border: '1px solid var(--border)', borderRadius: 20,
            padding: '8px 0', background: 'var(--surface)', color: 'var(--dim)',
            fontSize: '.85rem', cursor: 'pointer',
          }}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ── SectionTitle ───────────────────────────────────────────────────────────────

function SectionTitle({ children, style }: { children: ReactNode; style?: CSSProperties }): JSX.Element {
  return (
    <div style={{
      fontSize: '.65rem', fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '.8px', color: 'var(--muted)', marginBottom: 8, ...style,
    }}>{children}</div>
  )
}

// ── WAItemCard ─────────────────────────────────────────────────────────────────

interface WAItemCardProps {
  item: NonNullable<MatchResponse['item']>
  onCommit: () => void
  onSkip: () => void
  onUndo: () => void
  hasUndo: boolean
  committing: boolean
  undoing: boolean
}

function WAItemCard({ item, onCommit, onSkip, onUndo, hasUndo, committing, undoing }: WAItemCardProps): JSX.Element {
  const filetype = item.filetype ?? ''
  const isVideo = filetype.toLowerCase().includes('video')
  const isImage = filetype.toLowerCase().includes('image')
  const ts = fmtDate(item.timestamp)

  const ftBadge = isVideo ? (
    <SmallBadge style={{ background: 'rgba(59,130,246,.15)', color: '#60a5fa' }}>Video</SmallBadge>
  ) : isImage ? (
    <SmallBadge style={{ background: 'rgba(34,197,94,.15)', color: '#4ade80' }}>Image</SmallBadge>
  ) : (
    <SmallBadge>{filetype}</SmallBadge>
  )

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 16 }}>
      <div style={{ display: 'flex', gap: 12, padding: 12 }}>
        <SignedImage
          src={item.thumbnail_url}
          style={{ width: 128, height: 128, objectFit: 'contain', borderRadius: 10, flexShrink: 0, background: 'var(--border)' }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '.85rem', fontWeight: 600, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {escHtml(item.filename || '(no filename)')}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            {ftBadge}
            {ts && <SmallBadge>{ts}</SmallBadge>}
            {isVideo && item.duration != null && <SmallBadge>⏱ {fmtDuration(item.duration)}</SmallBadge>}
            <SmallBadge>#{item.id}</SmallBadge>
          </div>
        </div>
      </div>

      {item.filename?.startsWith('Media') && (
        <WAMediaPreview
          filename={item.filename}
          isImage={isImage}
          isVideo={isVideo}
        />
      )}

      <div style={{ display: 'flex', gap: 8, padding: '10px 12px', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <Btn variant="green" onClick={onCommit} loading={committing}>✓ Commit selected</Btn>
        <Btn variant="ghost" onClick={onSkip}>Skip</Btn>
        <Btn variant="ghost" onClick={onUndo} disabled={!hasUndo} loading={undoing}>↩ Undo</Btn>
      </div>
    </div>
  )
}

// ── App state ──────────────────────────────────────────────────────────────────

interface AppState {
  /** wa id on screen; null when the queue is empty. After a commit with auto-advance off it is no longer in the queue. */
  currentId: number | null
  data: MatchResponse | null
  selectedId: number | null
  selectedSource: 'hashes' | 'partner' | null
  loading: boolean
  error: string | null
}

// Items are cached by wa id, never by queue position: committing or skipping an
// item shifts every position behind it but changes nothing about the items
// themselves (their candidates depend only on their own hash). The page keeps
// the ordered list of unmatched ids (/api/match/queue) and looks items up here.
//   CACHE_TTL         presigned thumbnail URLs last 1 h (src/lib/e2.ts); stay well inside that
//   CACHE_MAX         entries kept (least recently used go first)
//   PREFETCH_AHEAD    how many items after the current one are fetched in advance
//   PREFETCH_PARALLEL how many of those requests run at once (each downloads
//                     thumbnails and runs sharp on the server)
const CACHE_TTL = 20 * 60_000
const CACHE_MAX = 30
const PREFETCH_AHEAD = 5
const PREFETCH_PARALLEL = 2
/** A prefetch that failed is not retried for this long. */
const PREFETCH_RETRY_MS = 30_000

// "Search wider" escalation. Every item starts on 'fast' (approximate HNSW,
// ef_search 40). The user can step it up when the candidates look wrong:
// first click → 'wide' (ef_search 400), second click → 'exact' (full scan).
// The mode each result came from is echoed by the API (`search_mode`), so the
// current level is derived from the data itself — including cached data —
// rather than tracked separately.
const NEXT_SEARCH_MODE: Record<SearchMode, SearchMode | null> = {
  fast: 'wide',
  wide: 'exact',
  exact: null,
}
const MODE_RANK: Record<SearchMode, number> = { fast: 0, wide: 1, exact: 2 }
const ESCALATE_LABEL: Record<SearchMode, string> = {
  fast: '🔍 Not finding it? Search wider',
  wide: '🎯 Still not there? Exact search',
  exact: '✓ Exact search done',
}
const SEARCH_MODE_BADGE: Record<SearchMode, string | null> = {
  fast: null,
  wide: 'wide search',
  exact: 'exact search',
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function Home(): JSX.Element {
  const [state, setState] = useState<AppState>({
    currentId: null, data: null, selectedId: null, selectedSource: null, loading: true, error: null,
  })
  const [queue, setQueueState] = useState<number[]>([])
  const [undoState, setUndoState] = useState<UndoState | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [version, setVersion] = useState<string | null>(null)
  const [autoAdvance, setAutoAdvance] = useState(true)
  const [showPartner, setShowPartner] = useState(true)
  const [online, setOnline] = useState(true)
  const [pendingIds, setPendingIds] = useState<number[]>([])   // commits still being saved in the background
  const [undoing, setUndoing] = useState(false)
  const [escalating, setEscalating] = useState(false)
  const { toasts, toast, remove: removeToast } = useToast()

  // Cache and bookkeeping. Refs, because the async code below must see the
  // latest values, not the ones from the render it was created in.
  const cacheRef = useRef<Map<number, { data: MatchResponse; ts: number }>>(new Map())
  const inflightRef = useRef<Map<number, Promise<MatchResponse>>>(new Map())
  const failedRef = useRef<Map<number, number>>(new Map())
  const queueRef = useRef<number[]>([])          // mirror of `queue`, updated synchronously
  const currentIdRef = useRef<number | null>(null)
  const ghostPosRef = useRef(0)                  // where the current item left the queue (auto-advance off)
  const loadTokenRef = useRef(0)                 // newest showItem call wins
  const mainLoadingRef = useRef(false)           // the item on screen is still being fetched
  const prefetchActiveRef = useRef(0)
  // Commits are optimistic: the item leaves the queue and the next one is shown at once, and the
  // request finishes in the background. committedRef holds every id committed this session (saving
  // or saved) so a re-read of the queue can't bring it back; it is cleared again on failure or undo.
  const committedRef = useRef<Set<number>>(new Set())
  const lastCommitRef = useRef<{ wa_id: number; promise: Promise<UndoState | null> } | null>(null)

  useEffect(() => {
    if (!panelOpen || version !== null) return
    fetch('/api/version')
      .then((r) => (r.ok ? r.json() as Promise<{ version: string }> : Promise.reject()))
      .then((d) => setVersion(d.version))
      .catch(() => setVersion('unknown'))
  }, [panelOpen, version])

  useEffect(() => {
    setAutoAdvance(localStorage.getItem('opt-auto-advance') !== 'false')
    setShowPartner(localStorage.getItem('opt-show-partner') !== 'false')
  }, [])

  // ── Queue + cache plumbing ─────────────────────────────────────────────────

  const setQueue = useCallback((ids: number[]) => {
    queueRef.current = ids
    setQueueState(ids)
  }, [])

  const cacheGet = useCallback((id: number): MatchResponse | null => {
    const hit = cacheRef.current.get(id)
    if (!hit) return null
    if (Date.now() - hit.ts > CACHE_TTL) { cacheRef.current.delete(id); return null }
    cacheRef.current.delete(id)
    cacheRef.current.set(id, hit) // most recently used goes last
    return hit.data
  }, [])

  const cachePut = useCallback((id: number, data: MatchResponse, force = false) => {
    const prev = cacheRef.current.get(id)
    // A background fast search must not replace a wider one the user asked for.
    if (!force && prev && Date.now() - prev.ts <= CACHE_TTL &&
        MODE_RANK[prev.data.search_mode ?? 'fast'] > MODE_RANK[data.search_mode ?? 'fast']) return
    cacheRef.current.delete(id)
    cacheRef.current.set(id, { data, ts: Date.now() })
    while (cacheRef.current.size > CACHE_MAX) {
      const oldest = cacheRef.current.keys().next().value
      if (oldest === undefined) break
      cacheRef.current.delete(oldest)
    }
  }, [])

  /** Fetches one item by id. Requests for the same id share one network call (unless forced). */
  const fetchItem = useCallback((id: number, force = false): Promise<MatchResponse> => {
    if (!force) {
      const running = inflightRef.current.get(id)
      if (running) return running
    }
    const p: Promise<MatchResponse> = apiFetch<MatchResponse>(`/api/match?id=${id}`)
      .then((data) => {
        if (!data.resolved) cachePut(id, data, force)
        return data
      })
      .finally(() => { if (inflightRef.current.get(id) === p) inflightRef.current.delete(id) })
    inflightRef.current.set(id, p)
    return p
  }, [cachePut])

  /**
   * Where the current item sits in the queue. If it already left the queue
   * (committed with auto-advance off) we stand in the gap it left behind.
   */
  const locate = useCallback(() => {
    const q = queueRef.current
    const idx = currentIdRef.current === null ? -1 : q.indexOf(currentIdRef.current)
    const gap = idx >= 0 ? idx : Math.min(ghostPosRef.current, q.length)
    const aheadFrom = idx >= 0 ? idx + 1 : gap
    return { q, prev: q[gap - 1] ?? null, next: q[aheadFrom] ?? null, aheadFrom }
  }, [])

  /** Keeps up to PREFETCH_PARALLEL requests running for the next PREFETCH_AHEAD items. */
  const pump = useCallback(() => {
    if (mainLoadingRef.current) return // the item on screen goes first
    const { q, aheadFrom } = locate()
    for (const id of q.slice(aheadFrom, aheadFrom + PREFETCH_AHEAD)) {
      if (prefetchActiveRef.current >= PREFETCH_PARALLEL) return
      if (inflightRef.current.has(id)) continue
      const hit = cacheRef.current.get(id)
      if (hit && Date.now() - hit.ts <= CACHE_TTL) continue
      const failedAt = failedRef.current.get(id)
      if (failedAt !== undefined && Date.now() - failedAt < PREFETCH_RETRY_MS) continue
      prefetchActiveRef.current++
      fetchItem(id)
        .then((data) => {
          // Handled elsewhere in the meantime: drop it from the queue (it is ahead of the
          // current item, so no position before it moves) instead of asking for it again.
          if (data.resolved) setQueue(queueRef.current.filter((x) => x !== id))
        })
        .catch(() => { failedRef.current.set(id, Date.now()) }) // silent: it is fetched when you get there
        .finally(() => { prefetchActiveRef.current--; pump() })
    }
  }, [fetchItem, locate, setQueue])

  const showEmpty = useCallback(() => {
    currentIdRef.current = null
    mainLoadingRef.current = false
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search) } catch { /* ignore */ }
    setState((s: AppState) => ({
      ...s, currentId: null, data: null, loading: false, error: null, selectedId: null, selectedSource: null,
    }))
  }, [])

  /** Puts the item with this id on screen: from the cache if it is there, otherwise from the server. */
  const showItem = useCallback(async (id: number, force = false): Promise<void> => {
    const token = ++loadTokenRef.current
    currentIdRef.current = id
    try { window.history.replaceState(null, '', `#wa-${id}`) } catch { /* ignore */ }

    const cached = force ? null : cacheGet(id)
    if (cached) {
      mainLoadingRef.current = false
      const autoId = cached.auto_select_id
      setState((s: AppState) => ({
        ...s, currentId: id, data: cached, loading: false, error: null,
        selectedId: autoId ?? null, selectedSource: autoId ? 'hashes' : null,
      }))
      pump()
      return
    }

    mainLoadingRef.current = true
    setState((s: AppState) => ({
      ...s, currentId: id, loading: true, error: null, selectedId: null, selectedSource: null,
    }))
    try {
      const data = await fetchItem(id, force)
      if (token !== loadTokenRef.current) return // the user moved on while this was loading
      if (data.resolved || !data.item) {
        // Matched or skipped somewhere else: drop it and move to the item that took its place.
        const q = queueRef.current
        const i = q.indexOf(id)
        const rest = q.filter((x) => x !== id)
        setQueue(rest)
        toast('Already handled elsewhere, skipped it', 'info')
        const at = i >= 0 ? i : 0
        const target = rest[at] ?? rest[at - 1] ?? null
        mainLoadingRef.current = false
        if (target === null) showEmpty()
        else await showItem(target)
        return
      }
      const autoId = data.auto_select_id
      setState((s: AppState) => ({
        ...s, currentId: id, data, loading: false, error: null,
        selectedId: autoId ?? null, selectedSource: autoId ? 'hashes' : null,
      }))
    } catch (err) {
      if (token !== loadTokenRef.current) return
      const msg = err instanceof Error ? err.message : 'Failed to load'
      toast(msg, 'error')
      setState((s: AppState) => ({ ...s, loading: false, error: msg }))
    } finally {
      if (token === loadTokenRef.current) { mainLoadingRef.current = false; pump() }
    }
  }, [cacheGet, fetchItem, pump, setQueue, showEmpty, toast])

  /** Reads the full list of unmatched ids from the server (the one source of truth for order and size). */
  const syncQueue = useCallback(async (): Promise<number[]> => {
    const res = await apiFetch<QueueResponse>('/api/match/queue')
    const ids = Array.from(new Set(res.ids)).filter((id) => !committedRef.current.has(id))
    setQueue(ids)
    return ids
  }, [setQueue])

  /** ↻ and Retry: re-read the queue and re-search the current item from scratch. */
  const refresh = useCallback(async () => {
    try {
      const ids = await syncQueue()
      const cur = currentIdRef.current
      const target = cur !== null && ids.includes(cur) ? cur : (locate().next ?? ids[0] ?? null)
      if (target === null) showEmpty()
      else await showItem(target, true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load'
      toast(msg, 'error')
      setState((s: AppState) => ({ ...s, loading: false, error: msg }))
    }
  }, [locate, showEmpty, showItem, syncQueue, toast])

  const goNext = useCallback(() => {
    const { next } = locate()
    if (next !== null) void showItem(next)
  }, [locate, showItem])

  const goPrev = useCallback(() => {
    const { prev } = locate()
    if (prev !== null) void showItem(prev)
  }, [locate, showItem])

  const checkOnline = useCallback(async () => {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' })
      setOnline(res.ok)
    } catch { setOnline(false) }
  }, [])

  useEffect(() => {
    checkOnline()
    const iv = setInterval(checkOnline, 30_000)
    return () => clearInterval(iv)
  }, [checkOnline])

  // First load: read the queue, then open the item named in the URL hash (#wa-123) or the first one.
  useEffect(() => {
    void (async () => {
      try {
        const ids = await syncQueue()
        const m = /^#wa-(\d+)$/.exec(window.location.hash)
        const wanted = m ? parseInt(m[1], 10) : null
        const start = wanted !== null && ids.includes(wanted) ? wanted : (ids[0] ?? null)
        if (start === null) showEmpty()
        else await showItem(start)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to load'
        toast(msg, 'error')
        setState((s: AppState) => ({ ...s, loading: false, error: msg }))
      }
    })()
  }, [syncQueue, showItem, showEmpty, toast])

  // Warn before leaving the page while commits are still being saved.
  useEffect(() => {
    if (pendingIds.length === 0) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pendingIds.length])

  useEffect(() => {
    const onOnline = () => { setOnline(true); void checkOnline() }
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline) }
  }, [checkOnline])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'Enter' || e.key === 'c') { void doCommit(); return }
      if (e.key === 'ArrowRight' || e.key === 'n') { goNext(); return }
      if (e.key === 'ArrowLeft'  || e.key === 'p') { goPrev(); return }
      if (e.key === 'r') { void refresh(); return }
      if (e.key === 'e') { void doEscalate(); return }
      const num = parseInt(e.key, 10)
      if (num >= 1 && num <= 9) {
        const cards = document.querySelectorAll<HTMLElement>('[data-candidate-id]')
        cards[num - 1]?.click()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  // ── Actions ────────────────────────────────────────────────────────────────

  /**
   * Takes a finished item (committed, skipped, or found handled elsewhere) out of
   * the queue. If it is the one on screen and `advance` is set, moves on to the
   * item that now sits at its position; with `advance` off it stays on screen and
   * Prev / Next work from the gap it left. Nothing else needs refetching: every
   * other cached item is still valid.
   */
  async function removeFinished(id: number, advance: boolean) {
    const q = queueRef.current
    const i = q.indexOf(id)
    const rest = q.filter((x) => x !== id)
    setQueue(rest)
    if (currentIdRef.current !== id) { pump(); return } // the user already moved on; don't yank them back
    if (i >= 0) ghostPosRef.current = i
    if (!advance) { pump(); return }
    const at = i >= 0 ? i : ghostPosRef.current
    const target = rest[at] ?? rest[at - 1] ?? null
    if (target === null) showEmpty()
    else await showItem(target)
  }

  /**
   * Optimistic commit: the item leaves the queue and the next one is on screen right away; the
   * request runs in the background. If it fails, the item goes back to its place in the queue and
   * an error toast names it (and it is shown again if there is nothing else on screen).
   */
  function doCommit() {
    if (state.loading) return // `state.data` may still be the previous item while the next one loads
    const effectiveId = state.selectedId ?? state.data?.auto_select_id ?? null
    if (!effectiveId) { toast('Select a candidate first', 'error'); return }
    const item = state.data?.item
    if (!item) return
    const waId = item.id
    if (committedRef.current.has(waId)) return // already committed (e.g. a second Enter)

    const origIndex = queueRef.current.indexOf(waId)
    committedRef.current.add(waId)
    setPendingIds((p: number[]) => [...p, waId])

    const promise: Promise<UndoState | null> = apiFetch<{ ok: boolean; prev_id_hash: number | null }>('/api/match/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wa_id: waId, hash_id: effectiveId }),
      keepalive: true, // survives a reload or tab close while in flight
    })
      .then((res) => {
        const undo: UndoState = { wa_id: waId, prev_id_hash: res.prev_id_hash }
        if (lastCommitRef.current?.wa_id === waId) setUndoState(undo)
        return undo
      })
      .catch((err: unknown) => {
        committedRef.current.delete(waId)
        if (lastCommitRef.current?.wa_id === waId) { lastCommitRef.current = null; setUndoState(null) }
        const q = queueRef.current
        if (!q.includes(waId)) {
          const copy = [...q]
          copy.splice(Math.min(Math.max(origIndex, 0), copy.length), 0, waId)
          setQueue(copy)
        }
        toast(`Commit failed for #${waId}: ${err instanceof Error ? err.message : 'unknown error'}`, 'error', 8000)
        if (currentIdRef.current === null) void showItem(waId)
        return null
      })
      .finally(() => { setPendingIds((p: number[]) => p.filter((x) => x !== waId)) })

    lastCommitRef.current = { wa_id: waId, promise }
    toast('✓ Committed', 'success', 1500)
    void removeFinished(waId, autoAdvance)
  }

  // Re-run the current item's candidate search one level deeper (fast → wide →
  // exact). Stays on the same item and keeps the page visible (no full-screen
  // spinner); only the candidates and the auto-selection are replaced.
  async function doEscalate() {
    const current: SearchMode = state.data?.search_mode ?? 'fast'
    const next = NEXT_SEARCH_MODE[current]
    if (!next || escalating || state.loading || !state.data?.item || state.currentId === null) return
    const at = state.currentId
    setEscalating(true)
    try {
      const data = await apiFetch<MatchResponse>(`/api/match?id=${at}&mode=${next}`)
      if (data.resolved || !data.item) {
        toast('Already handled elsewhere, skipped it', 'info')
        await removeFinished(at, true)
        return
      }
      // Keep the wider result with its item, so it is still there when you come back to it.
      cachePut(at, data, true)
      const autoId = data.auto_select_id
      // If the user moved to another item while this was running, the result stays in the
      // cache (keyed by its own id) but the screen is left alone.
      setState((s: AppState) => s.currentId !== at ? s : {
        ...s, data,
        selectedId: autoId ?? null,
        selectedSource: autoId ? 'hashes' : null,
      })
      const n = data.candidates.length + data.partner_candidates.length
      toast(`${next === 'wide' ? 'Wide' : 'Exact'} search: ${n} candidate${n !== 1 ? 's' : ''}`, 'info')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Search failed', 'error')
    } finally { setEscalating(false) }
  }

  async function doSkip() {
    const item = state.data?.item
    if (!item) return
    try {
      await apiFetch('/api/match/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wa_id: item.id }),
      })
      toast('Skipped', 'info')
      await removeFinished(item.id, true)
    } catch (err) { toast(err instanceof Error ? err.message : 'Skip failed', 'error') }
  }

  async function doUndo() {
    const last = lastCommitRef.current
    if (!last) { toast('Nothing to undo', 'error'); return }
    setUndoing(true)
    try {
      // The commit may still be saving: wait for it (its answer carries the previous id_hash).
      const undone = await last.promise
      if (!undone) return // it failed and was already rolled back
      await apiFetch('/api/match/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(undone),
      })
      committedRef.current.delete(undone.wa_id)
      if (lastCommitRef.current === last) lastCommitRef.current = null
      setUndoState(null)
      toast('↩ Undone', 'info')
      // The restored item goes back to its place in the queue: re-read the order, then show it
      // (its earlier result is usually still cached, so it appears at once).
      const ids = await syncQueue()
      const target = ids.includes(undone.wa_id) ? undone.wa_id : (locate().next ?? ids[0] ?? null)
      if (target === null) showEmpty()
      else await showItem(target)
    } catch (err) { toast(err instanceof Error ? err.message : 'Undo failed', 'error') }
    finally { setUndoing(false) }
  }

  async function doSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  function handleCandidateClick(c: Candidate) {
    if (c.source === 'partner') return
    setState((s: AppState) => {
      const same = s.selectedId === c.id && s.selectedSource === c.source
      return { ...s, selectedId: same ? null : c.id, selectedSource: same ? null : c.source }
    })
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const { data, loading, error, currentId, selectedId, selectedSource } = state
  const item = data?.item
  const autoSelectId = data?.auto_select_id ?? null
  const count = queue.length
  const idx = currentId !== null ? queue.indexOf(currentId) : -1
  const gap = idx >= 0 ? idx : Math.min(ghostPosRef.current, count)
  const position = Math.min(gap + 1, Math.max(count, 1))
  const hasPrev = gap > 0
  const hasNext = (idx >= 0 ? idx + 1 : gap) < count
  const pct = count > 0 ? Math.max(0, 100 - Math.round(((position - 1) / count) * 100)) : 0

  const allCandidates: Candidate[] = [
    ...(data?.candidates ?? []),
    ...(showPartner ? (data?.partner_candidates ?? []) : []),
  ]
  const itemIsVideo = (item?.filetype ?? '').toLowerCase().includes('video')
  const searchMode: SearchMode = data?.search_mode ?? 'fast'
  const modeBadge = SEARCH_MODE_BADGE[searchMode]
  const inMemory = data?.engine === 'memory'

  return (
    <>
      {/* Status bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 16px',
        background: 'var(--bg)', borderBottom: '1px solid var(--border)',
        fontSize: '.7rem', color: 'var(--muted)', position: 'sticky', top: 0, zIndex: 100,
      }}>
        <div style={{
          width: 7, height: 7, borderRadius: '50%',
          background: online ? 'var(--green)' : 'var(--red)', flexShrink: 0,
          animation: online ? 'none' : 'pulse 2s infinite',
        }} />
        <span style={{ flex: 1 }}>{online ? 'Online' : 'Server unreachable'}</span>
        <span style={{
          fontSize: '.65rem', color: 'var(--muted)', background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: 10, padding: '2px 8px',
        }}>📷 Photo Match</span>
      </div>

      {/* Header */}
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface)',
      }}>
        <div style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 7 }}>
          <span>📷</span> Photo Match
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <a href="/skipped" style={{
            border: '1px solid var(--border)', borderRadius: 10,
            padding: '6px 10px', background: 'var(--surface)',
            color: 'var(--dim)', fontSize: '.85rem', textDecoration: 'none',
          }} title="Skipped photos">⏭️</a>
          <button onClick={() => setPanelOpen(true)} style={{
            border: '1px solid var(--border)', borderRadius: 10,
            padding: '6px 10px', background: 'var(--surface)',
            color: 'var(--dim)', cursor: 'pointer', fontSize: '.85rem',
          }} title="Settings">⚙️</button>
        </div>
      </header>

      {/* Main */}
      <main style={{ padding: '12px 14px', maxWidth: 960, margin: '0 auto' }}>
        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '60px 20px', gap: 12, color: 'var(--muted)' }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', border: '3px solid var(--border)', borderTopColor: 'var(--accent)', animation: 'spin .7s linear infinite' }} />
            <span>Loading…</span>
          </div>
        )}

        {!loading && error && (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <div style={{ fontSize: '3rem', marginBottom: 8 }}>⚠️</div>
            <h2 style={{ fontSize: '1.2rem', marginBottom: 8 }}>Error</h2>
            <p style={{ color: 'var(--muted)', marginBottom: 16, fontSize: '.85rem' }}>{error}</p>
            <Btn variant="primary" onClick={() => void refresh()}>Retry</Btn>
          </div>
        )}

        {!loading && !error && (currentId === null || !item) && (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <div style={{ fontSize: '3rem', marginBottom: 8 }}>🎉</div>
            <h2 style={{ fontSize: '1.2rem', marginBottom: 8 }}>All done!</h2>
            <p style={{ color: 'var(--muted)', marginBottom: 16, fontSize: '.85rem' }}>No more items to match.</p>
            <Btn variant="ghost" onClick={() => void refresh()}>↻ Refresh</Btn>
          </div>
        )}

        {!loading && !error && item && currentId !== null && (
          <>
            {/* Progress */}
            <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', marginBottom: 12 }}>
              <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', borderRadius: 2, transition: 'width .4s ease' }} />
            </div>
            <div style={{ fontSize: '.7rem', color: 'var(--muted)', marginBottom: 10 }}>
              {count} remaining
            </div>

            {/* Nav */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Btn onClick={goPrev} disabled={!hasPrev}>‹ Prev</Btn>
              <div style={{ fontSize: '.75rem', color: 'var(--muted)', background: 'var(--border)', borderRadius: 8, padding: '4px 10px', minWidth: 80, textAlign: 'center' }}>
                {position} of {count}
              </div>
              <Btn onClick={goNext} disabled={!hasNext}>Next ›</Btn>
              <Btn onClick={() => void refresh()}>↻</Btn>
            </div>

            {/* Item */}
            <SectionTitle>Item to match</SectionTitle>
            <WAItemCard
              item={item}
              onCommit={() => void doCommit()}
              onSkip={() => void doSkip()}
              onUndo={() => void doUndo()}
              hasUndo={undoState !== null || pendingIds.length > 0}
              committing={currentId !== null && pendingIds.includes(currentId)}
              undoing={undoing}
            />

            {/* Candidates */}
            <SectionTitle style={{ marginTop: 16 }}>
              {data?.candidates.length ?? 0} hashes candidate{(data?.candidates.length ?? 0) !== 1 ? 's' : ''}
              {showPartner && (data?.partner_candidates.length ?? 0) > 0
                ? ` + ${data.partner_candidates.length} partner` : ''}
            </SectionTitle>

            {/* Escalate: re-search this item deeper (fast → wide → exact). Hidden when the
                in-memory engine answered: its scan is already exact, so there is nothing wider. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              {!inMemory && (
                <Btn
                  variant={searchMode === 'exact' ? 'ghost' : 'blue'}
                  onClick={() => void doEscalate()}
                  disabled={searchMode === 'exact' || escalating}
                  loading={escalating}
                >
                  {ESCALATE_LABEL[searchMode]}
                </Btn>
              )}
              {modeBadge && !inMemory && <SmallBadge>{modeBadge}</SmallBadge>}
              {data?.engine && (
                <>
                  <SmallBadge variant={inMemory ? 'good' : 'ok'}>
                    {inMemory ? '⚡ memory · exact' : '🗄 database'}
                  </SmallBadge>
                  {data.engine_reason && (
                    <span style={{ fontSize: '.62rem', color: 'var(--muted)' }}>{data.engine_reason}</span>
                  )}
                </>
              )}
            </div>

            {allCandidates.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 30, color: 'var(--muted)', fontSize: '.85rem' }}>
                No candidates found within threshold.
                {searchMode !== 'exact' && !inMemory && ' Try searching wider.'}
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
                {allCandidates.map((c) => {
                  const isSelected  = selectedId === c.id && selectedSource === c.source
                  const isAuto      = autoSelectId === c.id && c.source === 'hashes' && selectedId === null
                  return (
                    <div key={`${c.source}-${c.id}`} data-candidate-id={c.id} onClick={() => handleCandidateClick(c)}>
                      <CandidateCard
                        c={c}
                        isSelected={isSelected}
                        isAuto={isAuto}
                        isPartnerOnly={c.source === 'partner'}
                        isVideo={itemIsVideo}
                        waDuration={item?.duration ?? null}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </main>

      <SettingsPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        autoAdvance={autoAdvance}
        showPartner={showPartner}
        onAutoAdvanceChange={(v) => { setAutoAdvance(v); localStorage.setItem('opt-auto-advance', String(v)) }}
        onShowPartnerChange={(v) => { setShowPartner(v); localStorage.setItem('opt-show-partner', String(v)) }}
        onSignOut={() => void doSignOut()}
        version={version}
      />
      <Toasts toasts={toasts} remove={removeToast} />
    </>
  )
}
