-- Long-term API statistics.
--
-- Vercel Hobby keeps about 1 hour of runtime logs, which is too short to see
-- trends (cold connections, warm-up effect, e2 latency, slow days). The app
-- records one small row per /api/match and /api/warm request after the
-- response has been sent (see src/lib/stats.ts), so recording adds no latency.
--
--   api_stats        raw rows (~100 bytes each). Kept 30 days for 'match' and
--                    7 days for 'warm' (warm pings are frequent and low value).
--   api_stats_daily  one row per day / route / mode / is_video with count,
--                    average, p50/p90/p99 and the main phase medians. Kept for
--                    good; tiny.
--
-- compact_api_stats() rolls finished days up into api_stats_daily (never
-- overwrites an existing day) and then deletes raw rows past their retention.
-- The app calls it now and then from /api/warm; it can also be run by hand.
--
-- Access follows the owner-only RLS migration (20261110120000): the owner's
-- email, nothing for anon. The functions run as the caller (SECURITY INVOKER).

begin;

create table if not exists public.api_stats (
  id          bigint generated always as identity primary key,
  ts          timestamptz not null default now(),
  route       text not null check (route in ('match', 'warm')),
  ok          boolean not null default true,
  ms          integer not null,
  region      text,
  mode        text check (mode in ('fast', 'wide', 'exact')),
  is_video    boolean,
  hashes      smallint,
  partner     smallint,
  thumbs      smallint,
  count_ms    integer,
  item_ms     integer,
  rpc_ms      integer,
  e2_ms       integer,
  pixel_ms    integer,
  sign_ms     integer,
  warm_n      smallint,
  warm_samples smallint
);

create index if not exists api_stats_ts_idx on public.api_stats (ts);

create table if not exists public.api_stats_daily (
  day          date not null,
  route        text not null,
  mode         text not null default '',
  is_video     boolean not null default false,
  n            integer not null,
  n_failed     integer not null default 0,
  ms_avg       integer,
  ms_p50       integer,
  ms_p90       integer,
  ms_p99       integer,
  ms_max       integer,
  rpc_p50      integer,
  rpc_p90      integer,
  e2_p50       integer,
  warm_samples_avg numeric(6, 2),
  primary key (day, route, mode, is_video)
);

alter table public.api_stats enable row level security;
alter table public.api_stats_daily enable row level security;

drop policy if exists "owner can read api_stats" on public.api_stats;
create policy "owner can read api_stats" on public.api_stats
  for select to authenticated
  using (lower((select auth.jwt() ->> 'email')) = 'cohen.n@gmail.com');

drop policy if exists "owner can insert api_stats" on public.api_stats;
create policy "owner can insert api_stats" on public.api_stats
  for insert to authenticated
  with check (lower((select auth.jwt() ->> 'email')) = 'cohen.n@gmail.com');

drop policy if exists "owner can delete api_stats" on public.api_stats;
create policy "owner can delete api_stats" on public.api_stats
  for delete to authenticated
  using (lower((select auth.jwt() ->> 'email')) = 'cohen.n@gmail.com');

drop policy if exists "owner can read api_stats_daily" on public.api_stats_daily;
create policy "owner can read api_stats_daily" on public.api_stats_daily
  for select to authenticated
  using (lower((select auth.jwt() ->> 'email')) = 'cohen.n@gmail.com');

drop policy if exists "owner can insert api_stats_daily" on public.api_stats_daily;
create policy "owner can insert api_stats_daily" on public.api_stats_daily
  for insert to authenticated
  with check (lower((select auth.jwt() ->> 'email')) = 'cohen.n@gmail.com');

-- Exactly the privileges the app needs, nothing else (new tables in public get
-- broad default grants on Supabase).
revoke all on public.api_stats, public.api_stats_daily from anon, authenticated;
grant select, insert, delete on public.api_stats to authenticated;
grant select, insert on public.api_stats_daily to authenticated;
-- The identity column needs its sequence for inserts.
grant usage on sequence public.api_stats_id_seq to authenticated;

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

  return jsonb_build_object(
    'rolled_up', v_rolled,
    'deleted_match', v_deleted_match,
    'deleted_warm', v_deleted_warm
  );
end;
$$;

revoke execute on function public.compact_api_stats(integer, integer) from public, anon;
grant execute on function public.compact_api_stats(integer, integer) to authenticated;

commit;
