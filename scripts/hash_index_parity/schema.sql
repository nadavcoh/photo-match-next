create role authenticated nologin;
create schema extensions; create extension vector with schema extensions;
create table public.origins(id serial primary key, value text);
create table public.camera_names(id serial primary key, value text);
create table public.location_names(id serial primary key, value text);
create function public.gphoto_photo_url(p text) returns text language sql immutable as $$ select 'https://photos/' || p $$;
create function public.gphoto_partner_photo_url(p text) returns text language sql immutable as $$ select 'https://partner/' || p $$;
create function public.gphoto_location_url(lat double precision, lon double precision) returns text language sql immutable as $$ select case when lat is null then null else 'https://maps/' || lat || ',' || lon end $$;
create table public.hashes(
  id integer primary key, filename text, camera_name_id int, lat double precision, lon double precision, location_name_id int,
  timestamp timestamptz, photo_id text, width int, height int, filesize_bytes bigint, origin_id int, duration double precision,
  jpeg_quality int, bit_depth int, pixel_format text, color_primaries text, color_space text, color_transfer text, color_range text,
  hash_bit bit(64), video_thumb_hash_bit bit(64));
create table public.partner(
  id integer primary key, filename text, timestamp timestamptz, photo_id text, width int, height int, filesize_bytes bigint, duration double precision,
  jpeg_quality int, bit_depth int, pixel_format text, color_primaries text, color_space text, color_transfer text, color_range text,
  hash_bit bit(64), video_thumb_hash_bit bit(64));
insert into public.origins(value) values ('a'),('b'); insert into public.camera_names(value) values ('cam1'),('cam2'); insert into public.location_names(value) values ('home'),('away');
