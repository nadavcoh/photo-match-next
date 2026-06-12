/**
 * src/app/api/match/undo/route.ts
 *
 * Reverts the last commit for a WA item.
 * Restores id_hash to its prior value (or null) and clears processed.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import type { UndoRequest } from '@/lib/types'

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: UndoRequest
  try {
    body = await request.json() as UndoRequest
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { wa_id, prev_id_hash = null } = body

  if (typeof wa_id !== 'number') {
    return NextResponse.json({ error: 'wa_id is required' }, { status: 400 })
  }

  try {
    const supabase = await createClient()

    // Restore the previous state: reset id_hash to whatever it was before the
    // commit (may be null) and clear processed so the item re-enters the queue.
    const { error } = await supabase
      .from('wa')
      .update({ id_hash: prev_id_hash ?? null, processed: null })
      .eq('id', wa_id)

    if (error) throw new Error(error.message)

    return NextResponse.json({
      ok: true,
      undone_wa_id: wa_id,
      restored_id_hash: prev_id_hash,
    })
  } catch (err) {
    console.error('[/api/match/undo] error:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
