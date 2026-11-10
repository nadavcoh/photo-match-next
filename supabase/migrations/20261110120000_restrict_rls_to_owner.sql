-- Restrict row access to the app owner's account and tighten privileges.
--
-- Policies in PostgreSQL are PERMISSIVE by default and are OR-ed together, so a
-- single "using (true)" policy makes every sibling policy irrelevant. This
-- replaces the overlapping policies with one owner-only policy per command.
--
-- What the app really does as the signed-in user (all via RLS):
--   * SELECT on hashes, partner, wa, camera_names, location_names, origins
--   * UPDATE on wa (match / skip / undo routes)
-- INSERT/DELETE happen only through the scrapers' direct database connection,
-- which does not go through RLS.

begin;

-- ---- hashes ---------------------------------------------------------------
drop policy if exists "authenticated can read hashes" on public.hashes;
drop policy if exists "hashes_authenticated_select" on public.hashes;
drop policy if exists "allowed account can read hashes" on public.hashes;

create policy "owner can read hashes" on public.hashes
  for select to authenticated
  using (lower((select auth.jwt() ->> 'email')) = 'cohen.n@gmail.com');

-- ---- partner --------------------------------------------------------------
drop policy if exists "authenticated can read partner" on public.partner;
drop policy if exists "partner_authenticated_select" on public.partner;

create policy "owner can read partner" on public.partner
  for select to authenticated
  using (lower((select auth.jwt() ->> 'email')) = 'cohen.n@gmail.com');

-- ---- lookup tables --------------------------------------------------------
drop policy if exists "camera_names_authenticated_select" on public.camera_names;
create policy "owner can read camera_names" on public.camera_names
  for select to authenticated
  using (lower((select auth.jwt() ->> 'email')) = 'cohen.n@gmail.com');

drop policy if exists "location_names_authenticated_select" on public.location_names;
create policy "owner can read location_names" on public.location_names
  for select to authenticated
  using (lower((select auth.jwt() ->> 'email')) = 'cohen.n@gmail.com');

drop policy if exists "origins_authenticated_select" on public.origins;
create policy "owner can read origins" on public.origins
  for select to authenticated
  using (lower((select auth.jwt() ->> 'email')) = 'cohen.n@gmail.com');

-- ---- wa (read + update, no insert/delete) ---------------------------------
drop policy if exists "authenticated can read wa" on public.wa;
drop policy if exists "wa_authenticated_all" on public.wa;
drop policy if exists "allowed account can read wa" on public.wa;

create policy "owner can read wa" on public.wa
  for select to authenticated
  using (lower((select auth.jwt() ->> 'email')) = 'cohen.n@gmail.com');

create policy "owner can update wa" on public.wa
  for update to authenticated
  using (lower((select auth.jwt() ->> 'email')) = 'cohen.n@gmail.com')
  with check (lower((select auth.jwt() ->> 'email')) = 'cohen.n@gmail.com');

-- ---- privileges RLS does not cover ----------------------------------------
-- TRUNCATE is not subject to RLS; nothing in the app needs these grants.
revoke truncate, trigger, references on
  public.hashes, public.partner, public.wa,
  public.camera_names, public.location_names, public.origins
from authenticated;

-- The app never queries as anon.
revoke all on
  public.hashes, public.partner, public.wa,
  public.camera_names, public.location_names, public.origins
from anon;

-- ---- auth hook function ---------------------------------------------------
alter function public.restrict_signup(jsonb) set search_path = '';

commit;
