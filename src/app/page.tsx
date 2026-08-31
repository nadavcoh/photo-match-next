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
} from '@/lib/types'
import { WAMediaPreview } from '@/components/WAMediaPreview'
import { createClient } from '@/lib/supabase-client'
import { THUMBNAILS_BUCKET } from '@/lib/thumbnails'

// ── Helpers ────────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString()
}

function fmtFilesize(s: string | null | undefined): string {
  if (!s) return ''
  return s.match(/\(([^)]+)\)/)?.[1] ?? s
}

function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return ''
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function hammingClass(d: number | null | undefined): '' | 'good' | 'ok' | 'bad' {
  if (d == null) return ''
  if (d <= 5)  return 'good'
  if (d <= 12) return 'ok'
  return 'bad'
}

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts)
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
// The thumbnails bucket is private. This component generates a short-lived
// signed URL directly via the authenticated Supabase browser client — no
// server-side proxy or service role key required.
// The storage RLS policy allows any authenticated user to read objects from
// the thumbnails bucket.

function SignedImage({ storagePath, style }: { storagePath: string; style?: CSSProperties }): JSX.Element {
  const [src, setSrc]       = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setFailed(false)

    const supabase = createClient()
    supabase.storage
      .from(THUMBNAILS_BUCKET)
      .createSignedUrl(storagePath, 120) // 2-minute TTL
      .then(({ data, error }) => {
        if (cancelled) return
        if (error || !data?.signedUrl) setFailed(true)
        else setSrc(data.signedUrl)
      })
      .catch(() => { if (!cancelled) setFailed(true) })

    return () => { cancelled = true }
  }, [storagePath])

  if (failed) {
    return (
      <div style={{ ...style, background: 'var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2rem', color: 'var(--muted)' }}>
        🖼️
      </div>
    )
  }

  if (!src) {
    return <div style={{ ...style, background: 'var(--border)' }} />
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
}

function CandidateCard({ c, isSelected, isAuto, isPartnerOnly, isVideo }: CandidateCardProps): JSX.Element {
  const hDist = c.hamming
  const tDist = c.thumb_hamming
  const isPartner = c.source === 'partner'

  // For videos, `hamming` (H:) is the WA item's video-thumbnail hash compared
  // against the candidate's *image* hash_bit column — a different hash space
  // used only to widen the candidate net (see match_hashes_video/
  // match_partner_video SQL). It's expected to look large/random for videos
  // and should NOT be color-coded as good/bad. `thumb_hamming` (T:) — thumb
  // vs. thumb — is the metric that's actually comparable for videos.
  const primaryDist = isVideo ? tDist : hDist
  const primaryVariant = hammingClass(primaryDist)

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
        storagePath={c.thumbnail_url}
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
            <SmallBadge variant={(!isVideo && primaryVariant) || undefined}>H:{hDist}</SmallBadge>
          )}
          {tDist != null && (
            <SmallBadge variant={(isVideo && primaryVariant) || undefined}>T:{tDist}</SmallBadge>
          )}
          {'pixel_dist' in c && c.pixel_dist != null && (
            <SmallBadge variant={c.pixel_dist <= 5 ? 'good' : c.pixel_dist <= 15 ? 'ok' : 'bad'}>
              Px:{c.pixel_dist}
            </SmallBadge>
          )}
          {'camera_name' in c && c.camera_name && (
            <SmallBadge style={{ background: 'rgba(34,197,94,.1)', color: '#4ade80' }}>📷</SmallBadge>
          )}
          {'location' in c && c.location && (
            <SmallBadge style={{ background: 'rgba(59,130,246,.1)', color: '#60a5fa' }}>📍</SmallBadge>
          )}
        </div>
        <div style={{ fontSize: '.6rem', color: 'var(--muted)' }}>
          {[fmtDate(c.timestamp), fmtDuration(c.duration), c.size, fmtFilesize('filesize' in c ? c.filesize : null)].filter(Boolean).join(' · ')}
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
          storagePath={item.thumbnail_url}
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
  offset: number
  data: MatchResponse | null
  selectedId: number | null
  selectedSource: 'hashes' | 'partner' | null
  loading: boolean
  error: string | null
}

