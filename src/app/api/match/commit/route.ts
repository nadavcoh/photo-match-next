import { NextRequest, NextResponse } from 'next/server'
import { withClient } from '@/lib/db'
import type { CommitRequest, CommitResponse } from '@/lib/types'

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: CommitRequest
  try {
    body = (await request.json()) as CommitRequest
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { wa_id, hash_id, rematch = false } = body

  if (!wa_id || typeof wa_id !== 'number') {
    return NextResponse.json({ error: 'wa_id (number) is required' }, { status: 400 })
  }

  try {
    const prev_id_hash = await withClient(async (client) => {
      // Capture current value so the caller can pass it back for undo
      const { rows } = await client.query<{ id_hash: number | null }>(
        'SELECT id_hash FROM wa WHERE id = $1',
        [wa_id]
      )
      const prev = rows[0]?.id_hash ?? null

      if (rematch) {
        // Clear pre-filtered candidate list, return to normal matching
        await client.query('UPDATE wa SET id_hash = NULL, processed = NULL WHERE id = $1', [wa_id])
      } else {
        // hash_id = null → mark as no-match (processed, no id_hash)
        if (hash_id == null) {
          await client.query('UPDATE wa SET processed = TRUE WHERE id = $1', [wa_id])
        } else {
          await client.query('UPDATE wa SET id_hash = $1 WHERE id = $2', [hash_id, wa_id])
        }
      }

      return prev
    })

    const response: CommitResponse = { ok: true, prev_id_hash }
    return NextResponse.json(response)
  } catch (err) {
    console.error('[/api/match/commit] error:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
