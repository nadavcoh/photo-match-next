import { NextRequest, NextResponse } from 'next/server'
import { PoolClient } from 'pg'
import { withClient } from '@/lib/db'
import { thumbnailUrl } from '@/lib/thumbnails'
import type {
  WAItem,
  HashCandidate,
  PartnerCandidate,
  MatchResponse,
  WARow,
} from '@/lib/types'

// ── Helpers ────────────────────────────────────────────────────────────────────

function getThreshold(): number {
  return parseInt(process.env.HAMMING_THRESHOLD ?? '10', 10)
}

function isVideoFiletype(filetype: string): boolean {
  const f = filetype.toLowerCase()
  return f === 'video' || f === 'video/mp4'
}

function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null
}

// ── Hashes candidates ──────────────────────────────────────────────────────────

const HASHES_COLS = `
  id, filename, camera_name, location, location_name,
  timestamp, url, size, filesize, origin, duration
`

interface HashesBaseRow {
  id: number; filename: string | null; camera_name: string | null
  location: string | null; location_name: string | null; timestamp: Date | null
  url: string | null; size: string | null; filesize: string | null
  origin: string | null; duration: number | null
}

interface HashesImageRow extends HashesBaseRow { hamming: number }
interface HashesVideoRow extends HashesBaseRow { thumb_hamming: number; hash_hamming: number }

async function fetchHashesCandidates(
  client: PoolClient, waItem: WAItem, isVideo: boolean, threshold: number
): Promise<HashCandidate[]> {
  if (!isVideo) {
    if (!waItem.hash_bit) return []
    const { rows } = await client.query<HashesImageRow>(
      `SELECT ${HASHES_COLS}, (hash_bit <~> $1::bit(64))::int AS hamming
       FROM   hashes
       ORDER  BY hash_bit <~> $1::bit(64)
       LIMIT  50`,
      [waItem.hash_bit]
    )
    return rows
      .filter((r: HashesImageRow) => r.hamming <= threshold)
      .map((r: HashesImageRow): HashCandidate => ({
        id: r.id, filename: r.filename ?? '', camera_name: r.camera_name,
        location: r.location, location_name: r.location_name,
        timestamp: isoOrNull(r.timestamp), url: r.url, size: r.size,
        filesize: r.filesize, origin: r.origin, duration: r.duration,
        hamming: r.hamming, thumb_hamming: null,
        thumbnail_url: thumbnailUrl('hashes', r.id), source: 'hashes',
      }))
  }

  const searchBit = waItem.video_thumb_hash_bit ?? waItem.hash_bit
  if (!searchBit) return []

  const [byThumb, byHash] = await Promise.all([
    client.query<HashesVideoRow>(
      `SELECT ${HASHES_COLS},
              (video_thumb_hash_bit <~> $1::bit(64))::int AS thumb_hamming,
              (hash_bit             <~> $1::bit(64))::int AS hash_hamming
       FROM   hashes ORDER BY video_thumb_hash_bit <~> $1::bit(64) LIMIT 50`,
      [searchBit]
    ),
    client.query<HashesVideoRow>(
      `SELECT ${HASHES_COLS},
              (video_thumb_hash_bit <~> $1::bit(64))::int AS thumb_hamming,
              (hash_bit             <~> $1::bit(64))::int AS hash_hamming
       FROM   hashes ORDER BY hash_bit <~> $1::bit(64) LIMIT 50`,
      [searchBit]
    ),
  ])

  const merged = new Map<number, HashesVideoRow>()
  for (const row of [...byThumb.rows, ...byHash.rows]) {
    const ex = merged.get(row.id)
    merged.set(row.id, ex ? {
      ...ex,
      thumb_hamming: Math.min(ex.thumb_hamming, row.thumb_hamming),
      hash_hamming:  Math.min(ex.hash_hamming,  row.hash_hamming),
    } : row)
  }

  return Array.from(merged.values())
    .filter((r: HashesVideoRow) => r.thumb_hamming <= threshold || r.hash_hamming <= threshold)
    .map((r: HashesVideoRow): HashCandidate => ({
      id: r.id, filename: r.filename ?? '', camera_name: r.camera_name,
      location: r.location, location_name: r.location_name,
      timestamp: isoOrNull(r.timestamp), url: r.url, size: r.size,
      filesize: r.filesize, origin: r.origin, duration: r.duration,
      hamming: r.hash_hamming, thumb_hamming: r.thumb_hamming,
      thumbnail_url: thumbnailUrl('hashes', r.id), source: 'hashes',
    }))
}