const CACHE_TTL = 30_000

// ── Main page ──────────────────────────────────────────────────────────────────

export default function Home(): JSX.Element {
  const [state, setState] = useState<AppState>({
    offset: 0, data: null, selectedId: null, selectedSource: null, loading: true, error: null,
  })
  const [undoState, setUndoState] = useState<UndoState | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [version, setVersion] = useState<string | null>(null)
  const [autoAdvance, setAutoAdvance] = useState(true)
  const [showPartner, setShowPartner] = useState(true)
  const [online, setOnline] = useState(true)
  const [committing, setCommitting] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const { toasts, toast, remove: removeToast } = useToast()
  const cacheRef = useRef<Map<number, { data: MatchResponse; ts: number }>>(new Map())

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

  const prefetchNext = useCallback(async (offset: number) => {
    const next = offset + 1
    const cached = cacheRef.current.get(next)
    if (cached && Date.now() - cached.ts < CACHE_TTL) return
    try {
      const data = await apiFetch<MatchResponse>(`/api/match?offset=${next}`)
      cacheRef.current.set(next, { data, ts: Date.now() })
    } catch { /* silent */ }
  }, [])

  const loadMatch = useCallback(async (offset: number, bustCache = false) => {
    setState((s: AppState) => ({ ...s, loading: true, error: null, selectedId: null, selectedSource: null, offset }))

    if (!bustCache) {
      const cached = cacheRef.current.get(offset)
      if (cached && Date.now() - cached.ts < CACHE_TTL) {
        const autoId = cached.data.auto_select_id
        setState((s: AppState) => ({
          ...s, data: cached.data, loading: false,
          selectedId: autoId ?? null,
          selectedSource: autoId ? 'hashes' : null,
        }))
        prefetchNext(offset)
        return
      }
    }

    try {
      const data = await apiFetch<MatchResponse>(`/api/match?offset=${offset}`)
      cacheRef.current.set(offset, { data, ts: Date.now() })
      const autoId = data.auto_select_id
      setState((s: AppState) => ({
        ...s, data, loading: false,
        selectedId: autoId ?? null,
        selectedSource: autoId ? 'hashes' : null,
      }))
      prefetchNext(offset)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load'
      toast(msg, 'error')
      setState((s: AppState) => ({ ...s, loading: false, error: msg }))
    }
  }, [prefetchNext, toast])

  const checkOnline = useCallback(async () => {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' })
      setOnline(res.ok)
    } catch { setOnline(false) }
  }, [])

  useEffect(() => {
    checkOnline()
    const iv = setInterval(checkOnline, 30_000)
    loadMatch(0)
    return () => clearInterval(iv)
  }, [checkOnline, loadMatch])

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
      const { offset } = state
      if (e.key === 'Enter' || e.key === 'c') { void doCommit(); return }
      if ((e.key === 'ArrowRight' || e.key === 'n') && state.data?.count) { void loadMatch(offset + 1); return }
      if ((e.key === 'ArrowLeft'  || e.key === 'p') && offset > 0)        { void loadMatch(offset - 1); return }
      if (e.key === 'r') { void loadMatch(offset, true); return }
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

  async function doCommit() {
    const effectiveId = state.selectedId ?? state.data?.auto_select_id ?? null
    if (!effectiveId) { toast('Select a candidate first', 'error'); return }
    if (!state.data?.item) return
    setCommitting(true)
    try {
      const res = await apiFetch<{ ok: boolean; prev_id_hash: number | null }>('/api/match/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wa_id: state.data.item.id, hash_id: effectiveId }),
      })
      setUndoState({ wa_id: state.data.item.id, prev_id_hash: res.prev_id_hash })
      cacheRef.current.delete(state.offset)
      toast('✓ Committed!', 'success')
      if (autoAdvance) await loadMatch(state.offset, true)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Commit failed', 'error')
    } finally { setCommitting(false) }
  }

  async function doSkip() {
    if (!state.data?.item) return
    try {
      await apiFetch('/api/match/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wa_id: state.data.item.id }),
      })
      cacheRef.current.delete(state.offset)
      toast('Skipped', 'info')
      await loadMatch(state.offset, true)
    } catch (err) { toast(err instanceof Error ? err.message : 'Skip failed', 'error') }
  }

  async function doUndo() {
    if (!undoState) { toast('Nothing to undo', 'error'); return }
    setUndoing(true)
    try {
      await apiFetch('/api/match/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(undoState),
      })
      setUndoState(null)
      cacheRef.current.clear()
      toast('↩ Undone', 'info')
      await loadMatch(state.offset, true)
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

  const { data, loading, error, offset, selectedId, selectedSource } = state
  const item = data?.item
  const autoSelectId = data?.auto_select_id ?? null
  const count = data?.count ?? 0
  const pct = count > 0 ? Math.max(0, 100 - Math.round((offset / count) * 100)) : 0

  const allCandidates: Candidate[] = [
    ...(data?.candidates ?? []),
    ...(showPartner ? (data?.partner_candidates ?? []) : []),
  ]
  const itemIsVideo = (item?.filetype ?? '').toLowerCase().includes('video')

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
        <button onClick={() => setPanelOpen(true)} style={{
          border: '1px solid var(--border)', borderRadius: 10,
          padding: '6px 10px', background: 'var(--surface)',
          color: 'var(--dim)', cursor: 'pointer', fontSize: '.85rem',
        }} title="Settings">⚙️</button>
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
            <Btn variant="primary" onClick={() => void loadMatch(0, true)}>Retry</Btn>
          </div>
        )}

        {!loading && !error && (!item || count === 0) && (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <div style={{ fontSize: '3rem', marginBottom: 8 }}>🎉</div>
            <h2 style={{ fontSize: '1.2rem', marginBottom: 8 }}>All done!</h2>
            <p style={{ color: 'var(--muted)', marginBottom: 16, fontSize: '.85rem' }}>No more items to match.</p>
            <Btn variant="ghost" onClick={() => void loadMatch(0, true)}>↻ Refresh</Btn>
          </div>
        )}

        {!loading && !error && item && count > 0 && (
          <>
            {/* Progress */}
            <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', marginBottom: 12 }}>
              <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', borderRadius: 2, transition: 'width .4s ease' }} />
            </div>
            <div style={{ fontSize: '.7rem', color: 'var(--muted)', marginBottom: 10 }}>
              {count} remaining · item {offset + 1}
            </div>

            {/* Nav */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Btn onClick={() => void loadMatch(Math.max(0, offset - 1))} disabled={offset === 0}>‹ Prev</Btn>
              <div style={{ fontSize: '.75rem', color: 'var(--muted)', background: 'var(--border)', borderRadius: 8, padding: '4px 10px', minWidth: 80, textAlign: 'center' }}>
                offset {offset}
              </div>
              <Btn onClick={() => void loadMatch(offset + 1)}>Next ›</Btn>
              <Btn onClick={() => void loadMatch(offset, true)}>↻</Btn>
            </div>

            {/* Item */}
            <SectionTitle>Item to match</SectionTitle>
            <WAItemCard
              item={item}
              onCommit={() => void doCommit()}
              onSkip={() => void doSkip()}
              onUndo={() => void doUndo()}
              hasUndo={undoState !== null}
              committing={committing}
              undoing={undoing}
            />

            {/* Candidates */}
            <SectionTitle style={{ marginTop: 16 }}>
              {data?.candidates.length ?? 0} hashes candidate{(data?.candidates.length ?? 0) !== 1 ? 's' : ''}
              {showPartner && (data?.partner_candidates.length ?? 0) > 0
                ? ` + ${data.partner_candidates.length} partner` : ''}
            </SectionTitle>

            {allCandidates.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 30, color: 'var(--muted)', fontSize: '.85rem' }}>
                No candidates found within threshold.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
                {allCandidates.map((c) => {
                  const isSelected  = selectedId === c.id && selectedSource === c.source
                  const isAuto      = autoSelectId === c.id && c.source === 'hashes' && selectedId === null
                  return (
                    <div key={`${c.source}-${c.id}`} data-candidate-id={c.id} onClick={() => handleCandidateClick(c)}>
                      <CandidateCard c={c} isSelected={isSelected} isAuto={isAuto} isPartnerOnly={c.source === 'partner'} isVideo={itemIsVideo} />
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
