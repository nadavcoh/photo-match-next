-- =============================================================================
-- Normalize hashes/partner columns — STEP 4 ("contract"): drop the old columns.
-- IRREVERSIBLE. Run with psql, and only after ALL of these are true:
--   [ ] expand migration + 1_backfill.sql applied (and the verification passed)
--   [ ] 20261103120100_match_functions_read_normalized_columns.sql applied, and
--       the match UI works (url link, size badge, 📷/📍, file-size badge)
--   [ ] photo-match-next deployed with the filesize-free types/route/page
--   [ ] webos-local-slideshow deployed to the TV (it reads hashes.lat/lon and
--       location_names instead of hashes.location/location_name) and shows a
--       photo's location; server/photo_serve*.py updated on the LAN box
--   [ ] phash scrapers (gphoto_selenium_v2.py, partner.py, album_wa.py) updated
--       — an old scraper will fail on insert once these columns are gone
--   [ ] re-run 1_backfill.sql just before this (picks up any straggler rows)
--
-- Recommended invocation:  psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -1 -f 2_contract.sql
--
-- This frees no disk space by itself — dropped columns leave the heap as it
-- was. 3_vacuum_full.sql rewrites the tables to actually shrink them.
-- =============================================================================

set statement_timeout = 0;

-- Refuse to drop anything that has not been carried over.
do $$
declare v_bad bigint;
begin
  select count(*) into v_bad from public.hashes h where
       (h.url is not null           and h.photo_id is null)
    or (h.location is not null      and (h.lat is null or h.lon is null))
    or (h.size is not null          and (h.width is null or h.height is null))
    or (h.origin is not null        and h.origin_id is null)
    or (h.camera_name is not null   and h.camera_name_id is null)
    or (h.location_name is not null and h.location_name_id is null)
    or (h.jpeg_quant_tables is not null and h.quant_profile_id is null)
    or (h.filesize is not null      and h.filesize_bytes is null)
    or h.photo_id is null;
  if v_bad > 0 then
    raise exception '% hashes row(s) are not backfilled — run 1_backfill.sql again before the contract step', v_bad;
  end if;

  select count(*) into v_bad from public.partner p where
       (p.url is not null           and p.photo_id is null)
    or (p.size is not null          and (p.width is null or p.height is null))
    or (p.jpeg_quant_tables is not null and p.quant_profile_id is null)
    or (p.filesize is not null      and p.filesize_bytes is null)
    or p.photo_id is null;
  if v_bad > 0 then
    raise exception '% partner row(s) are not backfilled — run 1_backfill.sql again before the contract step', v_bad;
  end if;
end
$$;

-- A row can no longer exist without a Google Photos id.
alter table public.hashes
  alter column photo_id set not null,
  add constraint hashes_photo_id_format check (photo_id ~ '^[A-Za-z0-9_-]+$');
alter table public.partner
  alter column photo_id set not null,
  add constraint partner_photo_id_format check (photo_id ~ '^[A-Za-z0-9_-]+$');

alter table public.hashes
  drop column url,
  drop column size,
  drop column filesize,
  drop column location,
  drop column location_name,
  drop column camera_name,
  drop column origin,
  drop column jpeg_quant_tables;

alter table public.partner
  drop column url,
  drop column size,
  drop column filesize,
  drop column jpeg_quant_tables;

reset statement_timeout;
