'use client'

/**
 * src/app/skipped/page.tsx
 *
 * Skipped photos: every wa item that was skipped (processed = true, no id_hash),
 * newest first, 48 at a time. Tap a thumbnail to see the original (WAMediaPreview,
 * for items whose filename starts with "Media") and to put it back in the queue.
 *
 * Restoring uses the existing POST /api/match/undo with prev_id_hash = null, which
 * clears processed so the item shows up in the unmatched queue again (the main page
 * reads the queue when it loads, or on ↻).
 */

import { useCallback, useEffect, useRef, useState, JSX } from 'react'
import type { CSSProperties } from 'react'
import { WAMediaPreview } from '@/components/WAMediaPreview'
import type { SkippedItem, SkippedResponse } from '@/lib/types'

const PAGE_SIZE = 48

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString()
}

function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return ''
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function isImage(it: SkippedItem): boolean { return (it.filetype ?? '').includes('image') }
function isVideo(it: SkippedItem): boolean { return (it.filetype ?? '').includes('video') }

// ── Thumbnail ─────────────────────────────────────────────────────────────────
// Same idea as SignedImage in the main page: an empty or expired presigned URL
// shows a placeholder instead of a broken image.

function Thumb({ src, style }: { src: string; style?: CSSProperties }): JSX.Element {
  const [failed, setFailed] = useState(!src)
  useEffect(() => { setFailed(!src) }, [src])
  if (failed) {
    return (
      <div style={{ ...style, background: 'var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.6rem', color: 'var(--muted)' }}>
        🖼️
      </div>
    )
  }
  return <img src={src} alt="" loading="lazy" style={style} onError={() => setFailed(true)} />
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SkippedPage(): JSX.Element {
  const [items, setItems]       = useState<SkippedItem[]>([])
  const [count, setCount]       = useState(0)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [selected, setSelected] = useState<SkippedItem | null>(null)
  const [restoring, setRestoring] = useState<number[]>([])
  const [toast, setToast]       = useState<string | null>(null)
  const loadingRef = useRef(false)
  const itemsRef   = useRef<SkippedItem[]>([])
  itemsRef.current = items

  const flash = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2500)
  }, [])

  /** Loads the next page. `reset` starts again from the top (first load, ↻). */
  const load = useCallback(async (reset: boolean) => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    setError(null)
    try {
      // Restored items have left the list server-side, so the next page starts
      // at the number of items already held, not at a fixed page boundary.
      const offset = reset ? 0 : itemsRef.current.length
      const res = await fetch(`/api/skipped?offset=${offset}&limit=${PAGE_SIZE}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
        throw new Error(body.error ?? res.statusText)
      }
      const data = await res.json() as SkippedResponse
      setCount(data.count)
      setItems((prev) => {
        const base = reset ? [] : prev
        const seen = new Set(base.map((i) => i.id))
        return [...base, ...data.items.filter((i) => !seen.has(i.id))]
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(true) }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelected(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const restore = useCallback(async (item: SkippedItem) => {
    setRestoring((r) => [...r, item.id])
    try {
      const res = await fetch('/api/match/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wa_id: item.id, prev_id_hash: null }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
        throw new Error(body.error ?? res.statusText)
      }
      setItems((prev) => prev.filter((i) => i.id !== item.id))
      setCount((c) => Math.max(0, c - 1))
      setSelected((s) => (s?.id === item.id ? null : s))
      flash('Back in the queue')
    } catch (err) {
      flash(`Restore failed: ${err instanceof Error ? err.message : 'error'}`)
    } finally {
      setRestoring((r) => r.filter((id) => id !== item.id))
    }
  }, [flash])

  const btn: CSSProperties = {
    border: '1px solid var(--border)', borderRadius: 10, padding: '6px 12px',
    background: 'var(--surface)', color: 'var(--dim)', fontSize: '.85rem',
  }

  return (
    <>
      <header style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface)',
        position: 'sticky', top: 0, zIndex: 100,
      }}>
        <a href="/" style={{ ...btn, textDecoration: 'none' }} title="Back to matching">←</a>
        <div style={{ fontSize: '1.1rem', fontWeight: 700, flex: 1 }}>⏭️ Skipped</div>
        <span style={{ fontSize: '.8rem', color: 'var(--muted)' }}>{count} total</span>
        <button onClick={() => void load(true)} disabled={loading} style={btn} title="Reload">↻</button>
      </header>

      <main style={{ padding: '12px 14px', maxWidth: 960, margin: '0 auto' }}>
        {error && (
          <div style={{ textAlign: 'center', padding: '30px 20px' }}>
            <div style={{ color: 'var(--red)', marginBottom: 12 }}>{error}</div>
            <button onClick={() => void load(items.length === 0)} style={btn}>Try again</button>
          </div>
        )}

        {!error && !loading && items.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--muted)' }}>
            <div style={{ fontSize: '3rem', marginBottom: 8 }}>🎉</div>
            Nothing skipped.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
          {items.map((it) => (
            <div key={it.id} style={{
              position: 'relative', background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 10, overflow: 'hidden', opacity: restoring.includes(it.id) ? 0.5 : 1,
            }}>
              <button onClick={() => setSelected(it)} style={{
                display: 'block', width: '100%', padding: 0, border: 'none', background: 'none', color: 'inherit', textAlign: 'left',
              }}>
                <Thumb src={it.thumbnail_url} style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover' }} />
                <div style={{ padding: '4px 6px', fontSize: '.65rem', color: 'var(--dim)', display: 'flex', justifyContent: 'space-between' }}>
                  <span>{fmtDate(it.timestamp)}</span>
                  {isVideo(it) && <span>🎬 {fmtDuration(it.duration)}</span>}
                </div>
              </button>
            </div>
          ))}
        </div>

        {loading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', border: '3px solid var(--border)', borderTopColor: 'var(--accent)', animation: 'spin .7s linear infinite' }} />
          </div>
        )}

        {!loading && !error && items.length < count && (
          <div style={{ textAlign: 'center', padding: '16px 0 40px' }}>
            <button onClick={() => void load(false)} style={btn}>
              Load more ({items.length} of {count})
            </button>
          </div>
        )}
      </main>

      {/* Detail sheet */}
      {selected && (
        <div onClick={(e) => { if (e.target === e.currentTarget) setSelected(null) }} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', zIndex: 200,
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        }}>
          <div style={{
            background: 'var(--surface)', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 720,
            maxHeight: '92vh', overflowY: 'auto', animation: 'slide-up .3s ease',
          }}>
            {selected.filename.startsWith('Media') && (isImage(selected) || isVideo(selected)) ? (
              <WAMediaPreview
                filename={selected.filename}
                isImage={isImage(selected)}
                isVideo={isVideo(selected)}
              />
            ) : (
              <Thumb src={selected.thumbnail_url} style={{ width: '100%', maxHeight: '60vh', objectFit: 'contain', background: '#000' }} />
            )}
            <div style={{ padding: '14px 16px 24px' }}>
              <div style={{ fontSize: '.75rem', color: 'var(--dim)', marginBottom: 4, wordBreak: 'break-all' }}>
                {selected.filename}
              </div>
              <div style={{ fontSize: '.75rem', color: 'var(--muted)', marginBottom: 14 }}>
                #{selected.id}
                {selected.timestamp ? ` · ${new Date(selected.timestamp).toLocaleString()}` : ''}
                {isVideo(selected) && selected.duration != null ? ` · ${fmtDuration(selected.duration)}` : ''}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => void restore(selected)}
                  disabled={restoring.includes(selected.id)}
                  style={{ ...btn, flex: 1, background: 'var(--accent)', borderColor: 'var(--accent)', color: '#000', fontWeight: 700 }}
                >
                  ↩ Back to queue
                </button>
                <button onClick={() => setSelected(null)} style={btn}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 999,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
          padding: '10px 16px', fontSize: '.85rem', animation: 'toast-in .2s ease',
        }}>{toast}</div>
      )}
    </>
  )
}
