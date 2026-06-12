import { NextRequest, NextResponse } from 'next/server'
import { withClient } from '@/lib/db'
import type { UndoRequest } from '@/lib/types'

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: UndoRequest
  try {
    body = (await request.json()) as UndoRequest
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { wa_id, prev_id_hash } = body

  if (!wa_id || typeof wa_id !== 'number') {
    return NextResponse.json({ error: 'wa_id (number) is required' }, { status: 400 })
  }

  try {
    await withClient(async (client) => {
      // Restore previous id_hash; also clear processed flag so the item reappears
      await client.query(
        'UPDATE wa SET id_hash = $1, processed = NULL WHERE id = $2',
        [prev_id_hash ?? null, wa_id]
      )
    })

    return NextResponse.json({ ok: true, undone_wa_id: wa_id, restored_id_hash: prev_id_hash })
  } catch (err) {
    console.error('[/api/match/undo] error:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
