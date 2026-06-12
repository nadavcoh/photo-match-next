// ── Database row shapes ────────────────────────────────────────────────────────

export interface WARow {
  id: number
  filename: string | null
  filetype: string | null
  hash_bit: string | null           // 64-char '0'/'1' string from bit(64) column
  video_thumb_hash_bit: string | null
  timestamp: Date | null
}

export interface HashesRow {
  id: number
  filename: string | null
  camera_name: string | null
  location: string | null
  location_name: string | null
  timestamp: Date | null
  url: string | null
  size: string | null
  filesize: string | null
  origin: string | null
  duration: number | null
  hamming: number
  thumb_hamming: number | null
}

export interface PartnerRow {
  id: number
  filename: string | null
  timestamp: Date | null
  url: string | null
  size: string | null
  duration: number | null
  hamming: number
  thumb_hamming: number | null
}

// ── API response shapes ────────────────────────────────────────────────────────

export interface WAItem {
  id: number
  filename: string
  filetype: string
  hash_bit: string | null
  video_thumb_hash_bit: string | null
  timestamp: string | null
  thumbnail_url: string
  path: string | null   // subdirectory within Media/ (from Dynamic Folders sync)
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

// Client-side undo state (stored in React state, passed to /api/match/undo)
export interface UndoState {
  wa_id: number
  prev_id_hash: number | null
}
