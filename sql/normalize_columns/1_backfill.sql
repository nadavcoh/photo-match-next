-- =============================================================================
-- Normalize hashes/partner columns — STEP 2: backfill + verification.
-- Run with psql (direct connection) AFTER migration
-- 20261103120000_normalize_columns_expand.sql. Idempotent: it only touches rows
-- whose photo_id is still NULL, so it can be re-run to pick up rows inserted by
-- an old scraper in the meantime.
--
-- PERFORMANCE — read this first. Updating every row creates a new row version,
-- and the HNSW index on hash_bit gets a new entry for each one (HNSW inserts
-- are slow: ~3 ms/row measured on a 15k-row copy, so ~15-20 min for the real
-- 240k rows, plus dead index entries that only a rebuild removes). The index
-- rebuild at the end (step 6) is needed anyway to reclaim space, so the cheap
-- way is to drop the two big HNSW indexes first (0_drop_big_hnsw_indexes.sql)
-- and rebuild them once at the end. Queries still work meanwhile (planner falls
-- back to an exact scan, ~35 ms). Or skip that and run this as-is: correct,
-- just slow.
--
-- filesize merge: where filesize_bytes IS NULL it is filled by parsing the
-- Google-Photos text ("Backed up (2.6 MB)", "117.4 KB", ...) with DECIMAL units
-- (KB = 1000 B — checked against rows that have both: KB agrees ~100%). Those
-- values are approximate (display precision) and, for MB, Google's "backed up"
-- size often differs from the downloaded file — accepted by design. Existing
-- exact filesize_bytes values are never overwritten.
--
-- The verification block at the end raises (rolling back, when run with
-- `psql -1`) if ANY row cannot be exactly reconstructed from the new columns.
-- Recommended invocation:  psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -1 -f 1_backfill.sql
-- =============================================================================

set statement_timeout = 0;

-- ─── 1. Backfill ────────────────────────────────────────────────────────────────────

-- Parses Google Photos' file-size text into bytes (decimal units).
create function pg_temp.parse_gphoto_filesize(p_text text)
returns bigint language sql immutable
as $$
  select case when m is null then null
    else round(m[1]::numeric * case upper(m[2])
                                  when 'B'  then 1
                                  when 'KB' then 1000
                                  when 'MB' then 1000000
                                  when 'GB' then 1000000000
                                  when 'TB' then 1000000000000 end)::bigint
  end
  from (select regexp_match(p_text, '([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB)\y', 'i') as m) s
$$;

insert into public.origins (value)
  select distinct origin from public.hashes where origin is not null
  on conflict (value) do nothing;
insert into public.camera_names (value)
  select distinct camera_name from public.hashes where camera_name is not null
  on conflict (value) do nothing;
insert into public.location_names (value)
  select distinct location_name from public.hashes where location_name is not null
  on conflict (value) do nothing;
insert into public.jpeg_quant_profiles (tables)
  select distinct t from (
    select jpeg_quant_tables as t from public.hashes
    union all
    select jpeg_quant_tables from public.partner
  ) x where t is not null
  on conflict (tables_md5) do nothing;

-- One UPDATE per table (one new row version per row, not one per column).
-- Rows with a non-standard url keep photo_id NULL and are reported by the
-- verification block below.
update public.hashes h set
  photo_id         = substring(h.url from '^https://photos\.google\.com/photo/([A-Za-z0-9_-]+)$'),
  lat              = (regexp_match(h.location, '^https://www\.google\.com/maps\?q=loc:(-?[0-9]+(?:\.[0-9]+)?),(-?[0-9]+(?:\.[0-9]+)?)$'))[1]::double precision,
  lon              = (regexp_match(h.location, '^https://www\.google\.com/maps\?q=loc:(-?[0-9]+(?:\.[0-9]+)?),(-?[0-9]+(?:\.[0-9]+)?)$'))[2]::double precision,
  width            = (regexp_match(h.size, '^(\d+) × (\d+)$'))[1]::integer,
  height           = (regexp_match(h.size, '^(\d+) × (\d+)$'))[2]::integer,
  origin_id        = (select o.id  from public.origins o         where o.value  = h.origin),
  camera_name_id   = (select c.id  from public.camera_names c    where c.value  = h.camera_name),
  location_name_id = (select l.id  from public.location_names l  where l.value  = h.location_name),
  quant_profile_id = (select q.id  from public.jpeg_quant_profiles q where q.tables_md5 = md5(h.jpeg_quant_tables::text)),
  filesize_bytes   = coalesce(h.filesize_bytes, pg_temp.parse_gphoto_filesize(h.filesize))
where h.photo_id is null and h.url is not null;

update public.partner p set
  photo_id         = substring(p.url from '^https://photos\.google\.com/partner/AF1QipPzD3m31VUHKp_2xZaU2YcwDKdy/photo/([A-Za-z0-9_-]+)$'),
  width            = (regexp_match(p.size, '^(\d+) × (\d+)$'))[1]::integer,
  height           = (regexp_match(p.size, '^(\d+) × (\d+)$'))[2]::integer,
  quant_profile_id = (select q.id from public.jpeg_quant_profiles q where q.tables_md5 = md5(p.jpeg_quant_tables::text)),
  filesize_bytes   = coalesce(p.filesize_bytes, pg_temp.parse_gphoto_filesize(p.filesize))
where p.photo_id is null and p.url is not null;

-- ─── 2. Verification — raises (and rolls back) on any mismatch ───────────────

do $$
declare
  v_bad bigint;
  v_msg text := '';
begin
  -- hashes: every old value must be exactly reconstructible from the new columns.
  select count(*) into v_bad from public.hashes h where
       h.photo_id is null
    or public.gphoto_photo_url(h.photo_id) is distinct from h.url
    or public.gphoto_location_url(h.lat, h.lon) is distinct from h.location
    or (case when h.width is null or h.height is null then null
             else h.width || ' × ' || h.height end) is distinct from h.size
    or (select o.value from public.origins o       where o.id = h.origin_id)        is distinct from h.origin
    or (select c.value from public.camera_names c  where c.id = h.camera_name_id)   is distinct from h.camera_name
    or (select l.value from public.location_names l where l.id = h.location_name_id) is distinct from h.location_name
    or (select q.tables from public.jpeg_quant_profiles q where q.id = h.quant_profile_id) is distinct from h.jpeg_quant_tables
    or (h.filesize is not null and h.filesize_bytes is null);
  if v_bad > 0 then v_msg := v_msg || format('hashes: %s row(s) do not reconstruct. ', v_bad); end if;

  select count(*) into v_bad from public.partner p where
       p.photo_id is null
    or public.gphoto_partner_photo_url(p.photo_id) is distinct from p.url
    or (case when p.width is null or p.height is null then null
             else p.width || ' × ' || p.height end) is distinct from p.size
    or (select q.tables from public.jpeg_quant_profiles q where q.id = p.quant_profile_id) is distinct from p.jpeg_quant_tables
    or (p.filesize is not null and p.filesize_bytes is null);
  if v_bad > 0 then v_msg := v_msg || format('partner: %s row(s) do not reconstruct. ', v_bad); end if;

  if v_msg <> '' then
    raise exception 'normalize_columns_backfill verification failed: %', v_msg;
  end if;
  raise notice 'normalize_columns_backfill: all rows verified.';
end
$$;

analyze public.hashes;
analyze public.partner;

reset statement_timeout;
