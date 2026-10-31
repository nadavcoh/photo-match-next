-- =============================================================================
-- Migration: rebuild all four HNSW indexes with stronger build parameters
-- Date: 2026-10-31
--
-- RUN THIS FROM psql OVER A DIRECT / SESSION CONNECTION (port 5432), NOT THE
-- SUPABASE SQL EDITOR:
--
--   psql "postgresql://postgres@db.<project-ref>.supabase.co:5432/postgres" \
--        -f sql/migration_2026-10-31_hnsw_rebuild.sql
--
-- Why not the dashboard: an HNSW build runs for minutes. The editor's
-- statement timeout cancels it, a dropped browser connection loses it, and
-- the default parallel build tries to allocate a shared-memory segment
-- (~250 MB on `hashes`) that small Supabase instances don't have
-- ("could not resize shared memory segment … No space left on device").
-- The SETs below turn the parallel build off and lift the timeout.
-- Avoid the transaction-mode pooler (port 6543) for the same reason.
--
-- Why rebuild at all
-- ──────────────────
-- Indexes built with pgvector's defaults (m = 16, ef_construction = 64)
-- missed real matches: on the old `hashes.hash_bit` index, ~5.6% of synthetic
-- test queries (18 of 323) came back short at ef_search = 40. The same table
-- rebuilt with m = 32, ef_construction = 200 missed 1 query in 643 at
-- ef_search = 40, and 0 in 305 at ef_search = 400. (On real `wa` queries the
-- difference was smaller and only ef_search = 400 reached zero misses.) See CLAUDE.md, "HNSW recall and search modes".
--
-- What it does
-- ────────────
--   1. Builds a second index (name suffix _idx2) next to each existing one
--      that isn't already on the new parameters.
--      Reads keep working throughout; writes to the table are blocked while
--      its index builds (this is a single-user app).
--   2. Swaps each pair inside one transaction: drops the old index, renames
--      the new one to the old name.
--
-- Safe to re-run. Step 1 skips any index that already has m = 32 /
-- ef_construction = 200, and each swap only fires while its _idx2 still
-- exists — so a second run rebuilds nothing and can never drop an index
-- that has already been swapped in. (If a run is interrupted after a build
-- but before the swap, just run the script again: the existing _idx2 is
-- kept and swapped in.)
--
-- Indexes covered
-- ───────────────
--   hashes.hash_bit                 hashes_hash_bit_hnsw_idx
--   hashes.video_thumb_hash_bit     hashes_thumb_hash_bit_hnsw_idx
--   partner.hash_bit                partner_hash_bit_hnsw_idx
--   partner.video_thumb_hash_bit    partner_thumb_hash_bit_hnsw_idx
--
-- Run time: expect minutes per index, longer for `hashes.hash_bit` (~153k
-- rows) than the others (`partner` is ~86k rows, and the thumb columns only
-- index video rows); it depends on instance size. Watch progress from a
-- second connection:
--   SELECT phase, blocks_done, blocks_total FROM pg_stat_progress_create_index;
--
-- Afterwards: run sql/hnsw_recall_tests.sql (Part 1 and 2) to check recall,
-- and re-run it whenever the data changes meaningfully (see CLAUDE.md).
-- =============================================================================

\set ON_ERROR_STOP on

SET search_path = public, extensions;   -- pgvector's operator classes live in `extensions`
SET statement_timeout = 0;
SET max_parallel_maintenance_workers = 0;
SET maintenance_work_mem = '256MB';

-- ─── 1. Build ────────────────────────────────────────────────────────────────
-- Each statement below only produces a CREATE INDEX when (a) the live index
-- doesn't already have m = 32 / ef_construction = 200 and (b) no half-finished
-- _idx2 is lying around. \gexec runs whatever the SELECT returns, so an
-- up-to-date index returns zero rows and nothing is rebuilt.

\echo 'Step 1: building indexes that are not yet on the new parameters …'

