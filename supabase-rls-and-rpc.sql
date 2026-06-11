-- =============================================================================
-- Photo Match — Row Level Security, Storage Policies & RPC Functions
-- Run this entire script once in the Supabase SQL Editor.
-- =============================================================================
--
-- What this script does
-- ──────────────────────
-- 1. Enables Row Level Security on the three application tables (wa, hashes,
--    partner) so that PostgREST enforces access control using the caller's JWT.
-- 2. Creates RLS policies granting full CRUD to any authenticated user.
--    (The auth.users trigger from the previous migration ensures only
--    Cohen.n@gmail.com can ever become an authenticated user, so "any
--    authenticated user" effectively means "only me".)
-- 3. Creates a storage.objects policy so the authenticated browser client can
--    generate signed URLs and the server-side client can download bytes for
--    pixel-distance computation — no service role key required.
-- 4. Creates four PostgreSQL RPC functions for the pgvector <~> similarity
--    queries, which the Supabase JS client calls via .rpc(). Using SECURITY
--    INVOKER ensures RLS on the underlying tables is still enforced.
-- 5. Grants EXECUTE on those functions to the authenticated role.
-- =============================================================================


-- ─── PART 1: ENABLE ROW LEVEL SECURITY ──────────────────────────────────────

ALTER TABLE public.wa      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hashes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner ENABLE ROW LEVEL SECURITY;


-- ─── PART 2: RLS POLICIES ───────────────────────────────────────────────────
--
-- Each policy uses TO authenticated so the anon role (unauthenticated) can
-- never access any row. The middleware also enforces auth, so this is a
-- belt-and-suspenders guarantee at the database level.

-- wa: full CRUD (the app commits, skips, and undos rows)
DROP POLICY IF EXISTS "wa_authenticated_all" ON public.wa;
CREATE POLICY "wa_authenticated_all" ON public.wa
  FOR ALL
  TO authenticated
  USING     (true)
  WITH CHECK (true);

-- hashes: read-only (the app only queries candidates; it never writes here)
DROP POLICY IF EXISTS "hashes_authenticated_select" ON public.hashes;
CREATE POLICY "hashes_authenticated_select" ON public.hashes
  FOR SELECT
  TO authenticated
  USING (true);

-- partner: read-only (same reasoning as hashes)
DROP POLICY IF EXISTS "partner_authenticated_select" ON public.partner;
CREATE POLICY "partner_authenticated_select" ON public.partner
  FOR SELECT
  TO authenticated
  USING (true);


-- ─── PART 3: STORAGE POLICY ─────────────────────────────────────────────────
--
-- Allows authenticated users to:
--   • Download objects (server-side pixel-distance computation in /api/match)
--   • Generate signed URLs (browser-side SignedImage component)
--
-- Both operations only require SELECT access on storage.objects.
-- No INSERT/UPDATE/DELETE policy is added — the app never writes to storage
-- via the frontend; thumbnails are populated by the external scraping pipeline.

DROP POLICY IF EXISTS "thumbnails_authenticated_read" ON storage.objects;
CREATE POLICY "thumbnails_authenticated_read" ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'thumbnails');


-- ─── PART 4: RPC FUNCTIONS ──────────────────────────────────────────────────
--
-- The Supabase JS query builder (.from().select()) does not support custom
-- PostgreSQL operators such as the pgvector Hamming-distance operator <~>.
-- These four SQL functions wrap the similarity queries so the app can call
-- them via supabase.rpc('function_name', { params }).
--
-- SECURITY INVOKER  — runs with the caller's role, so table-level RLS applies.
-- SET search_path   — pins to public to prevent search-path-hijacking.
-- STABLE            — tells the planner the function does not modify the DB.
--
-- Column naming: the alias `ts` is used for timestamp columns to avoid the
-- SQL reserved word. The TypeScript route maps `ts` → `timestamp` in the
-- response object.

