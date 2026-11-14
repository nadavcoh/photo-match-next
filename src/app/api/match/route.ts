/**
 * src/app/api/match/route.ts
 *
 * Returns the next unmatched WA item and its hash/partner candidates.
 *
 * Changes from the original:
 *  - Removed: pg Pool (db.ts), downloadThumbnailBytes (supabase.ts service role key)
 *  - DB queries: Supabase client via .from() for simple selects,
 *    .rpc() for the pgvector <~> similarity queries (see SQL script).
 *  - Thumbnails live in IDrive e2 (src/lib/e2.ts): bytes for the pixel
 *    distance are downloaded server-side by key, and every thumbnail_url in
 *    the response is replaced by a short-lived presigned e2 URL.
 */

import { NextRequest, NextResponse, after } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase-server'
import { thumbnailUrl } from '@/lib/thumbnails'
import { downloadThumbnailBytes, presignThumbnailUrl } from '@/lib/e2'
import { pixelDistance, pixelDistanceFallback } from '@/lib/pixelDistance'
import { recordApiStat } from '@/lib/stats'
import type { WAItem, HashCandidate, PartnerCandidate, MatchResponse, SearchMode } from '@/lib/types'

// ── Config ─────────────────────────────────────────────────────────────────────

function getThreshold(): number {
  return parseInt(process.env.HAMMING_THRESHOLD ?? '10', 10)
}

/** `?mode=` query parameter → SearchMode; anything unrecognised is 'fast'. */
function parseMode(v: string | null): SearchMode {
  return v === 'wide' || v === 'exact' ? v : 'fast'
}

/**
 * Adds p_mode to an RPC's arguments only when escalating. 'fast' is the SQL
 * default, so omitting it keeps the app working against a database that
 * hasn't had supabase/migrations/20261031120000_search_modes_for_match_functions.sql
 * applied yet.
 */
function withMode<T extends Record<string, unknown>>(args: T, mode: SearchMode): T & { p_mode?: SearchMode } {
  return mode === 'fast' ? args : { ...args, p_mode: mode }
}

/**
 * RPC errors used to be swallowed into an empty candidate list, which looks
 * exactly like "no matches". Always log them; when the user explicitly asked
 * for a wider/exact search, fail loudly so they aren't told "nothing found"
 * by a search that never ran.
 */
function rpcFailed(fn: string, message: string, mode: SearchMode): never[] {
  console.error(`[/api/match] ${fn} (${mode}) failed:`, message)
  if (mode !== 'fast') throw new Error(`${fn} failed in ${mode} mode: ${message}`)
  return []
}

function isVideoFiletype(filetype: string): boolean {
  const f = filetype.toLowerCase()
  return f === 'video' || f === 'video/mp4'
}

function isoOrNull(d: string | null | undefined): string | null {
  return d ?? null
}

// ── RPC row types ──────────────────────────────────────────────────────────────
// These mirror the RETURNS TABLE definitions in the SQL script.

interface TechnicalMetadataRpcRow {
  filesize_bytes: number | null
  jpeg_quality: number | null
  bit_depth: number | null
  pixel_format: string | null
  color_primaries: string | null
  color_space: string | null
  color_transfer: string | null
  color_range: string | null
}

interface HashesRpcRow extends TechnicalMetadataRpcRow {
  id: number
  filename: string | null
  camera_name: string | null
  location: string | null
  location_name: string | null
  ts: string | null          // timestamptz → ISO string
  url: string | null
  size: string | null
  origin: string | null
  duration: number | null
  hamming: number | null       // videohash2-to-videohash2 distance (video rows only); always set for image matching
  thumb_hamming: number | null // first-frame distance (thumb-to-thumb, or thumb-to-hash_bit for image/GIF candidates)
}

interface PartnerRpcRow extends TechnicalMetadataRpcRow {
  id: number
  filename: string | null
  ts: string | null
  url: string | null
  size: string | null
  duration: number | null
  hamming: number | null
  thumb_hamming: number | null
}

function technicalMetadataFrom(r: TechnicalMetadataRpcRow): TechnicalMetadataRpcRow {
  return {
    filesize_bytes: r.filesize_bytes,
    jpeg_quality: r.jpeg_quality,
    bit_depth: r.bit_depth,
    pixel_format: r.pixel_format,
    color_primaries: r.color_primaries,
    color_space: r.color_space,
    color_transfer: r.color_transfer,
    color_range: r.color_range,
  }
}

// ── Candidate fetchers ─────────────────────────────────────────────────────────