SELECT 'CREATE INDEX hashes_hash_bit_hnsw_idx2 ON public.hashes USING hnsw (hash_bit bit_hamming_ops) WITH (m = 32, ef_construction = 200)'
WHERE to_regclass('public.hashes_hash_bit_hnsw_idx2') IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_class c
                  WHERE c.oid = to_regclass('public.hashes_hash_bit_hnsw_idx')
                    AND c.reloptions @> ARRAY['m=32', 'ef_construction=200'])
\gexec

SELECT 'CREATE INDEX hashes_thumb_hash_bit_hnsw_idx2 ON public.hashes USING hnsw (video_thumb_hash_bit bit_hamming_ops) WITH (m = 32, ef_construction = 200)'
WHERE to_regclass('public.hashes_thumb_hash_bit_hnsw_idx2') IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_class c
                  WHERE c.oid = to_regclass('public.hashes_thumb_hash_bit_hnsw_idx')
                    AND c.reloptions @> ARRAY['m=32', 'ef_construction=200'])
\gexec

SELECT 'CREATE INDEX partner_hash_bit_hnsw_idx2 ON public.partner USING hnsw (hash_bit bit_hamming_ops) WITH (m = 32, ef_construction = 200)'
WHERE to_regclass('public.partner_hash_bit_hnsw_idx2') IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_class c
                  WHERE c.oid = to_regclass('public.partner_hash_bit_hnsw_idx')
                    AND c.reloptions @> ARRAY['m=32', 'ef_construction=200'])
\gexec

SELECT 'CREATE INDEX partner_thumb_hash_bit_hnsw_idx2 ON public.partner USING hnsw (video_thumb_hash_bit bit_hamming_ops) WITH (m = 32, ef_construction = 200)'
WHERE to_regclass('public.partner_thumb_hash_bit_hnsw_idx2') IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_class c
                  WHERE c.oid = to_regclass('public.partner_thumb_hash_bit_hnsw_idx')
                    AND c.reloptions @> ARRAY['m=32', 'ef_construction=200'])
\gexec

-- ─── 2. Swap ─────────────────────────────────────────────────────────────────

\echo 'Swapping indexes in …'

DO $$
BEGIN
  IF to_regclass('public.hashes_hash_bit_hnsw_idx2') IS NOT NULL THEN
    DROP INDEX IF EXISTS public.hashes_hash_bit_hnsw_idx;
    ALTER INDEX public.hashes_hash_bit_hnsw_idx2 RENAME TO hashes_hash_bit_hnsw_idx;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.hashes_thumb_hash_bit_hnsw_idx2') IS NOT NULL THEN
    DROP INDEX IF EXISTS public.hashes_thumb_hash_bit_hnsw_idx;
    ALTER INDEX public.hashes_thumb_hash_bit_hnsw_idx2 RENAME TO hashes_thumb_hash_bit_hnsw_idx;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.partner_hash_bit_hnsw_idx2') IS NOT NULL THEN
    DROP INDEX IF EXISTS public.partner_hash_bit_hnsw_idx;
    ALTER INDEX public.partner_hash_bit_hnsw_idx2 RENAME TO partner_hash_bit_hnsw_idx;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.partner_thumb_hash_bit_hnsw_idx2') IS NOT NULL THEN
    DROP INDEX IF EXISTS public.partner_thumb_hash_bit_hnsw_idx;
    ALTER INDEX public.partner_thumb_hash_bit_hnsw_idx2 RENAME TO partner_thumb_hash_bit_hnsw_idx;
  END IF;
END $$;

-- ─── 3. Verify ───────────────────────────────────────────────────────────────
-- Expect exactly four rows, no *_idx2 names left, each WITH (m='32',
-- ef_construction='200').

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('hashes', 'partner')
  AND indexdef ILIKE '%hnsw%'
ORDER BY tablename, indexname;
