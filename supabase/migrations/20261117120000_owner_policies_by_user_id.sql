-- Identify the app owner by auth user id instead of by email address.
--
-- The owner-only policies (20261110120000_restrict_rls_to_owner.sql,
-- 20261114120000_api_stats.sql, 20261115120000_api_compare.sql) compared the JWT
-- email claim with a literal address. The user id is what auth.uid() returns for
-- the signed-in user; it never changes and does not put an email address into a
-- public repository. Only the policy expression changes: policy names, commands,
-- roles and grants stay as they were.
--
-- (select auth.uid()) is wrapped in a sub-select so Postgres evaluates it once per
-- statement instead of once per row.
--
-- The sign-up restriction (auth.restrict_user_creation trigger and the
-- public.restrict_signup hook) still goes by email: a new account has no user id yet.

begin;

-- ---- hashes ---------------------------------------------------------------
drop policy if exists "owner can read hashes" on public.hashes;
create policy "owner can read hashes" on public.hashes
  for select to authenticated
  using ((select auth.uid()) = 'b0ed7f80-e02c-4759-92ba-b38ce507d82d'::uuid);

-- ---- partner --------------------------------------------------------------
drop policy if exists "owner can read partner" on public.partner;
create policy "owner can read partner" on public.partner
  for select to authenticated
  using ((select auth.uid()) = 'b0ed7f80-e02c-4759-92ba-b38ce507d82d'::uuid);

-- ---- lookup tables --------------------------------------------------------
drop policy if exists "owner can read camera_names" on public.camera_names;
create policy "owner can read camera_names" on public.camera_names
  for select to authenticated
  using ((select auth.uid()) = 'b0ed7f80-e02c-4759-92ba-b38ce507d82d'::uuid);

drop policy if exists "owner can read location_names" on public.location_names;
create policy "owner can read location_names" on public.location_names
  for select to authenticated
  using ((select auth.uid()) = 'b0ed7f80-e02c-4759-92ba-b38ce507d82d'::uuid);

drop policy if exists "owner can read origins" on public.origins;
create policy "owner can read origins" on public.origins
  for select to authenticated
  using ((select auth.uid()) = 'b0ed7f80-e02c-4759-92ba-b38ce507d82d'::uuid);

-- ---- wa (read + update) ---------------------------------------------------
drop policy if exists "owner can read wa" on public.wa;
create policy "owner can read wa" on public.wa
  for select to authenticated
  using ((select auth.uid()) = 'b0ed7f80-e02c-4759-92ba-b38ce507d82d'::uuid);

drop policy if exists "owner can update wa" on public.wa;
create policy "owner can update wa" on public.wa
  for update to authenticated
  using ((select auth.uid()) = 'b0ed7f80-e02c-4759-92ba-b38ce507d82d'::uuid)
  with check ((select auth.uid()) = 'b0ed7f80-e02c-4759-92ba-b38ce507d82d'::uuid);

-- ---- api_stats ------------------------------------------------------------
drop policy if exists "owner can read api_stats" on public.api_stats;
create policy "owner can read api_stats" on public.api_stats
  for select to authenticated
  using ((select auth.uid()) = 'b0ed7f80-e02c-4759-92ba-b38ce507d82d'::uuid);

drop policy if exists "owner can insert api_stats" on public.api_stats;
create policy "owner can insert api_stats" on public.api_stats
  for insert to authenticated
  with check ((select auth.uid()) = 'b0ed7f80-e02c-4759-92ba-b38ce507d82d'::uuid);

drop policy if exists "owner can delete api_stats" on public.api_stats;
create policy "owner can delete api_stats" on public.api_stats
  for delete to authenticated
  using ((select auth.uid()) = 'b0ed7f80-e02c-4759-92ba-b38ce507d82d'::uuid);

-- ---- api_stats_daily ------------------------------------------------------
drop policy if exists "owner can read api_stats_daily" on public.api_stats_daily;
create policy "owner can read api_stats_daily" on public.api_stats_daily
  for select to authenticated
  using ((select auth.uid()) = 'b0ed7f80-e02c-4759-92ba-b38ce507d82d'::uuid);

drop policy if exists "owner can insert api_stats_daily" on public.api_stats_daily;
create policy "owner can insert api_stats_daily" on public.api_stats_daily
  for insert to authenticated
  with check ((select auth.uid()) = 'b0ed7f80-e02c-4759-92ba-b38ce507d82d'::uuid);

-- ---- api_compare ----------------------------------------------------------
drop policy if exists "owner can read api_compare" on public.api_compare;
create policy "owner can read api_compare" on public.api_compare
  for select to authenticated
  using ((select auth.uid()) = 'b0ed7f80-e02c-4759-92ba-b38ce507d82d'::uuid);

drop policy if exists "owner can insert api_compare" on public.api_compare;
create policy "owner can insert api_compare" on public.api_compare
  for insert to authenticated
  with check ((select auth.uid()) = 'b0ed7f80-e02c-4759-92ba-b38ce507d82d'::uuid);

drop policy if exists "owner can delete api_compare" on public.api_compare;
create policy "owner can delete api_compare" on public.api_compare
  for delete to authenticated
  using ((select auth.uid()) = 'b0ed7f80-e02c-4759-92ba-b38ce507d82d'::uuid);

commit;
