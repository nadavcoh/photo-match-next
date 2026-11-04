-- =============================================================================
-- Normalize hashes/partner columns — STEP 1 ("expand"): DDL only, instant.
--
-- Goal: shrink the database (see CLAUDE.md, "Normalized columns"). This step
-- ADDS the compact columns, lookup tables and URL builders. It changes no
-- existing data and drops nothing, so everything that reads the old columns
-- (webOS TV app, LAN photo server, scrapers) keeps working. The backfill is a
-- separate, slow script (sql/normalize_columns/1_backfill.sql) — see
-- sql/normalize_columns/README.md for the whole sequence.
--
-- What changes (old column(s) -> new column(s)):
--   hashes.url                    -> hashes.photo_id   (url minus its prefix)
--   partner.url                   -> partner.photo_id
--   hashes.location               -> hashes.lat, hashes.lon   (float8)
--   hashes/partner.size ("W × H") -> width, height            (int4)
--   hashes.origin / camera_name / location_name
--                                 -> origin_id / camera_name_id / location_name_id
--                                    (smallint FKs into small lookup tables)
--   hashes/partner.jpeg_quant_tables (jsonb, ~1.5 KB/row)
--                                 -> quant_profile_id (smallint FK into
--                                    jpeg_quant_profiles; ~600 distinct tables)
--   hashes/partner.filesize (text) -> merged into filesize_bytes
--
-- filesize merge: where filesize_bytes IS NULL it is filled by parsing the
-- Google-Photos text ("Backed up (2.6 MB)", "117.4 KB", …) with DECIMAL units
-- (KB = 1000 B — checked against rows that have both: KB agrees ~100%). Those
-- values are approximate (display precision) and, for MB, Google's "backed up"
-- size often differs from the downloaded file — accepted by design. Existing
-- exact filesize_bytes values are NEVER overwritten.
--
-- The URL builders below hard-code the partner-library id; the scrapers refuse
-- any other.
--
-- Idempotent (IF NOT EXISTS / OR REPLACE throughout): safe to re-run.
--
-- =============================================================================

-- ─── 1. URL / location builders ─────────────────────────────────────────────
-- Immutable, so they are cheap to call per row from the match_* functions.

create or replace function public.gphoto_photo_url(p_photo_id text)
returns text language sql immutable parallel safe
as $$ select 'https://photos.google.com/photo/' || p_photo_id $$;

create or replace function public.gphoto_partner_photo_url(p_photo_id text)
returns text language sql immutable parallel safe
as $$ select 'https://photos.google.com/partner/AF1QipPzD3m31VUHKp_2xZaU2YcwDKdy/photo/' || p_photo_id $$;

-- float8::text is the shortest string that round-trips, so this reproduces the
-- original "…maps?q=loc:32.1766469,34.9119316" links exactly (checked on every
-- row before this migration was written).
create or replace function public.gphoto_location_url(p_lat double precision, p_lon double precision)
returns text language sql immutable parallel safe
as $$
  select case when p_lat is null or p_lon is null then null
              else 'https://www.google.com/maps?q=loc:' || p_lat::text || ',' || p_lon::text end
$$;

-- ─── 2. Lookup tables ───────────────────────────────────────────────────────
-- Same RLS pattern as hashes/partner: any authenticated user may read (the
-- match_* functions are SECURITY INVOKER, so they need this), nobody writes
-- through the API. The scrapers connect directly and bypass RLS.

create table if not exists public.origins (
  id    smallint generated always as identity primary key,
  value text not null unique
);
create table if not exists public.camera_names (
  id    smallint generated always as identity primary key,
  value text not null unique
);
create table if not exists public.location_names (
  id    smallint generated always as identity primary key,
  value text not null unique      -- stored verbatim (incl. "Estimated location" boilerplate)
);

alter table public.origins        enable row level security;
alter table public.camera_names   enable row level security;
alter table public.location_names enable row level security;

drop policy if exists "origins_authenticated_select" on public.origins;
create policy "origins_authenticated_select" on public.origins
  for select to authenticated using (true);
drop policy if exists "camera_names_authenticated_select" on public.camera_names;
create policy "camera_names_authenticated_select" on public.camera_names
  for select to authenticated using (true);
drop policy if exists "location_names_authenticated_select" on public.location_names;
create policy "location_names_authenticated_select" on public.location_names
  for select to authenticated using (true);

-- JPEG quantization-table profiles. Keyed by an md5 of the canonical jsonb
-- text rather than by the ~1.5 KB jsonb itself (btree entries are limited to
-- ~2.7 KB). Not exposed to the API at all: RLS on, no policy, grants revoked.
create table if not exists public.jpeg_quant_profiles (
  id         smallint generated always as identity primary key,
  tables     jsonb not null,
  tables_md5 text generated always as (md5(tables::text)) stored,
  unique (tables_md5)
);
alter table public.jpeg_quant_profiles enable row level security;
revoke all on public.jpeg_quant_profiles from anon, authenticated;

-- ─── 3. New columns (nullable until the contract script) ────────────────────

alter table public.hashes
  add column if not exists photo_id          text,
  add column if not exists lat               double precision,
  add column if not exists lon               double precision,
  add column if not exists width             integer,
  add column if not exists height            integer,
  add column if not exists origin_id         smallint references public.origins(id),
  add column if not exists camera_name_id    smallint references public.camera_names(id),
  add column if not exists location_name_id  smallint references public.location_names(id),
  add column if not exists quant_profile_id  smallint references public.jpeg_quant_profiles(id);

alter table public.partner
  add column if not exists photo_id          text,
  add column if not exists width             integer,
  add column if not exists height            integer,
  add column if not exists quant_profile_id  smallint references public.jpeg_quant_profiles(id);
