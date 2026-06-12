import { NextRequest, NextResponse } from 'next/server'
import { withClient } from '@/lib/db'

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { wa_id?: number }
  try {
    body = (await request.json()) as { wa_id?: number }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { wa_id } = body
  if (!wa_id || typeof wa_id !== 'number') {
    return NextResponse.json({ error: 'wa_id (number) is required' }, { status: 400 })
  }

  try {
    await withClient(async (client) => {
      await client.query('UPDATE wa SET processed = TRUE WHERE id = $1', [wa_id])
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[/api/match/skip] error:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
