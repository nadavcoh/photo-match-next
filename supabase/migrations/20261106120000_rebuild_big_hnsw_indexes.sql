-- =============================================================================
-- Rebuild the two big HNSW indexes dropped during the normalized-columns work
--
-- Why
-- ───
-- hashes_hash_bit_hnsw_idx and partner_hash_bit_hnsw_idx were dropped
-- (sql/normalize_columns/0_drop_big_hnsw_indexes.sql) so the backfill and
-- VACUUM FULL ran in seconds. The contract step and VACUUM FULL are done, so
-- they are rebuilt now with m = 32, ef_construction = 200 (see
-- 20261031120100_rebuild_hnsw_indexes.sql for why those parameters).
--
-- What it does
-- ────────────
-- Same idempotent function as 20261031120100, which is already recorded in the
-- migration history and therefore won't run again. For each of the four HNSW
-- indexes it skips the table if missing, skips an index already on the new
-- parameters (the two thumbnail indexes are), and otherwise builds `<name>2`,
-- drops the old index if any, and renames the new one into place. A leftover
-- `<name>2` from an interrupted run is reused.
--
-- ⚠ Production: slow, and it blocks writes
-- ─────────────────────────────────────────
-- Roughly 150k + 86k rows; each build runs for minutes and holds a lock that
-- blocks writes to its table. Keep the scrapers stopped. The migration runner
-- applies the whole file under its own time limits; if it times out, nothing is
-- lost (re-run it, or run it once over a direct connection and let the
-- integration record it as a no-op):
--     psql "<direct connection string>" -f \
--       supabase/migrations/20261106120000_rebuild_big_hnsw_indexes.sql
-- Progress, from a second connection:
--     select phase, blocks_done, blocks_total from pg_stat_progress_create_index;
-- Afterwards re-run Part 1 of sql/hnsw_recall_tests.sql.
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