async function fetchHashesCandidates(
  supabase: SupabaseClient,
  waItem: WAItem,
  isVideo: boolean,
  threshold: number,
  mode: SearchMode,
): Promise<HashCandidate[]> {
  if (!isVideo) {
    if (!waItem.hash_bit) return []

    const { data, error } = await supabase.rpc('match_hashes_image', withMode({
      p_hash_bit: waItem.hash_bit,
      p_threshold: threshold,
    }, mode))
    if (error) return rpcFailed('match_hashes_image', error.message, mode)
    if (!data) return []

    return (data as HashesRpcRow[]).map((r) => ({
      id: r.id,
      filename: r.filename ?? '',
      camera_name: r.camera_name,
      location: r.location,
      location_name: r.location_name,
      timestamp: isoOrNull(r.ts),
      url: r.url,
      size: r.size,
      origin: r.origin,
      duration: r.duration,
      hamming: r.hamming,
      thumb_hamming: null,
      pixel_dist: null,
      thumbnail_url: thumbnailUrl('hashes', r.id),
      source: 'hashes' as const,
      ...technicalMetadataFrom(r),
    }))
  }

  // Video: hash_bit (videohash2) and video_thumb_hash_bit (first-frame
  // imagehash) are independent hash spaces and are compared to their own
  // counterpart column on the candidate row — never crossed. See
  // match_hashes_video in supabase-rls-and-rpc.sql for the exact rules,
  // including the GIF-as-image edge case.
  if (!waItem.hash_bit && !waItem.video_thumb_hash_bit) return []

  const { data, error } = await supabase.rpc('match_hashes_video', withMode({
    p_hash_bit: waItem.hash_bit,
    p_thumb_bit: waItem.video_thumb_hash_bit,
    p_threshold: threshold,
  }, mode))
  if (error) return rpcFailed('match_hashes_video', error.message, mode)
  if (!data) return []

  return (data as HashesRpcRow[]).map((r) => ({
    id: r.id,
    filename: r.filename ?? '',
    camera_name: r.camera_name,
    location: r.location,
    location_name: r.location_name,
    timestamp: isoOrNull(r.ts),
    url: r.url,
    size: r.size,
    origin: r.origin,
    duration: r.duration,
    hamming: r.hamming,
    thumb_hamming: r.thumb_hamming,
    pixel_dist: null,
    thumbnail_url: thumbnailUrl('hashes', r.id),
    source: 'hashes' as const,
    ...technicalMetadataFrom(r),
  }))
}

async function fetchPartnerCandidates(
  supabase: SupabaseClient,
  waItem: WAItem,
  isVideo: boolean,
  threshold: number,
  mode: SearchMode,
): Promise<PartnerCandidate[]> {
  if (!isVideo) {
    if (!waItem.hash_bit) return []

    const { data, error } = await supabase.rpc('match_partner_image', withMode({
      p_hash_bit: waItem.hash_bit,
      p_threshold: threshold,
    }, mode))
    if (error) return rpcFailed('match_partner_image', error.message, mode)
    if (!data) return []

    return (data as PartnerRpcRow[]).map((r) => ({
      id: r.id,
      filename: r.filename ?? '',
      timestamp: isoOrNull(r.ts),
      url: r.url,
      size: r.size,
      duration: r.duration,
      hamming: r.hamming,
      thumb_hamming: null,
      pixel_dist: null,
      thumbnail_url: thumbnailUrl('partner', r.id),
      source: 'partner' as const,
      ...technicalMetadataFrom(r),
    }))
  }

  if (!waItem.hash_bit && !waItem.video_thumb_hash_bit) return []

  const { data, error } = await supabase.rpc('match_partner_video', withMode({
    p_hash_bit: waItem.hash_bit,
    p_thumb_bit: waItem.video_thumb_hash_bit,
    p_threshold: threshold,
  }, mode))
  if (error) return rpcFailed('match_partner_video', error.message, mode)
  if (!data) return []

  return (data as PartnerRpcRow[]).map((r) => ({
    id: r.id,
    filename: r.filename ?? '',
    timestamp: isoOrNull(r.ts),
    url: r.url,
    size: r.size,
    duration: r.duration,
    hamming: r.hamming,
    thumb_hamming: r.thumb_hamming,
    pixel_dist: null,
    thumbnail_url: thumbnailUrl('partner', r.id),
    source: 'partner' as const,
    ...technicalMetadataFrom(r),
  }))
}

