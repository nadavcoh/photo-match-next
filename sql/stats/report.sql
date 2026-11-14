-- Long-term API statistics: example read-only queries (a manual script, not a
-- migration). Tables: public.api_stats (raw, 30 d match / 7 d warm) and
-- public.api_stats_daily (rolled up, kept). See
-- supabase/migrations/20261114120000_api_stats.sql. Run as the owner (RLS).

-- 1. Match latency per day (rolled-up days + today's raw rows).
select day, mode, is_video, n, n_failed, ms_p50, ms_p90, ms_p99, rpc_p50, rpc_p90, e2_p50
from public.api_stats_daily
where route = 'match'
order by day desc, mode, is_video
limit 60;

-- 2. Recent raw match rows with the idle gap since the previous match request.
--    Long gaps with a slow rpc_ms point at cold connections.
select ts, mode, is_video, ms, rpc_ms, e2_ms,
       round(extract(epoch from ts - lag(ts) over (order by ts))) as gap_s
from public.api_stats
where route = 'match' and ok
order by ts desc
limit 100;

-- 3. rpc_ms by idle-gap bucket (last 30 days, fast image searches).
with g as (
  select rpc_ms,
         extract(epoch from ts - lag(ts) over (order by ts)) as gap_s
  from public.api_stats
  where route = 'match' and ok and mode = 'fast' and not coalesce(is_video, false)
)
select case when gap_s < 15 then '<15 s'
            when gap_s < 60 then '15-60 s'
            when gap_s < 150 then '1-2.5 min'
            else '>2.5 min' end as idle_gap,
       count(*) as n,
       round(percentile_cont(0.5) within group (order by rpc_ms)) as rpc_p50,
       round(percentile_cont(0.9) within group (order by rpc_ms)) as rpc_p90
from g
where gap_s is not null
group by 1
order by min(gap_s);

-- 4. Warm-up health: pings per day, failures, average searches run per warm-up
--    (samples near 0-1 = the warm-up was starved).
select day, n, n_failed, ms_p50, ms_p90, warm_samples_avg
from public.api_stats_daily
where route = 'warm'
order by day desc
limit 30;

-- 5. Roll up finished days and apply retention by hand (the app also does this
--    about once per 500 warm-ups).
-- select public.compact_api_stats();
