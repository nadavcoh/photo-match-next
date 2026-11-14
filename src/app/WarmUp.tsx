'use client'

/**
 * Keeps the database connections behind the match searches warm: pings
 * /api/warm when the page loads, when it becomes visible again, and on a timer
 * while it is visible. Fire-and-forget; stops if the user is not signed in.
 *
 * A warm-up that runs next to a real match request competes with it for the
 * database, so it is skipped while any /api/match request is in flight
 * (src/lib/inflight.ts) and runs in the next gap instead.
 */

import { useEffect } from 'react'
import { matchInFlight, onMatchIdle } from '@/lib/inflight'

const INTERVAL_MS = 15_000
/** After the last request finishes, wait this long before warming; a new request usually follows right away. */
const IDLE_DELAY_MS = 400

export default function WarmUp() {
  useEffect(() => {
    let stopped = false
    let pending = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined

    const warm = async () => {
      if (stopped || document.visibilityState !== 'visible') return
      if (matchInFlight() > 0) { pending = true; return }
      pending = false
      try {
        const res = await fetch('/api/warm?n=1', { method: 'POST', cache: 'no-store' })
        if (res.status === 401) stopped = true
      } catch {
        // ignore: warming is best effort
      }
    }

    void warm()
    const id = setInterval(warm, INTERVAL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') void warm() }
    document.addEventListener('visibilitychange', onVisible)
    const offIdle = onMatchIdle(() => {
      if (!pending) return
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => void warm(), IDLE_DELAY_MS)
    })

    return () => {
      stopped = true
      clearInterval(id)
      clearTimeout(idleTimer)
      offIdle()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return null
}