// ── Partner candidates ─────────────────────────────────────────────────────────

const PARTNER_COLS = `id, filename, timestamp, url, size, duration`

interface PartnerBaseRow {
  id: number; filename: string | null; timestamp: Date | null
  url: string | null; size: string | null; duration: number | null
}
interface PartnerImageRow extends PartnerBaseRow { hamming: number }
interface PartnerVideoRow extends PartnerBaseRow { thumb_hamming: number; hash_hamming: number }

async function fetchPartnerCandidates(
  client: PoolClient, waItem: WAItem, isVideo: boolean, threshold: number
): Promise<PartnerCandidate[]> {
  if (!isVideo) {
    if (!waItem.hash_bit) return []
    const { rows } = await client.query<PartnerImageRow>(
      `SELECT ${PARTNER_COLS}, (hash_bit <~> $1::bit(64))::int AS hamming
       FROM   partner ORDER BY hash_bit <~> $1::bit(64) LIMIT 50`,
      [waItem.hash_bit]
    )
    return rows
      .filter((r: PartnerImageRow) => r.hamming <= threshold)
      .map((r: PartnerImageRow): PartnerCandidate => ({
        id: r.id, filename: r.filename ?? '', timestamp: isoOrNull(r.timestamp),
        url: r.url, size: r.size, duration: r.duration,
        hamming: r.hamming, thumb_hamming: null,
        thumbnail_url: thumbnailUrl('partner', r.id), source: 'partner',
      }))
  }

  const searchBit = waItem.video_thumb_hash_bit ?? waItem.hash_bit
  if (!searchBit) return []

  const [byThumb, byHash] = await Promise.all([
    client.query<PartnerVideoRow>(
      `SELECT ${PARTNER_COLS},
              (video_thumb_hash_bit <~> $1::bit(64))::int AS thumb_hamming,
              (hash_bit             <~> $1::bit(64))::int AS hash_hamming
       FROM   partner ORDER BY video_thumb_hash_bit <~> $1::bit(64) LIMIT 50`,
      [searchBit]
    ),
    client.query<PartnerVideoRow>(
      `SELECT ${PARTNER_COLS},
              (video_thumb_hash_bit <~> $1::bit(64))::int AS thumb_hamming,
              (hash_bit             <~> $1::bit(64))::int AS hash_hamming
       FROM   partner ORDER BY hash_bit <~> $1::bit(64) LIMIT 50`,
      [searchBit]
    ),
  ])

  const merged = new Map<number, PartnerVideoRow>()
  for (const row of [...byThumb.rows, ...byHash.rows]) {
    const ex = merged.get(row.id)
    merged.set(row.id, ex ? {
      ...ex,
      thumb_hamming: Math.min(ex.thumb_hamming, row.thumb_hamming),
      hash_hamming:  Math.min(ex.hash_hamming,  row.hash_hamming),
    } : row)
  }

  return Array.from(merged.values())
    .filter((r: PartnerVideoRow) => r.thumb_hamming <= threshold || r.hash_hamming <= threshold)
    .map((r: PartnerVideoRow): PartnerCandidate => ({
      id: r.id, filename: r.filename ?? '', timestamp: isoOrNull(r.timestamp),
      url: r.url, size: r.size, duration: r.duration,
      hamming: r.hash_hamming, thumb_hamming: r.thumb_hamming,
      thumbnail_url: thumbnailUrl('partner', r.id), source: 'partner',
    }))
}

