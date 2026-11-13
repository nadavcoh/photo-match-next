/**
 * src/app/api/warm/route.ts
 *
 * Warms database connections for the match searches. A fresh connection is slow
 * on its first searches; supabase.rpc('warm_match_index') (see
 * supabase/migrations/20261113120000_warm_match_index.sql) runs a few searches
 * so the connection it lands on is fast for the next real request.
 *
 * Responds immediately (202) and runs the RPCs after the response, so nothing
 * waits for them. `?n=` (1-4, default 3) fires that many RPCs in parallel so
 * they land on different pooled connections.
 */

import { NextRequest, NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'
export const maxDuration = 20

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const n = Math.min(4, Math.max(1, parseInt(new URL(request.url).searchParams.get('n') ?? '3', 10) || 3))

  after(async () => {
    const t0 = performance.now()
    const results = await Promise.allSettled(
      Array.from({ length: n }, () => supabase.rpc('warm_match_index')),
    )
    const summary = results
      .map((r) =>
        r.status === 'rejected'
          ? 'rejected'
          : r.value.error
            ? `error:${r.value.error.message}`
            : JSON.stringify(r.value.data),
      )
      .join(' ')
    console.log(`[/api/warm] n=${n} ${Math.round(performance.now() - t0)} ms ${summary}`)
  })

  return NextResponse.json({ ok: true, n }, { status: 202, headers: { 'Cache-Control': 'no-store' } })
}
