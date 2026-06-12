/**
 * src/app/api/match/skip/route.ts
 *
 * Marks a WA item as processed (skipped) without assigning a match.
 * The item is removed from the unmatched queue.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { wa_id: number }
  try {
    body = await request.json() as { wa_id: number }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { wa_id } = body

  if (typeof wa_id !== 'number') {
    return NextResponse.json({ error: 'wa_id is required' }, { status: 400 })
  }

  try {
    const supabase = await createClient()

    const { error } = await supabase
      .from('wa')
      .update({ processed: true })
      .eq('id', wa_id)

    if (error) throw new Error(error.message)

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[/api/match/skip] error:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