-- 4a. Image matching — hashes table ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.match_hashes_image(
  p_hash_bit  text,
  p_threshold integer
)
RETURNS TABLE (
  id            integer,
  filename      text,
  camera_name   text,
  location      text,
  location_name text,
  ts            timestamptz,
  url           text,
  size          text,
  filesize      text,
  origin        text,
  duration      integer,
  hamming       integer,
  thumb_hamming integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  SELECT
    id,
    filename,
    camera_name,
    location,
    location_name,
    timestamp                                        AS ts,
    url,
    size,
    filesize,
    origin,
    duration,
    (hash_bit <~> p_hash_bit::bit(64))::integer      AS hamming,
    NULL::integer                                    AS thumb_hamming
  FROM public.hashes
  WHERE (hash_bit <~> p_hash_bit::bit(64))::integer <= p_threshold
  ORDER BY hash_bit <~> p_hash_bit::bit(64)
  LIMIT 50;
$$;


-- 4b. Video matching — hashes table ─────────────────────────────────────────
--
-- Mirrors the original TypeScript logic:
--   1. Take top-50 by video_thumb_hash_bit distance.
--   2. Take top-50 by hash_bit distance.
--   3. Union their IDs (DISTINCT).
--   4. For each candidate compute BOTH distances.
--   5. Keep rows where EITHER distance <= threshold.

CREATE OR REPLACE FUNCTION public.match_hashes_video(
  p_search_bit text,
  p_threshold  integer
)
RETURNS TABLE (
  id            integer,
  filename      text,
  camera_name   text,
  location      text,
  location_name text,
  ts            timestamptz,
  url           text,
  size          text,
  filesize      text,
  origin        text,
  duration      integer,
  hamming       integer,      -- hash_bit distance
  thumb_hamming integer       -- video_thumb_hash_bit distance
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  WITH candidate_ids AS (
    SELECT DISTINCT id FROM (
      (SELECT id FROM public.hashes
       ORDER BY video_thumb_hash_bit <~> p_search_bit::bit(64)
       LIMIT 50)
      UNION ALL
      (SELECT id FROM public.hashes
       ORDER BY hash_bit <~> p_search_bit::bit(64)
       LIMIT 50)
    ) combined
  )
  SELECT
    h.id,
    h.filename,
    h.camera_name,
    h.location,
    h.location_name,
    h.timestamp                                              AS ts,
    h.url,
    h.size,
    h.filesize,
    h.origin,
    h.duration,
    (h.hash_bit             <~> p_search_bit::bit(64))::integer AS hamming,
    (h.video_thumb_hash_bit <~> p_search_bit::bit(64))::integer AS thumb_hamming
  FROM public.hashes h
  JOIN candidate_ids c ON h.id = c.id
  WHERE
       (h.hash_bit             <~> p_search_bit::bit(64))::integer <= p_threshold
    OR (h.video_thumb_hash_bit <~> p_search_bit::bit(64))::integer <= p_threshold;
$$;


-- 4c. Image matching — partner table ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.match_partner_image(
  p_hash_bit  text,
  p_threshold integer
)
RETURNS TABLE (
  id            integer,
  filename      text,
  ts            timestamptz,
  url           text,
  size          text,
  duration      integer,
  hamming       integer,
  thumb_hamming integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  SELECT
    id,
    filename,
    timestamp                                        AS ts,
    url,
    size,
    duration,
    (hash_bit <~> p_hash_bit::bit(64))::integer      AS hamming,
    NULL::integer                                    AS thumb_hamming
  FROM public.partner
  WHERE (hash_bit <~> p_hash_bit::bit(64))::integer <= p_threshold
  ORDER BY hash_bit <~> p_hash_bit::bit(64)
  LIMIT 50;
$$;


-- 4d. Video matching — partner table ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.match_partner_video(
  p_search_bit text,
  p_threshold  integer
)
RETURNS TABLE (
  id            integer,
  filename      text,
  ts            timestamptz,
  url           text,
  size          text,
  duration      integer,
  hamming       integer,
  thumb_hamming integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  WITH candidate_ids AS (
    SELECT DISTINCT id FROM (
      (SELECT id FROM public.partner
       ORDER BY video_thumb_hash_bit <~> p_search_bit::bit(64)
       LIMIT 50)
      UNION ALL
      (SELECT id FROM public.partner
       ORDER BY hash_bit <~> p_search_bit::bit(64)
       LIMIT 50)
    ) combined
  )
  SELECT
    p.id,
    p.filename,
    p.timestamp                                              AS ts,
    p.url,
    p.size,
    p.duration,
    (p.hash_bit             <~> p_search_bit::bit(64))::integer AS hamming,
    (p.video_thumb_hash_bit <~> p_search_bit::bit(64))::integer AS thumb_hamming
  FROM public.partner p
  JOIN candidate_ids c ON p.id = c.id
  WHERE
       (p.hash_bit             <~> p_search_bit::bit(64))::integer <= p_threshold
    OR (p.video_thumb_hash_bit <~> p_search_bit::bit(64))::integer <= p_threshold;
$$;


-- ─── PART 5: GRANT EXECUTE ───────────────────────────────────────────────────
--
-- PostgREST calls RPC functions under the authenticated role. Without an
-- explicit GRANT the call will fail with "permission denied for function …".

GRANT EXECUTE ON FUNCTION public.match_hashes_image(text, integer)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_hashes_video(text, integer)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_partner_image(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_partner_video(text, integer) TO authenticated;


-- ─── Verification queries (run separately to check) ──────────────────────────
--
-- Check RLS is enabled:
--   SELECT tablename, rowsecurity
--   FROM pg_tables
--   WHERE schemaname = 'public' AND tablename IN ('wa','hashes','partner');
--
-- Check policies:
--   SELECT tablename, policyname, cmd, roles
--   FROM pg_policies
--   WHERE schemaname = 'public';
--
-- Check storage policy:
--   SELECT policyname, cmd, roles
--   FROM pg_policies
--   WHERE schemaname = 'storage' AND tablename = 'objects';
--
-- Check RPC functions exist:
--   SELECT routine_name FROM information_schema.routines
--   WHERE routine_schema = 'public'
--     AND routine_name LIKE 'match_%';
