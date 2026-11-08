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
   * Short-lived presigned IDrive e2 URL for the thumbnail (object key e.g.
   * "wa/008000/wa_8402.jpg"), minted by /api/match. Pass to
   * <SignedImage src={...}>. Empty string if e2 isn't configured.
   */
  thumbnail_url: string
}

// Technical/codec metadata added to `hashes`/`partner` by
// migration_technical_metadata.sql (see frontend_changes.md). All NULL for
// rows inserted before that migration, and the four JPEG-only fields are
// NULL for any non-JPEG file. `jpeg_quant_tables` (raw per-row DQT arrays)
// isn't included — nothing in the UI needs the raw table, only the derived
// jpeg_quality estimate.
export interface TechnicalMetadata {
  /** File size in bytes — the only file-size field (the legacy `filesize`
   * text column was merged into it). Exact for files the scrapers downloaded
   * themselves; for older rows it was parsed from Google Photos' display text
   * (decimal units, display precision), so treat small differences as noise. */
  filesize_bytes: number | null
  /** Approximate JPEG quality (1-100), estimated from the quantization
   * table. JPEG only. */
  jpeg_quality: number | null
  /** Bits per sample — usually 8; 10/12/16 for HEIC/HDR-ish content. */
  bit_depth: number | null
  /** ffprobe's raw pix_fmt string, e.g. "yuvj420p", "yuv420p10le", "rgb24" —
   * encodes chroma subsampling. */
  pixel_format: string | null
  /** e.g. "bt709", "bt601", "bt2020". */
  color_primaries: string | null
  /** e.g. "bt709", "smpte170m". */
  color_space: string | null
  /** e.g. "bt709", "iec61966-2-1". */
  color_transfer: string | null
  /** "tv" (limited/16-235) or "pc" (full/0-255). */
  color_range: string | null
}

export interface HashCandidate extends TechnicalMetadata {
  id: number
  filename: string
  camera_name: string | null
  location: string | null
  location_name: string | null
  timestamp: string | null
  url: string | null
  size: string | null
  origin: string | null
  duration: number | null
  /** videohash2-to-videohash2 distance. Null when not comparable (image
   * matching always sets this; video matching sets it only when the
   * candidate is itself a video row — see match_hashes_video). */
  hamming: number | null
  /** First-frame distance: video_thumb_hash_bit-to-video_thumb_hash_bit for
   * video candidates, or wa's thumb hash vs. the candidate's plain hash_bit
   * for image-type candidates (covers GIFs transcoded to MP4 on the wa
   * side). Null for image-vs-image matching. */
  thumb_hamming: number | null
  pixel_dist: number | null
  /** Presigned e2 thumbnail URL — see WAItem.thumbnail_url. */
  thumbnail_url: string
  source: 'hashes'
}

export interface PartnerCandidate extends TechnicalMetadata {
  id: number
  filename: string
  timestamp: string | null
  url: string | null
  size: string | null
  duration: number | null
  hamming: number | null
  thumb_hamming: number | null
  pixel_dist: number | null
  /** Presigned e2 thumbnail URL — see WAItem.thumbnail_url. */
  thumbnail_url: string
  source: 'partner'
}

export type Candidate = HashCandidate | PartnerCandidate

/**
 * How candidates were searched. Maps to the `p_mode` argument of the
 * match_* RPC functions (see supabase-rls-and-rpc.sql, Part 4):
 *   fast  — approximate HNSW scan, hnsw.ef_search = 40 (default)
 *   wide  — approximate HNSW scan, hnsw.ef_search = 400
 *   exact — full scan, cannot miss a match
 * The UI starts every item on 'fast' and escalates on request.
 */
export type SearchMode = 'fast' | 'wide' | 'exact'

export interface MatchResponse {
  count: number
  offset: number
  item: WAItem | null
  candidates: HashCandidate[]
  partner_candidates: PartnerCandidate[]
  auto_select_id: number | null
  /** The mode these candidates came from. Omitted by older responses = 'fast'. */
  search_mode?: SearchMode
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
