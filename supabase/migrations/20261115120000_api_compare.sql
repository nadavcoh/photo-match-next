-- Durable result of the 'compare' search engine (MATCH_ENGINE=compare).
--
-- In compare mode /api/match answers from the in-memory index and, after the
-- response, runs the database in 'exact' mode and checks that both return the same
-- rows, in the same order, with the same distances (src/app/api/match/route.ts,
-- compareWithDatabase). Until now that verdict was only a log line, and Vercel
-- Hobby keeps about an hour of logs. One row per compared request goes here instead.
--
--   result       'match'     identical rows, order and distances
--                'mismatch'  they differ; `detail` says how
--                'error'     the comparison itself failed (database error, timeout)
--   hashes/partner  rows the in-memory engine returned
--   index_*      rows loaded and seconds since the last update, to tell a real bug
--                from a row that was added after the last delta
--   detail       first differences, cut to 1000 characters
--
-- Kept 30 days: compact_api_stats() now also deletes old api_compare rows. Owner-only
-- RLS and grants, as for api_stats (20261114120000_api_stats.sql).

begin;

create table if not exists public.api_compare (
  id                bigint generated always as identity primary key,
  ts                timestamptz not null default now(),
  wa_id             integer,
  is_video          boolean not null,
  result            text not null check (result in ('match', 'mismatch', 'error')),
  hashes            smallint,
  partner           smallint,
  index_hashes      integer,
  index_partner     integer,
  index_age_s       integer,
  detail            text
);

create index if not exists api_compare_ts_idx on public.api_compare (ts);

alter table public.api_compare enable row level security;

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

revoke all on public.api_compare from anon, authenticated;
grant select, insert, delete on public.api_compare to authenticated;
grant usage on sequence public.api_compare_id_seq to authenticated;

-- Same function as in 20261114120000_api_stats.sql, plus the api_compare retention.
create or replace function public.compact_api_stats(
  p_keep_match_days integer default 30,
  p_keep_warm_days integer default 7
)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_rolled integer;
  v_deleted_match integer;
  v_deleted_warm integer;
  v_deleted_compare integer;
begin
  -- Finished days only, and never overwrite a day that is already rolled up
  -- (its raw rows may have been partly deleted since).
  insert into public.api_stats_daily (
    day, route, mode, is_video, n, n_failed,
    ms_avg, ms_p50, ms_p90, ms_p99, ms_max,
    rpc_p50, rpc_p90, e2_p50, warm_samples_avg
  )
  select
    (s.ts at time zone 'utc')::date,
    s.route,
    coalesce(s.mode, ''),
    coalesce(s.is_video, false),
    count(*)::integer,
    count(*) filter (where not s.ok)::integer,
    round(avg(s.ms))::integer,
    round(percentile_cont(0.5)  within group (order by s.ms))::integer,
    round(percentile_cont(0.9)  within group (order by s.ms))::integer,
    round(percentile_cont(0.99) within group (order by s.ms))::integer,
    max(s.ms),
    round(percentile_cont(0.5) within group (order by s.rpc_ms))::integer,
    round(percentile_cont(0.9) within group (order by s.rpc_ms))::integer,
    round(percentile_cont(0.5) within group (order by s.e2_ms))::integer,
    round(avg(s.warm_samples)::numeric, 2)
  from public.api_stats s
  where (s.ts at time zone 'utc')::date < v_today
  group by 1, 2, 3, 4
  on conflict (day, route, mode, is_video) do nothing;
  get diagnostics v_rolled = row_count;

  -- Retention. At least 2 days so a day is always rolled up before its rows go.
  delete from public.api_stats
  where route = 'match' and ts < now() - make_interval(days => greatest(p_keep_match_days, 2));
  get diagnostics v_deleted_match = row_count;

  delete from public.api_stats
  where route = 'warm' and ts < now() - make_interval(days => greatest(p_keep_warm_days, 2));
  get diagnostics v_deleted_warm = row_count;

  delete from public.api_compare
  where ts < now() - make_interval(days => greatest(p_keep_match_days, 2));
  get diagnostics v_deleted_compare = row_count;

  return jsonb_build_object(
    'rolled_up', v_rolled,
    'deleted_match', v_deleted_match,
    'deleted_warm', v_deleted_warm,
    'deleted_compare', v_deleted_compare
  );
end;
$$;

revoke execute on function public.compact_api_stats(integer, integer) from public, anon;
grant execute on function public.compact_api_stats(integer, integer) to authenticated;

commit;
