/**
 * src/lib/types.ts
 *
 * Shared TypeScript types for the Photo Match application.
 *
 * DB row types (WARow, HashesRow, PartnerRow) have been removed. Those were
 * typed against the raw pg query results in db.ts, which has been deleted.
 * The Supabase client is now used directly in each route handler with
 * inline column selection; RPC return types are defined in the route files.
 */

// ── API response shapes ────────────────────────────────────────────────────────

export interface WAItem {
  id: number
  filename: string
  filetype: string
  hash_bit: string | null
  video_thumb_hash_bit: string | null
  timestamp: string | null
  duration: number | null
  /**
   * Supabase Storage object path (e.g. "wa/008000/wa_8402.jpg").
   * Pass to <SignedImage storagePath={...}> or to
   * supabase.storage.from(THUMBNAILS_BUCKET).createSignedUrl(path, ttl).
   */
  thumbnail_url: string
}

export interface HashCandidate {
  id: number
  filename: string
  camera_name: string | null
  location: string | null
  location_name: string | null
  timestamp: string | null
  url: string | null
  size: string | null
  filesize: string | null
  origin: string | null
  duration: number | null
  hamming: number
  thumb_hamming: number | null
  pixel_dist: number | null
  /** Supabase Storage object path — see WAItem.thumbnail_url. */
  thumbnail_url: string
  source: 'hashes'
}

export interface PartnerCandidate {
  id: number
  filename: string
  timestamp: string | null
  url: string | null
  size: string | null
  duration: number | null
  hamming: number
  thumb_hamming: number | null
  pixel_dist: number | null
  /** Supabase Storage object path — see WAItem.thumbnail_url. */
  thumbnail_url: string
  source: 'partner'
}

export type Candidate = HashCandidate | PartnerCandidate

export interface MatchResponse {
  count: number
  offset: number
  item: WAItem | null
  candidates: HashCandidate[]
  partner_candidates: PartnerCandidate[]
  auto_select_id: number | null
}

export interface CommitRequest {
  wa_id: number
  hash_id?: number | null
  rematch?: boolean
}

export interface CommitResponse {
  ok: boolean
  prev_id_hash: number | null
}

export interface UndoRequest {
  wa_id: number
  prev_id_hash: number | null
}

export interface UndoState {
  wa_id: number
  prev_id_hash: number | null
}
