'use client'

/**
 * Keeps the database connections behind the match searches warm: pings
 * /api/warm when the page loads, when it becomes visible again, and every 25 s
 * while it is visible. Fire-and-forget; stops if the user is not signed in.
 */

import { useEffect } from 'react'

const INTERVAL_MS = 25_000

export default function WarmUp() {
  useEffect(() => {
    let stopped = false

    const warm = async () => {
      if (stopped || document.visibilityState !== 'visible') return
      try {
        const res = await fetch('/api/warm?n=3', { method: 'POST', cache: 'no-store' })
        if (res.status === 401) stopped = true
      } catch {
        // ignore: warming is best effort
      }
    }

    void warm()
    const id = setInterval(warm, INTERVAL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') void warm() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      stopped = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return null
}
