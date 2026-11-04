-- =============================================================================
-- Normalize hashes/partner columns — STEP 5: rewrite the tables so the dropped
-- columns' space is actually returned to the OS.
--
-- VACUUM FULL cannot run inside a transaction block, so run this with plain
-- psql (NOT -1) on a direct connection:
--     psql "$DIRECT_URL" -f 3_vacuum_full.sql
-- It takes an exclusive lock on each table while it runs (seconds to a couple
-- of minutes at this size); the app and scrapers must be idle.
--
-- It also REBUILDS every index on the table. If you skipped step 0, that
-- includes the two big HNSW indexes — slow (see the PERFORMANCE note in
-- 1_backfill.sql). If you did step 0 they are absent, this is fast, and you
-- re-create them next (step 6 in README.md).
-- =============================================================================
set statement_timeout = 0;
set max_parallel_maintenance_workers = 0;
set maintenance_work_mem = '256MB';
vacuum (full, analyze, verbose) public.hashes;
vacuum (full, analyze, verbose) public.partner;
reset max_parallel_maintenance_workers;
reset maintenance_work_mem;
reset statement_timeout;
