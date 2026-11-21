/**
 * src/app/api/skipped/route.ts
 *
 * Lists the wa items that were skipped: processed = true and no id_hash. That is
 * the state both /api/match/skip and a "no match" commit leave an item in, so
 * the two cannot be told apart.
 *
 * Query: ?offset=N (default 0) &limit=N (default 48, max 200)
 * Order: timestamp desc, id asc, the same as the unmatched queue.
 *
 * Each item carries a presigned e2 thumbnail URL (local HMAC, no I/O). Putting an
 * item back in the queue is done with POST /api/match/undo { wa_id, prev_id_hash: null }.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { thumbnailUrl } from '@/lib/thumbnails'
import { presignThumbnailUrl } from '@/lib/e2'
import type { SkippedItem, SkippedResponse } from '@/lib/types'

export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 48
const MAX_LIMIT = 200

function intParam(value: string | null, fallback: number): number {
  const n = Number(value)
  return value !== null && Number.isInteger(n) && n >= 0 ? n : fallback
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams
  const offset = intParam(params.get('offset'), 0)
  const limit  = Math.min(Math.max(intParam(params.get('limit'), DEFAULT_LIMIT), 1), MAX_LIMIT)

  try {
    const supabase = await createClient()

    const { data, count, error } = await supabase
      .from('wa')
      .select('id, filename, filetype, timestamp, duration', { count: 'exact' })
      .is('id_hash', null)
      .eq('processed', true)
      .order('timestamp', { ascending: false })
      .order('id',        { ascending: true  })
      .range(offset, offset + limit - 1)

    if (error) throw new Error(error.message)

    const rows = (data ?? []) as Omit<SkippedItem, 'thumbnail_url'>[]
    const items: SkippedItem[] = await Promise.all(
      rows.map(async (r) => ({
        ...r,
        thumbnail_url: (await presignThumbnailUrl(thumbnailUrl('wa', r.id))) ?? '',
      })),
    )

    return NextResponse.json(
      { count: count ?? 0, offset, items } as SkippedResponse,
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    console.error('[/api/skipped] error:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
