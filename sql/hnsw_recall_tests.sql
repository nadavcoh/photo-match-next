-- =============================================================================
-- HNSW recall tests and diagnostics for the match_* RPC functions
--
-- WHY THIS EXISTS
-- ───────────────
-- The HNSW indexes behind 'fast' and 'wide' search are approximate. When one
-- misses a real match the app shows "no candidates" — indistinguishable from
-- "there really is none". The only way to know is to compare the approximate
-- modes against 'exact', which is what these tests do. See CLAUDE.md, "HNSW
-- recall and search modes".
--
-- WHEN TO RE-RUN (Part 1 at least)
-- ────────────────────────────────
--   • the data has grown by ~25–50% since the last run
--   • after a bulk import, especially one with many near-duplicates
--   • after rebuilding or changing an index, or upgrading pgvector
--   • after changing HAMMING_THRESHOLD (these tests use 10 — edit it below)
--   • whenever a match you know exists wasn't offered
--
-- HOW TO READ THE RESULTS
-- ───────────────────────
--   exact_matches   what a full scan finds — the ground truth
--   fast_/wide_matches  what each HNSW mode found (never more than exact)
--   fast_miss_q / wide_miss_q  queries where that mode found FEWER than exact
--   Aim for wide_miss_q = 0. fast_miss_q is expected to be small but not zero
--   (the "Search wider" button exists for those items).
--   If wide_miss_q is non-zero: raise the wide setting (400 → 800; the cap is
--   1000) in the functions, or make 'exact' the default.
--   Each run draws a fresh random sample — run a few times.
--
-- RUNNING
-- ───────
-- Works in the Supabase SQL Editor or psql. Each statement is independent.
-- Parts 1–2 are slow-ish (a few seconds per hundred queries); if the editor
-- times out, run them from psql.
-- =============================================================================


-- ─── PART 0: Sanity checks ───────────────────────────────────────────────────

-- 0a. Row counts, duplicate hashes, hash lengths (must all be 64).
SELECT
  count(*)                          AS total_rows,
  count(DISTINCT hash_bit)          AS distinct_hashes,
  min(length(hash_bit))             AS min_len,
  max(length(hash_bit))             AS max_len
FROM public.hashes;

-- 0b. HNSW indexes and their build parameters. Expect four, each with
--     WITH (m='32', ef_construction='200'), none named *_idx2.
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('hashes', 'partner')
  AND indexdef ILIKE '%hnsw%'
ORDER BY tablename, indexname;

-- 0c. pgvector version (iterative scans need >= 0.8.0; the app does not use them).
SELECT extversion FROM pg_extension WHERE extname = 'vector';

-- 0d. The functions exist with the p_mode parameter (expect 4 rows).
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname LIKE 'match\_%'
ORDER BY p.proname;


-- ─── PART 1: Recall on REAL queries (the one that matters) ──────────────────
-- Samples 200 real items from `wa`, runs each through the actual functions in
-- all three modes, and compares counts. Edit the 10 (threshold) if you changed
-- HAMMING_THRESHOLD. Items with no hash are skipped.

-- 1a. Images vs hashes
WITH sample AS MATERIALIZED (
  SELECT id, hash_bit::text AS q
  FROM public.wa
  WHERE hash_bit IS NOT NULL
    AND COALESCE(lower(filetype), '') NOT IN ('video', 'video/mp4')
  ORDER BY random()
  LIMIT 200
)
SELECT count(*)                                  AS queries,
       count(*) FILTER (WHERE e.n > 0)           AS queries_with_matches,
       sum(e.n)                                  AS exact_matches,
       sum(w.n)                                  AS wide_matches,
       sum(f.n)                                  AS fast_matches,
       count(*) FILTER (WHERE w.n < e.n)         AS wide_miss_q,
       count(*) FILTER (WHERE f.n < e.n)         AS fast_miss_q
FROM sample s
CROSS JOIN LATERAL (SELECT count(*) AS n FROM public.match_hashes_image(s.q, 10, 'exact')) e
CROSS JOIN LATERAL (SELECT count(*) AS n FROM public.match_hashes_image(s.q, 10, 'wide'))  w
CROSS JOIN LATERAL (SELECT count(*) AS n FROM public.match_hashes_image(s.q, 10, 'fast'))  f;

