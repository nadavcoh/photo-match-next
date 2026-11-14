/**
 * src/app/api/warm/route.ts
 *
 * Warms database connections for the match searches. A fresh connection is slow
 * on its first searches; supabase.rpc('warm_match_index') (see
 * supabase/migrations/20261113120000_warm_match_index.sql) runs a few searches
 * so the connection it lands on is fast for the next real request.
 *
 * Responds immediately (202) and runs the RPCs after the response, so nothing
 * waits for them. `?n=` (1-4, default 2) fires that many RPCs in parallel so
 * they land on different pooled connections.
 */

import { NextRequest, NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { compactApiStats, recordApiStat } from '@/lib/stats'

export const dynamic = 'force-dynamic'
export const maxDuration = 20

/**
 * Time budget handed to warm_match_index (4000 is also its own default). Tried 5500
 * on 2026-11-14: better median but a worse tail, and one warm-up ran 7.9 s, close to
 * the authenticated role's 8 s statement_timeout. The function only checks the
 * budget between searches, so it can overrun by one search; keep this well below 8 s.
 */
const WARM_BUDGET_MS = 4000

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const n = Math.min(4, Math.max(1, parseInt(new URL(request.url).searchParams.get('n') ?? '2', 10) || 2))

  after(async () => {
    const t0 = performance.now()
    const results = await Promise.allSettled(
      Array.from({ length: n }, () => supabase.rpc('warm_match_index', { p_budget_ms: WARM_BUDGET_MS })),
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
