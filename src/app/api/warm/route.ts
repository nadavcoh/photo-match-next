/**
 * src/app/api/warm/route.ts
 *
 * Warms database connections for the match searches. A fresh connection is slow
 * on its first searches; supabase.rpc('warm_match_index') (see
 * supabase/migrations/20261113120000_warm_match_index.sql) runs a few searches
 * so the connection it lands on is fast for the next real request.
 *
 * Responds immediately (202) and runs the RPCs after the response, so nothing
 * waits for them. `?n=` (1-4, default 1) fires that many RPCs in parallel so
 * they land on different pooled connections.
 */

import { NextRequest, NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { compactApiStats, recordApiStat } from '@/lib/stats'

export const dynamic = 'force-dynamic'
export const maxDuration = 20

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const n = Math.min(4, Math.max(1, parseInt(new URL(request.url).searchParams.get('n') ?? '1', 10) || 1))

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
    const ms = Math.round(performance.now() - t0)
    console.log(`[/api/warm] n=${n} ${ms} ms ${summary}`)

    // Long-term stats: one row per warm-up (samples = searches the RPCs ran).
    let samples = 0
    let ok = true
    for (const r of results) {
      if (r.status === 'rejected' || r.value.error) { ok = false; continue }
      const s = (r.value.data as { samples?: number } | null)?.samples
      if (typeof s === 'number') samples += s
    }
    await recordApiStat(supabase, {
      route: 'warm', ok, ms, region: process.env.VERCEL_REGION ?? null, warm_n: n, warm_samples: samples,
    })
    // Roll finished days up / drop old raw rows: about once per 500 warm-ups.
    if (Math.random() < 1 / 500) await compactApiStats(supabase)
  })

  return NextResponse.json({ ok: true, n }, { status: 202, headers: { 'Cache-Control': 'no-store' } })
}