-- 1b. Images vs partner
WITH sample AS MATERIALIZED (
  SELECT id, hash_bit::text AS q
  FROM public.wa
  WHERE hash_bit IS NOT NULL
    AND COALESCE(lower(filetype), '') NOT IN ('video', 'video/mp4')
  ORDER BY random()
  LIMIT 200
)
SELECT count(*)                                  AS queries,
       count(*) FILTER (WHERE e.n > 0)           AS queries_with_matches,
       sum(e.n)                                  AS exact_matches,
       sum(w.n)                                  AS wide_matches,
       sum(f.n)                                  AS fast_matches,
       count(*) FILTER (WHERE w.n < e.n)         AS wide_miss_q,
       count(*) FILTER (WHERE f.n < e.n)         AS fast_miss_q
FROM sample s
CROSS JOIN LATERAL (SELECT count(*) AS n FROM public.match_partner_image(s.q, 10, 'exact')) e
CROSS JOIN LATERAL (SELECT count(*) AS n FROM public.match_partner_image(s.q, 10, 'wide'))  w
CROSS JOIN LATERAL (SELECT count(*) AS n FROM public.match_partner_image(s.q, 10, 'fast'))  f;

-- 1c. Videos vs hashes. Note: in 'exact' mode the cap is the 50 closest rows
--     overall, while fast/wide cap at 50 per branch, so a fast/wide count can
--     legitimately exceed exact when there are more than 50 matches. Only
--     "found fewer than exact" (the *_miss_q columns) indicates a miss.
WITH sample AS MATERIALIZED (
  SELECT id, hash_bit::text AS qh, video_thumb_hash_bit::text AS qt
  FROM public.wa
  WHERE video_thumb_hash_bit IS NOT NULL
    AND COALESCE(lower(filetype), '') IN ('video', 'video/mp4')
  ORDER BY random()
  LIMIT 200
)
SELECT count(*)                                  AS queries,
       count(*) FILTER (WHERE e.n > 0)           AS queries_with_matches,
       sum(e.n)                                  AS exact_matches,
       sum(w.n)                                  AS wide_matches,
       sum(f.n)                                  AS fast_matches,
       count(*) FILTER (WHERE w.n < e.n)         AS wide_miss_q,
       count(*) FILTER (WHERE f.n < e.n)         AS fast_miss_q
FROM sample s
CROSS JOIN LATERAL (SELECT count(*) AS n FROM public.match_hashes_video(s.qh, s.qt, 10, 'exact')) e
CROSS JOIN LATERAL (SELECT count(*) AS n FROM public.match_hashes_video(s.qh, s.qt, 10, 'wide'))  w
CROSS JOIN LATERAL (SELECT count(*) AS n FROM public.match_hashes_video(s.qh, s.qt, 10, 'fast'))  f;

-- 1d. Videos vs partner
WITH sample AS MATERIALIZED (
  SELECT id, hash_bit::text AS qh, video_thumb_hash_bit::text AS qt
  FROM public.wa
  WHERE video_thumb_hash_bit IS NOT NULL
    AND COALESCE(lower(filetype), '') IN ('video', 'video/mp4')
  ORDER BY random()
  LIMIT 200
)
SELECT count(*)                                  AS queries,
       count(*) FILTER (WHERE e.n > 0)           AS queries_with_matches,
       sum(e.n)                                  AS exact_matches,
       sum(w.n)                                  AS wide_matches,
       sum(f.n)                                  AS fast_matches,
       count(*) FILTER (WHERE w.n < e.n)         AS wide_miss_q,
       count(*) FILTER (WHERE f.n < e.n)         AS fast_miss_q
FROM sample s
CROSS JOIN LATERAL (SELECT count(*) AS n FROM public.match_partner_video(s.qh, s.qt, 10, 'exact')) e
CROSS JOIN LATERAL (SELECT count(*) AS n FROM public.match_partner_video(s.qh, s.qt, 10, 'wide'))  w
CROSS JOIN LATERAL (SELECT count(*) AS n FROM public.match_partner_video(s.qh, s.qt, 10, 'fast'))  f;


