/**
 * Long-term API statistics: one small row per /api/match and /api/warm request
 * in public.api_stats (see supabase/migrations/20261114120000_api_stats.sql).
 *
 * Always call from inside `after()` so recording never delays a response, and
 * never let a failure here affect the request: errors are only logged.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ApiStat {
  route: 'match' | 'warm'
  ok: boolean
  ms: number
  region: string | null
  // match only
  mode?: 'fast' | 'wide' | 'exact'
  is_video?: boolean
  hashes?: number
  partner?: number
  thumbs?: number
  count_ms?: number | null
  item_ms?: number | null
  rpc_ms?: number | null
  e2_ms?: number | null
  pixel_ms?: number | null
  sign_ms?: number | null
  // warm only
  warm_n?: number
  warm_samples?: number | null
}

export async function recordApiStat(supabase: SupabaseClient, stat: ApiStat): Promise<void> {
  try {
    const { error } = await supabase.from('api_stats').insert(stat)
    if (error) console.error('[stats] insert failed:', error.message)
  } catch (e) {
    console.error('[stats] insert threw:', e instanceof Error ? e.message : e)
  }
}

/**
 * Rolls finished days up into api_stats_daily and deletes raw rows past their
 * retention (compact_api_stats). Idempotent and cheap; called now and then.
 */
export async function compactApiStats(supabase: SupabaseClient): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('compact_api_stats')
    if (error) console.error('[stats] compact failed:', error.message)
    else console.log('[stats] compact', JSON.stringify(data))
  } catch (e) {
    console.error('[stats] compact threw:', e instanceof Error ? e.message : e)
  }
}
