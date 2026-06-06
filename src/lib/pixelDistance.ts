import sharp from 'sharp'

/**
 * Mean Absolute Error between two thumbnail images, scaled 0–100.
 * Both buffers are resized to `size`×`size` greyscale before comparison.
 * Lower = more similar. Returns null if either buffer is missing or unreadable.
 *
 * Port of pixel_distance() in photo-match-pwa/app.py:
 *   mae = sum(abs(a-b) for a,b in zip(pa,pb)) / len(pa)
 *   return round(mae / 255 * 100, 1)
 */
export async function pixelDistance(
  thumbA: Buffer | null | undefined,
  thumbB: Buffer | null | undefined,
  size = 32,
): Promise<number | null> {
  if (!thumbA?.length || !thumbB?.length) return null
  try {
    const toGray = (buf: Buffer) =>
      sharp(buf).resize(size, size, { fit: 'fill' }).grayscale().raw().toBuffer()

    const [pa, pb] = await Promise.all([toGray(thumbA), toGray(thumbB)])
    const n = pa.length
    let sum = 0
    for (let i = 0; i < n; i++) sum += Math.abs(pa[i] - pb[i])
    return Math.round((sum / n / 255) * 1000) / 10 // 0–100, one decimal
  } catch {
    return null
  }
}

/**
 * Pixel-distance fallback auto-select.
 *
 * If primary auto-select logic found nothing, pick the hashes candidate with
 * the lowest pixel_dist — but only when it is meaningfully better than all
 * others (>2 units lower on the 0–100 scale).
 *
 * Port of the fallback block in photo-match-pwa/app.py.
 */
export function pixelDistanceFallback(
  candidates: Array<{ id: number; pixel_dist: number | null }>,
): number | null {
  type Scored = { id: number; pixel_dist: number }
  const scored = candidates.filter((c): c is Scored => c.pixel_dist != null)
  if (!scored.length) return null

  const best = scored.reduce((a, b) => (a.pixel_dist < b.pixel_dist ? a : b))
  const others = scored.filter((c) => c.id !== best.id)

  if (
    !others.length ||
    best.pixel_dist < Math.min(...others.map((c) => c.pixel_dist)) - 2
  ) {
    return best.id
  }
  return null
}
