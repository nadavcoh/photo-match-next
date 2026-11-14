-- In-memory matching, step 1: the database side.
--
-- The app can keep the 64-bit hashes of `hashes` and `partner` (about 240,000
-- rows, a few MB) in the memory of the Vercel function and find candidates
-- there with an exact Hamming scan (src/lib/hashIndex.ts), instead of calling
-- the match_* functions. That avoids the slow cold-connection searches on the
-- Nano compute. This migration adds what that needs:
--
--   export_hash_index(table, after_id, limit)  hands the hashes out in compact
--       fixed-width text chunks (40 characters per row: id as 8 hex digits, hash
--       and video-thumb hash as 16 hex digits each, '-' x 16 where a hash is
--       NULL). The app loads chunks by id order and later fetches only rows with
--       a higher id.
--   get_hashes_rows(ids) / get_partner_rows(ids)  return the display columns for
--       the few candidate rows the scan found: the same columns and derived
--       values as match_hashes_* / match_partner_*, without the distances (the
--       app computes those itself).
--   api_stats.engine  records which engine answered each /api/match request
--       ('db' or 'memory') so the two can be compared.
--
-- The existing match_* functions stay: they are the fallback and the reference
-- the in-memory engine is tested against (scripts/hash_index_parity.mjs).
--
-- All functions are SECURITY INVOKER (RLS applies), search_path pinned.

begin;

alter table public.api_stats add column if not exists engine text;
alter table public.api_stats drop constraint if exists api_stats_engine_check;
alter table public.api_stats add constraint api_stats_engine_check check (engine in ('db', 'memory'));

-- One 40-character record. bit(64) -> bigint keeps all 64 bits (two's complement),
-- and to_hex() of a bigint prints them as unsigned hex.
create or replace function public.hash_index_record(p_id integer, p_hash bit, p_thumb bit)
returns text
language sql
immutable
set search_path = public
as $$
  select lpad(to_hex(p_id), 8, '0')
      || coalesce(lpad(to_hex(p_hash::bit(64)::bigint), 16, '0'), repeat('-', 16))
      || coalesce(lpad(to_hex(p_thumb::bit(64)::bigint), 16, '0'), repeat('-', 16));
$$;

create or replace function public.export_hash_index(
  p_table    text,
  p_after_id integer default 0,
  p_limit    integer default 40000
)
returns table (n integer, max_id integer, data text)
language plpgsql
stable
set search_path = public
as $$
#variable_conflict use_column
declare
  v_limit integer := least(greatest(coalesce(p_limit, 40000), 1), 100000);
  v_after integer := coalesce(p_after_id, 0);
begin
  if p_table = 'hashes' then
    return query
    with c as (
      select h.id, h.hash_bit, h.video_thumb_hash_bit
      from public.hashes h
      where h.id > v_after
      order by h.id
      limit v_limit
    )
    select count(*)::integer,
           coalesce(max(c.id), v_after)::integer,
           coalesce(string_agg(public.hash_index_record(c.id, c.hash_bit, c.video_thumb_hash_bit), '' order by c.id), '')
    from c;
  elsif p_table = 'partner' then
    return query
    with c as (
      select p.id, p.hash_bit, p.video_thumb_hash_bit
      from public.partner p
      where p.id > v_after
      order by p.id
      limit v_limit
    )
    select count(*)::integer,
           coalesce(max(c.id), v_after)::integer,
           coalesce(string_agg(public.hash_index_record(c.id, c.hash_bit, c.video_thumb_hash_bit), '' order by c.id), '')
    from c;
  else
    raise exception 'unknown table % (expected hashes or partner)', p_table using errcode = '22023';
  end if;
end;
$$;

create or replace function public.get_hashes_rows(p_ids integer[])
returns table (
  id               integer,
  filename         text,
  camera_name      text,
  location         text,
  location_name    text,
  ts               timestamptz,
  url              text,
  size             text,
  filesize_bytes   bigint,
  origin           text,
  duration         integer,
  jpeg_quality     smallint,
  bit_depth        smallint,
  pixel_format     text,
  color_primaries  text,
  color_space      text,
  color_transfer   text,
  color_range      text
)
language sql
stable
set search_path = public, extensions
as $$
  select
    a.id::integer,
    a.filename::text,
    (select cn.value from public.camera_names cn where cn.id = a.camera_name_id)::text,
    public.gphoto_location_url(a.lat, a.lon)::text,
    (select ln.value from public.location_names ln where ln.id = a.location_name_id)::text,
    a.timestamp::timestamptz,
    public.gphoto_photo_url(a.photo_id)::text,
    (a.width || ' × ' || a.height)::text,
    a.filesize_bytes::bigint,
    (select o.value from public.origins o where o.id = a.origin_id)::text,
    a.duration::integer,
    a.jpeg_quality::smallint,
    a.bit_depth::smallint,
    a.pixel_format::text,
    a.color_primaries::text,
    a.color_space::text,
    a.color_transfer::text,
    a.color_range::text
  from public.hashes a
  where a.id = any(p_ids);
$$;

create or replace function public.get_partner_rows(p_ids integer[])
returns table (
  id               integer,
  filename         text,
  ts               timestamptz,
  url              text,
  size             text,
  filesize_bytes   bigint,
  duration         integer,
  jpeg_quality     smallint,
  bit_depth        smallint,
  pixel_format     text,
  color_primaries  text,
  color_space      text,
  color_transfer   text,
  color_range      text
)
language sql
stable
set search_path = public, extensions
as $$
  select
    a.id::integer,
    a.filename::text,
    a.timestamp::timestamptz,
    public.gphoto_partner_photo_url(a.photo_id)::text,
    (a.width || ' × ' || a.height)::text,
    a.filesize_bytes::bigint,
    a.duration::integer,
    a.jpeg_quality::smallint,
    a.bit_depth::smallint,
    a.pixel_format::text,
    a.color_primaries::text,
    a.color_space::text,
    a.color_transfer::text,
    a.color_range::text
  from public.partner a
  where a.id = any(p_ids);
$$;

revoke execute on function public.hash_index_record(integer, bit, bit) from public, anon;
revoke execute on function public.export_hash_index(text, integer, integer) from public, anon;
revoke execute on function public.get_hashes_rows(integer[]) from public, anon;
revoke execute on function public.get_partner_rows(integer[]) from public, anon;
grant execute on function public.hash_index_record(integer, bit, bit) to authenticated;
grant execute on function public.export_hash_index(text, integer, integer) to authenticated;
grant execute on function public.get_hashes_rows(integer[]) to authenticated;
grant execute on function public.get_partner_rows(integer[]) to authenticated;

notify pgrst, 'reload schema';

commit;
