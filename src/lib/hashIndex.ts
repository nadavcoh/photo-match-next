/**
 * In-memory hash index: exact Hamming-distance search over the 64-bit hashes of
 * the `hashes` and `partner` tables, kept in the memory of the Vercel function.
 *
 * Why: on the Nano compute a fresh database connection is slow for its first
 * searches (see CLAUDE.md, "Warm-up and long-term statistics"). The tables are
 * small (about 240,000 rows, a few MB of hashes), so the scan runs here in about
 * a millisecond and only the display columns of the few matching rows are read
 * from the database (get_hashes_rows / get_partner_rows, primary-key lookups).
 *
 * The search is always EXACT: it returns what the 'exact' mode of the match_*
 * SQL functions returns (every row within the threshold, closest first, at most
 * 50), so the 'wide' and 'exact' escalations have nothing left to add.
 *
 * Loading, from supabase/migrations/20261114130000_hash_index_export.sql:
 *   export_hash_index(table, after_id, limit) -> fixed-width text, 40 characters
 *   per row: id (8 hex), hash (16 hex or '-' x 16), video-thumb hash (same).
 * New rows are fetched with after_id = highest id loaded (every DELTA_MS); the
 * whole index is rebuilt every FULL_RELOAD_MS to pick up deleted or changed rows
 * and ids committed out of order.
 *
 * No Next.js imports: this file is also run directly by the parity test.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const RECORD_LEN = 40
let chunkRows = 40_000
const DELTA_MS = 30_000
const FULL_RELOAD_MS = 30 * 60_000
const RETRY_AFTER_FAILURE_MS = 30_000
const MAX_RESULTS = 50

// ── Bit helpers ─────────────────────────────────────────────────────────────────

function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24
}

export interface Bits64 { hi: number; lo: number }

/** The app passes hashes as 64-character '0'/'1' strings (what Postgres casts to bit(64)). */
export function parseBits64(s: string | null | undefined): Bits64 | null {
  if (!s || !/^[01]{64}$/.test(s)) return null
  return { hi: parseInt(s.slice(0, 32), 2) >>> 0, lo: parseInt(s.slice(32), 2) >>> 0 }
}

function hamming(aHi: number, aLo: number, b: Bits64): number {
  return popcount32((aHi ^ b.hi) >>> 0) + popcount32((aLo ^ b.lo) >>> 0)
}

// ── Table ──────────────────────────────────────────────────────────────────────

const HAS_HASH = 1
const HAS_THUMB = 2

/** Columnar storage for one table: ids, hash and video-thumb hash as two uint32 each. */
export class HashTable {
  length = 0
  maxId = 0
  ids: Int32Array
  hi: Uint32Array
  lo: Uint32Array
  thumbHi: Uint32Array
  thumbLo: Uint32Array
  flags: Uint8Array

  constructor(capacity = 1024) {
    this.ids = new Int32Array(capacity)
    this.hi = new Uint32Array(capacity)
    this.lo = new Uint32Array(capacity)
    this.thumbHi = new Uint32Array(capacity)
    this.thumbLo = new Uint32Array(capacity)
    this.flags = new Uint8Array(capacity)
  }