-- ─── PART 2: Recall on SYNTHETIC queries (a control) ────────────────────────
-- Takes ~0.1% of the rows in `hashes`, flips roughly 8 random bits in each
-- hash, and checks whether the HNSW modes still find the original. This is
-- tougher than real data, which makes it a useful control: a test that never
-- tougher than real data, which makes it a useful control: a test that never
-- reports a miss at 'fast' can't tell you much about 'wide'. (A raw-SQL
-- version of this test reported misses in ~6% of queries at ef_search = 40 on
-- the old default-built index.)
WITH sample AS MATERIALIZED (
  SELECT id,
         (hash_bit # (
            ('x' || substr(md5(random()::text), 1, 16))::bit(64)
          & ('x' || substr(md5(random()::text), 1, 16))::bit(64)
          & ('x' || substr(md5(random()::text), 1, 16))::bit(64)
         ))::text AS q
  FROM public.hashes TABLESAMPLE BERNOULLI (0.1)
  WHERE hash_bit IS NOT NULL
)
SELECT count(*)                                  AS queries,
       sum(e.n)                                  AS exact_matches,
       sum(w.n)                                  AS wide_matches,
       sum(f.n)                                  AS fast_matches,
       count(*) FILTER (WHERE w.n < e.n)         AS wide_miss_q,
       count(*) FILTER (WHERE f.n < e.n)         AS fast_miss_q
FROM sample s
CROSS JOIN LATERAL (SELECT count(*) AS n FROM public.match_hashes_image(s.q, 10, 'exact')) e
CROSS JOIN LATERAL (SELECT count(*) AS n FROM public.match_hashes_image(s.q, 10, 'wide'))  w
CROSS JOIN LATERAL (SELECT count(*) AS n FROM public.match_hashes_image(s.q, 10, 'fast'))  f;


-- ─── PART 3: Latency ─────────────────────────────────────────────────────────
-- Run each twice and read the second (warm) result; a first call can be much
-- slower (the first partner exact run took 1.5 s vs ~15 ms afterwards; the
-- cause wasn't established).
-- Replace the hash with one from your data if you like. Typical warm numbers
-- from the investigation, `hashes` ≈ 153k rows: fast ~3 ms, wide ~21 ms
-- (outliers up to ~74 ms), exact ~35 ms; `partner` ≈ 86k rows: exact ~15 ms.

EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM public.match_hashes_image(
  '1111100000000011001011101110100001111100011110000100011011011001', 10, 'fast');

EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM public.match_hashes_image(
  '1111100000000011001011101110100001111100011110000100011011011001', 10, 'wide');

EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM public.match_hashes_image(
  '1111100000000011001011101110100001111100011110000100011011011001', 10, 'exact');

-- To see the plan INSIDE the function (HNSW Index Scan for fast/wide, Seq Scan
-- for exact), use auto_explain in psql:
--   LOAD 'auto_explain';
--   SET auto_explain.log_min_duration = 0;
--   SET auto_explain.log_nested_statements = on;
--   SET client_min_messages = log;
--   SELECT count(*) FROM public.match_hashes_image('<64-bit string>', 10, 'exact');


-- ─── PART 4: Behaviour checks ────────────────────────────────────────────────

-- 4a. An unknown mode is rejected (expect: ERROR unknown p_mode …).
SELECT count(*) FROM public.match_hashes_image(
  '1111100000000011001011101110100001111100011110000100011011011001', 10, 'turbo');

-- 4b. Omitting p_mode behaves as 'fast' (the app relies on this: it only sends
--     p_mode when the user escalates).
SELECT count(*) FROM public.match_hashes_image(
  '1111100000000011001011101110100001111100011110000100011011011001', 10);

-- 4c. hnsw.ef_search is transaction-local and set explicitly per call.
--     Expect the two SHOWs to print 400 and then 40. Use psql for this one:
--     the SQL Editor only displays the result of the last statement.
BEGIN;
SELECT count(*) FROM public.match_hashes_image('1111100000000011001011101110100001111100011110000100011011011001', 10, 'wide');
SHOW hnsw.ef_search;      -- 400
SELECT count(*) FROM public.match_hashes_image('1111100000000011001011101110100001111100011110000100011011011001', 10, 'fast');
SHOW hnsw.ef_search;      -- 40 again
ROLLBACK;


-- ─── NOTES from the investigation (no queries needed) ───────────────────────
-- • pgvector's iterative index scans (hnsw.iterative_scan) were tried and are
--   NOT used: strict_order still missed the matches; relaxed_order found them
--   but was no faster than the exact scan on this data.
-- • Rebuilding with m = 32, ef_construction = 200 helped far more on synthetic
--   queries than on real ones; raising ef_search to 400 is what removed the
--   remaining misses on real data.
-- • A related, untested weakness: the video functions' second candidate
--   branch filters "video_thumb_hash_bit IS NULL" AFTER an HNSW scan on
--   hash_bit, so a video row that happens to be nearest in hash_bit space
--   uses up one of the ef_search slots. 'exact' mode avoids this entirely.
