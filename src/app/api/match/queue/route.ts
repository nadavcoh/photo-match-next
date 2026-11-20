/**
 * src/app/api/match/queue/route.ts
 *
 * Returns the ids of every unmatched wa item, in the same order /api/match uses
 * for `?offset=` (timestamp desc, id asc). The page keeps this list and looks
 * items up by id (`/api/match?id=`), so committing or skipping an item never
 * shifts anything it has already fetched.
 *
 * About 3,600 ids is roughly 30 KB. PostgREST returns at most 1,000 rows per
 * request (the project's max-rows default), so the list is read in chunks.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import type { QueueResponse } from '@/lib/types'

export const dynamic = 'force-dynamic'

const CHUNK = 1000
/** Safety stop: 100 chunks = 100,000 ids. */
const MAX_CHUNKS = 100

export async function GET(): Promise<NextResponse> {
  try {
    const supabase = await createClient()
    const ids: number[] = []
    const seen = new Set<number>()

    for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
      const from = chunk * CHUNK
      const { data, error } = await supabase
        .from('wa')
        .select('id')
        .is('id_hash', null)
        .is('processed', null)
        .order('timestamp', { ascending: false })
        .order('id',        { ascending: true  })
        .range(from, from + CHUNK - 1)

      if (error) throw new Error(error.message)
      const rows = (data ?? []) as { id: number }[]
      for (const r of rows) {
        // A row that changed between two chunks can show up twice.
        if (!seen.has(r.id)) { seen.add(r.id); ids.push(r.id) }
      }
      if (rows.length < CHUNK) break
    }

    return NextResponse.json(
      { count: ids.length, ids } as QueueResponse,
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    console.error('[/api/match/queue] error:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