  private ensureCapacity(extra: number): void {
    const need = this.length + extra
    if (need <= this.ids.length) return
    let cap = this.ids.length
    while (cap < need) cap *= 2
    const grow = <T extends Int32Array | Uint32Array | Uint8Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(cap)
      b.set(a.subarray(0, this.length))
      return b
    }
    this.ids = grow(this.ids)
    this.hi = grow(this.hi)
    this.lo = grow(this.lo)
    this.thumbHi = grow(this.thumbHi)
    this.thumbLo = grow(this.thumbLo)
    this.flags = grow(this.flags)
  }

  /** Appends `n` fixed-width records (see the header). Throws if the text is malformed. */
  append(data: string, n: number): void {
    if (data.length !== n * RECORD_LEN) {
      throw new Error(`hash index chunk: expected ${n * RECORD_LEN} characters for ${n} rows, got ${data.length}`)
    }
    this.ensureCapacity(n)
    for (let r = 0; r < n; r++) {
      const o = r * RECORD_LEN
      const id = parseInt(data.substr(o, 8), 16)
      if (!Number.isFinite(id)) throw new Error('hash index chunk: bad id')
      const i = this.length
      let flags = 0
      if (data.charCodeAt(o + 8) !== 45) { // not '-'
        this.hi[i] = parseInt(data.substr(o + 8, 8), 16) >>> 0
        this.lo[i] = parseInt(data.substr(o + 16, 8), 16) >>> 0
        flags |= HAS_HASH
      }
      if (data.charCodeAt(o + 24) !== 45) {
        this.thumbHi[i] = parseInt(data.substr(o + 24, 8), 16) >>> 0
        this.thumbLo[i] = parseInt(data.substr(o + 32, 8), 16) >>> 0
        flags |= HAS_THUMB
      }
      this.ids[i] = id
      this.flags[i] = flags
      this.length = i + 1
      if (id > this.maxId) this.maxId = id
    }
  }
}

// ── Search (mirrors the 'exact' branches of match_hashes_* / match_partner_*) ──

export interface ImageHit { id: number; hamming: number }
export interface VideoHit { id: number; hamming: number | null; thumb_hamming: number }

function byDistanceThenId(a: { d: number; id: number }, b: { d: number; id: number }): number {
  return a.d - b.d || a.id - b.id
}

/** match_*_image, exact: rows whose hash_bit is within `threshold` of `q`, closest first, then lowest id. */
export function searchImage(t: HashTable, q: Bits64, threshold: number, limit = MAX_RESULTS): ImageHit[] {
  const found: { d: number; id: number }[] = []
  const { length, hi, lo, flags, ids } = t
  for (let i = 0; i < length; i++) {
    if (!(flags[i] & HAS_HASH)) continue
    const d = hamming(hi[i], lo[i], q)
    if (d <= threshold) found.push({ d, id: ids[i] })
  }
  found.sort(byDistanceThenId)
  return found.slice(0, limit).map((f) => ({ id: f.id, hamming: f.d }))
}

/**
 * match_*_video, exact: every row is compared on COALESCE(video_thumb_hash_bit, hash_bit)
 * against the wa thumb hash; `hamming` (videohash2 distance, display only) exists only for
 * rows that have a video thumb hash and when the wa hash is known. No thumb hash, no result.
 */
export function searchVideo(
  t: HashTable,
  hash: Bits64 | null,
  thumb: Bits64 | null,
  threshold: number,
  limit = MAX_RESULTS,
): VideoHit[] {
  if (!thumb) return []
  const found: { d: number; id: number; i: number }[] = []
  const { length, hi, lo, thumbHi, thumbLo, flags, ids } = t
  for (let i = 0; i < length; i++) {
    const f = flags[i]
    let d: number
    if (f & HAS_THUMB) d = hamming(thumbHi[i], thumbLo[i], thumb)
    else if (f & HAS_HASH) d = hamming(hi[i], lo[i], thumb)
    else continue
    if (d <= threshold) found.push({ d, id: ids[i], i })
  }
  found.sort(byDistanceThenId)
  return found.slice(0, limit).map((f) => ({
    id: f.id,
    thumb_hamming: f.d,
    hamming: hash && (flags[f.i] & HAS_THUMB) && (flags[f.i] & HAS_HASH) ? hamming(hi[f.i], lo[f.i], hash) : null,
  }))
}

// ── Loading and upkeep ───────────────────────────────────────────────────────────

export type IndexTable = 'hashes' | 'partner'

interface IndexState {
  hashes: HashTable
  partner: HashTable
  loadedAt: number
  deltaAt: number
}

let state: IndexState | null = null
let busy: Promise<void> | null = null
let retryAt = 0

/** The loaded index, or null while it is not loaded (callers then use the database functions). */
export function getIndex(): { hashes: HashTable; partner: HashTable } | null {
  return state
}