// ── Auto-select (pure logic — unchanged from original) ─────────────────────────

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000
}

function computeAutoSelect(
  candidates: HashCandidate[],
  waItem: WAItem,
  isVideo: boolean,
): number | null {
  const waTs = waItem.timestamp ? new Date(waItem.timestamp) : null

  function tsOf(c: HashCandidate): Date | null {
    return c.timestamp ? new Date(c.timestamp) : null
  }

  if (candidates.length === 2) {
    if (isVideo) {
      if (candidates[0].location && !candidates[1].location) return candidates[0].id
    } else {
      const h0ts = tsOf(candidates[0])
      if (
        candidates[0].camera_name && !candidates[1].camera_name &&
        waTs && h0ts && daysBetween(waTs, h0ts) < 60
      ) return candidates[0].id
    }
  } else if (candidates.length > 2) {
    if (!isVideo) {
      const withCamera = candidates.filter((c) => c.camera_name)
      if (waTs && withCamera.length > 0) {
        const recent = withCamera.filter((c) => {
          const ts = tsOf(c)
          return ts && daysBetween(waTs, ts) < 30
        })
        if (recent.length > 0) {
          const minH = Math.min(...recent.map((c) => c.hamming ?? 999))
          const best = recent.filter((c) => (c.hamming ?? 999) === minH)
          if (best.length === 1) return best[0].id
        }
      }
    } else {
      const withLoc = candidates.filter((c) => c.location)
      if (waTs && withLoc.length > 0) {
        const recent = withLoc.filter((c) => {
          const ts = tsOf(c)
          return ts && daysBetween(waTs, ts) < 30
        })
        if (recent.length > 0) {
          const minT = Math.min(...recent.map((c) => c.thumb_hamming ?? 999))
          const best = recent.filter((c) => (c.thumb_hamming ?? 999) === minT)
          if (best.length === 1) return best[0].id
        }
      }
    }
  }
  return null
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const offset    = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10))
  const mode      = parseMode(searchParams.get('mode'))
  const threshold = getThreshold()
  // Timing: one log line per request with per-phase milliseconds (see end of handler).
  const t0 = performance.now()
  const marks: Record<string, number> = {}
  let lastMark = t0
  const mark = (name: string) => { const n = performance.now(); marks[name] = Math.round(n - lastMark); lastMark = n }
  let statsClient: SupabaseClient | null = null // for the long-term stats row (src/lib/stats.ts)

  try {
    const supabase = await createClient()
    statsClient = supabase

    // ── Count unmatched items ──────────────────────────────────────────────
    const { count, error: countError } = await supabase
      .from('wa')
      .select('*', { count: 'exact', head: true })
      .is('id_hash', null)
      .is('processed', null)

    if (countError) throw new Error(countError.message)
    mark('count')

    const total = count ?? 0
    if (total === 0) {
      return NextResponse.json(
        { count: 0, offset, item: null, candidates: [], partner_candidates: [], auto_select_id: null, search_mode: mode } as MatchResponse,
        { headers: { 'Cache-Control': 'no-store' } }
      )
    }

    // ── Fetch item at offset ───────────────────────────────────────────────
    const { data: waRows, error: waError } = await supabase
      .from('wa')
      .select('id, filename, filetype, hash_bit, video_thumb_hash_bit, timestamp, duration')
      .is('id_hash', null)
      .is('processed', null)
      .order('timestamp', { ascending: false })
      .order('id',        { ascending: true  })
      .range(offset, offset)

    if (waError) throw new Error(waError.message)
    mark('item')
    if (!waRows?.length) {
      return NextResponse.json(
        { count: 0, offset, item: null, candidates: [], partner_candidates: [], auto_select_id: null, search_mode: mode } as MatchResponse,
        { headers: { 'Cache-Control': 'no-store' } }
      )
    }

    const waRow = waRows[0] as {
      id: number
      filename: string | null
      filetype: string | null
      hash_bit: string | null
      video_thumb_hash_bit: string | null
      timestamp: string | null
      duration: number | null
    }

    const waItem: WAItem = {
      id:                   waRow.id,
      filename:             waRow.filename             ?? '',
      filetype:             waRow.filetype             ?? '',
      hash_bit:             waRow.hash_bit,
      video_thumb_hash_bit: waRow.video_thumb_hash_bit,
      timestamp:            isoOrNull(waRow.timestamp),
      duration:             waRow.duration ?? null,
      thumbnail_url:        thumbnailUrl('wa', waRow.id),
    }

    const isVideo = isVideoFiletype(waItem.filetype)

    // ── Fetch candidates (hashes + partner) in parallel ────────────────────
    // `mode` picks the search depth (fast → wide → exact; see SearchMode).
    // Partner is optional, so its failures are swallowed — except when the
    // user explicitly escalated, where a silent empty result would be
    // misleading.
    const [candidates, partnerCandidates] = await Promise.all([
      fetchHashesCandidates(supabase, waItem, isVideo, threshold, mode),
      fetchPartnerCandidates(supabase, waItem, isVideo, threshold, mode).catch((e: unknown): PartnerCandidate[] => {
        if (mode !== 'fast') throw e
        return []
      }),
    ])

    // ── Download all thumbnails for pixel-distance computation ─────────────
    // Layout: [wa, ...hashes, ...partner]
    mark('rpc')
    const nHashes = candidates.length
    const allThumbs = await Promise.all([
      downloadThumbnailBytes(waItem.thumbnail_url),
      ...candidates.map((c) => downloadThumbnailBytes(c.thumbnail_url)),
      ...partnerCandidates.map((c) => downloadThumbnailBytes(c.thumbnail_url)),
    ])
    mark('e2_download')
    const waThumbnail  = allThumbs[0]
    const hashesThumbs = allThumbs.slice(1, 1 + nHashes)
    const partnerThumbs = allThumbs.slice(1 + nHashes)

    // ── Compute pixel distances (sharp, parallel) ──────────────────────────
    const [candidatesWithPx, partnerCandidatesWithPx] = await Promise.all([
      Promise.all(
        candidates.map(async (c, i) => ({
          ...c,
          pixel_dist: await pixelDistance(waThumbnail, hashesThumbs[i]),
        }))
      ),
      Promise.all(
        partnerCandidates.map(async (c, i) => ({
          ...c,
          pixel_dist: await pixelDistance(waThumbnail, partnerThumbs[i]),
        }))
      ),
    ])

    // ── Auto-select: primary logic, then pixel-distance fallback ───────────
    const auto_select_id =
      computeAutoSelect(candidatesWithPx, waItem, isVideo) ??
      pixelDistanceFallback(candidatesWithPx)

    // ── Swap thumbnail keys for presigned e2 URLs (local HMAC, no I/O) ──────
    mark('pixel_select')
    const signUrl = async (key: string): Promise<string> => (await presignThumbnailUrl(key)) ?? ''
    const [signedItem, signedCandidates, signedPartner] = await Promise.all([
      signUrl(waItem.thumbnail_url).then((u) => ({ ...waItem, thumbnail_url: u })),
      Promise.all(candidatesWithPx.map(async (c) => ({ ...c, thumbnail_url: await signUrl(c.thumbnail_url) }))),
      Promise.all(partnerCandidatesWithPx.map(async (c) => ({ ...c, thumbnail_url: await signUrl(c.thumbnail_url) }))),
    ])

    mark('sign')
    console.log(
      `[/api/match] ${Math.round(performance.now() - t0)} ms region=${process.env.VERCEL_REGION ?? '?'} mode=${mode} offset=${offset} video=${isVideo} ` +
      `hashes=${candidates.length} partner=${partnerCandidates.length} thumbs=${allThumbs.length} ` +
      Object.entries(marks).map(([k, v]) => `${k}=${v}`).join(' '),
    )
    after(() => recordApiStat(supabase, {
      route: 'match', ok: true, ms: Math.round(performance.now() - t0),
      region: process.env.VERCEL_REGION ?? null, mode, is_video: isVideo,
      hashes: candidates.length, partner: partnerCandidates.length, thumbs: allThumbs.length,
      count_ms: marks.count ?? null, item_ms: marks.item ?? null, rpc_ms: marks.rpc ?? null,
      e2_ms: marks.e2_download ?? null, pixel_ms: marks.pixel_select ?? null, sign_ms: marks.sign ?? null,
    }))
    return NextResponse.json(
      {
        count: total,
        offset,
        item: signedItem,
        candidates: signedCandidates,
        partner_candidates: signedPartner,
        auto_select_id,
        search_mode: mode,
      } as MatchResponse,
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (err) {
    console.error('[/api/match] error:', err)
    const failedClient = statsClient
    if (failedClient) {
      after(() => recordApiStat(failedClient, {
        route: 'match', ok: false, ms: Math.round(performance.now() - t0),
        region: process.env.VERCEL_REGION ?? null, mode,
      }))
    }
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
