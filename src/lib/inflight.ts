/**
 * Tracks the /api/match requests the page currently has in flight, so the
 * warm-up (src/app/WarmUp.tsx) can stay out of their way. A warm-up that runs
 * next to a real search competes for the same pooled database connections and
 * the 0.5 GB Nano compute, which slows the real search.
 *
 * Module-level state: one browser tab = one counter.
 */

let active = 0
const idleListeners = new Set<() => void>()

/** Number of /api/match requests currently in flight. */
export function matchInFlight(): number {
  return active
}

/** Runs `fn` and counts it as in flight until it settles. */
export async function trackMatchRequest<T>(fn: () => Promise<T>): Promise<T> {
  active++
  try {
    return await fn()
  } finally {
    active--
    if (active === 0) Array.from(idleListeners).forEach((listener) => listener())
  }
}

/** Calls `listener` every time the in-flight count drops to zero. Returns an unsubscribe function. */
export function onMatchIdle(listener: () => void): () => void {
  idleListeners.add(listener)
  return () => { idleListeners.delete(listener) }
}