/** Rows loaded per table, for logging. */
export function indexSize(): { hashes: number; partner: number } | null {
  return state ? { hashes: state.hashes.length, partner: state.partner.length } : null
}

async function fetchInto(supabase: SupabaseClient, name: IndexTable, table: HashTable): Promise<number> {
  let added = 0
  for (;;) {
    const { data, error } = await supabase.rpc('export_hash_index', {
      p_table: name,
      p_after_id: table.maxId,
      p_limit: chunkRows,
    })
    if (error) throw new Error(`export_hash_index(${name}): ${error.message}`)
    const row = (Array.isArray(data) ? data[0] : data) as { n: number; max_id: number; data: string } | null
    if (!row || typeof row.n !== 'number' || typeof row.data !== 'string') {
      throw new Error(`export_hash_index(${name}): unexpected response`)
    }
    if (row.n === 0) return added
    const before = table.length
    table.append(row.data, row.n)
    if (table.length !== before + row.n) throw new Error(`export_hash_index(${name}): row count mismatch`)
    added += row.n
    if (row.n < chunkRows) return added
  }
}

async function fullLoad(supabase: SupabaseClient): Promise<void> {
  const t0 = performance.now()
  const next: IndexState = { hashes: new HashTable(1 << 18), partner: new HashTable(1 << 17), loadedAt: 0, deltaAt: 0 }
  await Promise.all([fetchInto(supabase, 'hashes', next.hashes), fetchInto(supabase, 'partner', next.partner)])
  // An empty result is what a signed-out or non-owner session sees (RLS); never cache that.
  if (next.hashes.length === 0 && next.partner.length === 0) throw new Error('hash index: no rows visible')
  next.loadedAt = next.deltaAt = Date.now()
  state = next
  console.log(
    `[hash-index] loaded hashes=${next.hashes.length} partner=${next.partner.length} in ${Math.round(performance.now() - t0)} ms`,
  )
}

async function delta(supabase: SupabaseClient, s: IndexState): Promise<void> {
  const t0 = performance.now()
  const [a, b] = await Promise.all([fetchInto(supabase, 'hashes', s.hashes), fetchInto(supabase, 'partner', s.partner)])
  s.deltaAt = Date.now()
  if (a + b > 0) console.log(`[hash-index] +${a} hashes +${b} partner in ${Math.round(performance.now() - t0)} ms`)
}

/**
 * Loads the index if it is missing, appends new rows when the last update is older
 * than DELTA_MS, and rebuilds it when it is older than FULL_RELOAD_MS. One job runs
 * at a time; failures are logged and retried after RETRY_AFTER_FAILURE_MS. Never
 * throws. Call it from `after()` so no request waits for it.
 */
export function maintainIndex(supabase: SupabaseClient): Promise<void> {
  if (busy) return busy
  const now = Date.now()
  let job: Promise<void> | null = null
  if (!state) {
    if (now < retryAt) return Promise.resolve()
    job = fullLoad(supabase)
  } else if (now - state.loadedAt > FULL_RELOAD_MS) {
    job = fullLoad(supabase) // swaps `state` only when the new index is complete
  } else if (now - state.deltaAt > DELTA_MS) {
    job = delta(supabase, state)
  }
  if (!job) return Promise.resolve()
  busy = job
    .catch((e: unknown) => {
      retryAt = Date.now() + RETRY_AFTER_FAILURE_MS
      console.error('[hash-index] update failed:', e instanceof Error ? e.message : e)
    })
    .finally(() => { busy = null })
  return busy
}

/** Test helpers (used by scripts/hash_index_parity). */
export function setChunkRowsForTests(n: number): void {
  chunkRows = n
}
export function resetIndexForTests(): void {
  state = null
  busy = null
  retryAt = 0
}
export function expireDeltaForTests(): void {
  if (state) state.deltaAt = 0
}

/** Test helper: install an index built elsewhere. */
export function setIndexForTests(hashes: HashTable, partner: HashTable): void {
  state = { hashes, partner, loadedAt: Date.now(), deltaAt: Date.now() }
}
