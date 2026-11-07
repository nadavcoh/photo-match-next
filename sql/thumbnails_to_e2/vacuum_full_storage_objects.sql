-- Manual script (NOT a migration): run through the Supabase connector or SQL
-- editor AFTER scripts/thumbnails_to_e2/cleanup.py has deleted the objects.
--
-- storage.objects is owned by supabase_storage_admin, but the postgres role
-- holds the MAINTAIN privilege on it (checked 2026-11-07), which is enough for
-- VACUUM FULL / REINDEX. Plain deletes leave the table + indexes at their old
-- on-disk size (~226 MB); this rewrites them.

-- VACUUM cannot share a call with other statements: run each of the three
-- statements below as its own call.

-- 1. Before: size of the table incl. indexes.
select pg_size_pretty(pg_total_relation_size('storage.objects')) as before_size,
       (select count(*) from storage.objects) as rows_left;

-- 2. Rewrite table and indexes (fast when the table is nearly empty).
VACUUM (FULL, ANALYZE) storage.objects;

-- 3. After.
select pg_size_pretty(pg_total_relation_size('storage.objects')) as after_size,
       pg_size_pretty(pg_database_size(current_database())) as database_size;
