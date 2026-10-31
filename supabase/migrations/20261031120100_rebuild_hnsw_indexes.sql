-- =============================================================================
-- Rebuild all four HNSW indexes with m = 32, ef_construction = 200
--
-- Why
-- ───
-- Indexes built with pgvector's defaults (m = 16, ef_construction = 64) missed
-- real matches: on the old `hashes.hash_bit` index ~5.6% of synthetic test
-- queries (18 of 323) came back short at ef_search = 40. The same table
-- rebuilt with m = 32, ef_construction = 200 missed 1 query in 643 at
-- ef_search = 40, and 0 in 305 at ef_search = 400. (On real `wa` queries the
-- difference was smaller and only ef_search = 400 reached zero misses.) See
-- CLAUDE.md, "HNSW recall and search modes".
--
-- What it does
-- ────────────
-- For each of the four indexes below it builds a second index (name suffix
-- 2) with the new parameters, then drops the old one and renames the new one
-- into its place. Per index:
--   • table doesn't exist            → skipped (fresh DB / Supabase branch)
--   • already on the new parameters  → skipped, nothing is rebuilt
--   • a leftover <name>2 exists      → reused instead of rebuilt, then swapped in
--   hashes.hash_bit                 hashes_hash_bit_hnsw_idx
--   hashes.video_thumb_hash_bit     hashes_thumb_hash_bit_hnsw_idx
--   partner.hash_bit                partner_hash_bit_hnsw_idx
--   partner.video_thumb_hash_bit    partner_thumb_hash_bit_hnsw_idx
-- Also works on a database with no HNSW indexes yet: it just creates them.
--
-- ⚠ Production: this can take a long time and blocks writes
-- ───────────────────────────────────────────────────────────
-- An HNSW build on ~150k rows runs for minutes (longer than the SQL Editor's
-- timeout, which is why the first one was built by hand), and each build holds
-- a lock that blocks writes to its table. A migration runner has its own time
-- limits and runs the whole file in one go. So, for the production database:
--
--   1. Run this file once from psql over a direct/session connection (port
--      5432, NOT the transaction pooler on 6543), where you can watch it:
--        psql "<direct connection string>" -f \
--          supabase/migrations/20261031120100_rebuild_hnsw_indexes.sql
--      Progress, from a second connection:
--        SELECT phase, blocks_done, blocks_total
--        FROM pg_stat_progress_create_index;
--   2. Then let the GitHub integration apply it: every index is already on
--      the new parameters, so it is a no-op that just records the migration.
--
-- On preview branches (empty databases) it is instant.
--
-- Notes
-- ─────
--   • Parallel index builds are turned off per index: the parallel path needs
--     a large shared-memory segment (~250 MB for `hashes`) that small
--     Supabase instances don't have ("could not resize shared memory
--     segment … No space left on device").
--   • No CREATE INDEX CONCURRENTLY: it can't run inside a transaction, and
--     migration runners wrap files in one. This is a single-user app, so a
--     brief write lock is acceptable.
--   • Plain SQL only (no psql meta-commands), so it runs under the Supabase
--     CLI / GitHub integration as well as under psql.
-- =============================================================================

-- Session-level (not SET LOCAL) so it also takes effect if the runner doesn't
-- wrap statements in a transaction; reset at the end.
set statement_timeout = 0;

create function pg_temp.rebuild_hnsw_index(p_table text, p_column text, p_index text)
returns void
language plpgsql
as $$
declare
  v_new text := p_index || '2';
begin
  if to_regclass(format('public.%I', p_table)) is null then
    raise notice 'skip %: table public.% does not exist', p_index, p_table;
    return;
  end if;

  if exists (
    select 1 from pg_class c
    where c.oid = to_regclass(format('public.%I', p_index))
      and c.reloptions @> array['m=32', 'ef_construction=200']
  ) then
    raise notice 'skip %: already built with m=32, ef_construction=200', p_index;
    return;
  end if;

  -- Transaction-local settings for the build (see Notes above). pgvector's
  -- operator classes live in the `extensions` schema on Supabase.
  perform set_config('max_parallel_maintenance_workers', '0', true);
  perform set_config('maintenance_work_mem', '256MB', true);
  perform set_config('search_path', 'public, extensions', true);

  if to_regclass(format('public.%I', v_new)) is null then
    raise notice 'building %.% (this can take a while) …', p_table, p_column;
    execute format(
      'create index %I on public.%I using hnsw (%I bit_hamming_ops) with (m = 32, ef_construction = 200)',
      v_new, p_table, p_column);
  else
    raise notice 'reusing existing %', v_new;
  end if;

  execute format('drop index if exists public.%I', p_index);
  execute format('alter index public.%I rename to %I', v_new, p_index);
  raise notice 'swapped in %', p_index;
end
$$;

select pg_temp.rebuild_hnsw_index('hashes',  'hash_bit',             'hashes_hash_bit_hnsw_idx');
select pg_temp.rebuild_hnsw_index('hashes',  'video_thumb_hash_bit', 'hashes_thumb_hash_bit_hnsw_idx');
select pg_temp.rebuild_hnsw_index('partner', 'hash_bit',             'partner_hash_bit_hnsw_idx');
select pg_temp.rebuild_hnsw_index('partner', 'video_thumb_hash_bit', 'partner_thumb_hash_bit_hnsw_idx');

reset statement_timeout;
