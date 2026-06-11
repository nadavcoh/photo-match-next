/**
 * src/app/api/match/commit/route.ts
 *
 * Commits a match decision for one WA item:
 *   - hash_id provided  → set wa.id_hash = hash_id
 *   - hash_id null      → mark as processed (no match found)
 *   - rematch = true    → clear id_hash + processed (undo auto-commit)
 *
 * Returns the previous id_hash so the client can offer a one-step undo.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import type { CommitRequest, CommitResponse } from '@/lib/types'

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: CommitRequest
  try {
    body = await request.json() as CommitRequest
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { wa_id, hash_id = null, rematch = false } = body

  if (typeof wa_id !== 'number') {
    return NextResponse.json({ error: 'wa_id is required' }, { status: 400 })
  }

  try {
    const supabase = await createClient()

    // Read the current id_hash so the client can undo if needed
    const { data: prev, error: selectError } = await supabase
      .from('wa')
      .select('id_hash')
      .eq('id', wa_id)
      .single()

    if (selectError) {
      return NextResponse.json({ error: 'wa item not found' }, { status: 404 })
    }

    const prev_id_hash: number | null = (prev as { id_hash: number | null })?.id_hash ?? null

    // Apply the decision
    let updateError
    if (rematch) {
      // Clear both fields so the item re-enters the unmatched queue
      ;({ error: updateError } = await supabase
        .from('wa')
        .update({ id_hash: null, processed: null })
        .eq('id', wa_id))
    } else if (hash_id == null) {
      // No match available — mark processed so it leaves the queue
      ;({ error: updateError } = await supabase
        .from('wa')
        .update({ processed: true })
        .eq('id', wa_id))
    } else {
      // Happy path — record the matched hash id
      ;({ error: updateError } = await supabase
        .from('wa')
        .update({ id_hash: hash_id })
        .eq('id', wa_id))
    }

    if (updateError) throw new Error(updateError.message)

    return NextResponse.json({ ok: true, prev_id_hash } as CommitResponse)
  } catch (err) {
    console.error('[/api/match/commit] error:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