// ── Auto-select ────────────────────────────────────────────────────────────────

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000
}

function computeAutoSelect(candidates: HashCandidate[], waItem: WAItem, isVideo: boolean): number | null {
  const waTs = waItem.timestamp ? new Date(waItem.timestamp) : null

  function tsOf(c: HashCandidate): Date | null {
    return c.timestamp ? new Date(c.timestamp) : null
  }

  if (candidates.length === 2) {
    if (isVideo) {
      if (candidates[0].location && !candidates[1].location) return candidates[0].id
    } else {
      const h0ts = tsOf(candidates[0])
      if (candidates[0].camera_name && !candidates[1].camera_name && waTs && h0ts && daysBetween(waTs, h0ts) < 60)
        return candidates[0].id
    }
  } else if (candidates.length > 2) {
    if (!isVideo) {
      const withCamera = candidates.filter((c: HashCandidate) => c.camera_name)
      if (waTs && withCamera.length > 0) {
        const recent = withCamera.filter((c: HashCandidate) => {
          const ts = tsOf(c); return ts && daysBetween(waTs, ts) < 30
        })
        if (recent.length > 0) {
          const minH = Math.min(...recent.map((c: HashCandidate) => c.hamming))
          const best = recent.filter((c: HashCandidate) => c.hamming === minH)
          if (best.length === 1) return best[0].id
        }
      }
    } else {
      const withLoc = candidates.filter((c: HashCandidate) => c.location)
      if (waTs && withLoc.length > 0) {
        const recent = withLoc.filter((c: HashCandidate) => {
          const ts = tsOf(c); return ts && daysBetween(waTs, ts) < 30
        })
        if (recent.length > 0) {
          const minT = Math.min(...recent.map((c: HashCandidate) => c.thumb_hamming ?? 999))
          const best = recent.filter((c: HashCandidate) => (c.thumb_hamming ?? 999) === minT)
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
  const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10))
  const threshold = getThreshold()

  try {
    const result = await withClient(async (client) => {
      const { rows: countRows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM wa WHERE id_hash IS NULL AND processed IS NULL`
      )
      const count: number = countRows[0]?.count ?? 0
      if (count === 0) {
        return { count: 0, offset, item: null, candidates: [], partner_candidates: [], auto_select_id: null } as MatchResponse
      }

      const { rows: waRows } = await client.query<WARow>(
        `SELECT id, filename, filetype, hash_bit, video_thumb_hash_bit, timestamp
         FROM   wa WHERE id_hash IS NULL AND processed IS NULL
         ORDER  BY timestamp DESC, id ASC LIMIT 1 OFFSET $1`,
        [offset]
      )

      const waRow = waRows[0]
      if (!waRow) {
        return { count: 0, offset, item: null, candidates: [], partner_candidates: [], auto_select_id: null } as MatchResponse
      }

      const waItem: WAItem = {
        id: waRow.id, filename: waRow.filename ?? '', filetype: waRow.filetype ?? '',
        hash_bit: waRow.hash_bit, video_thumb_hash_bit: waRow.video_thumb_hash_bit,
        timestamp: isoOrNull(waRow.timestamp), thumbnail_url: thumbnailUrl('wa', waRow.id),
      }

      const isVideo = isVideoFiletype(waItem.filetype)
      const [candidates, partnerCandidates] = await Promise.all([
        fetchHashesCandidates(client, waItem, isVideo, threshold),
        fetchPartnerCandidates(client, waItem, isVideo, threshold).catch((): PartnerCandidate[] => []),
      ])

      return {
        count, offset, item: waItem, candidates,
        partner_candidates: partnerCandidates,
        auto_select_id: computeAutoSelect(candidates, waItem, isVideo),
      } as MatchResponse
    })

    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[/api/match] error:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
