-- Warm up one database connection for the match searches.
--
-- A fresh connection is slow on its first searches (about 1 s each) and speeds
-- up to about 25 ms once it has visited enough of the HNSW indexes. This runs
-- searches with random hashes from `wa` against the same indexes the match
-- functions use, so the connection it lands on is warm for the next real
-- request. A connection that is already warm finishes after a few quick
-- samples. The time budget keeps the call under the API's statement timeout.
--
-- Runs as the caller (SECURITY INVOKER), so RLS applies as for the match
-- functions. Called from the app's /api/warm route.

begin;

create or replace function public.warm_match_index(p_budget_ms integer default 4000)
returns jsonb
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  r record;
  t0 timestamptz := clock_timestamp();
  ts timestamptz;
  samples integer := 0;
  sample_ms numeric;
begin
  perform set_config('hnsw.ef_search', '40', true);

  for r in
    select w.hash_bit, w.video_thumb_hash_bit
    from public.wa w
    where w.hash_bit is not null
    order by random()
    limit 60
  loop
    exit when extract(epoch from clock_timestamp() - t0) * 1000 > p_budget_ms;
    ts := clock_timestamp();

    perform 1
    from public.hashes a
    where (a.hash_bit <~> r.hash_bit::bit(64))::integer <= 10
    order by a.hash_bit <~> r.hash_bit::bit(64)
    limit 50;

    exit when extract(epoch from clock_timestamp() - t0) * 1000 > p_budget_ms;

    perform 1
    from public.partner p
    where (p.hash_bit <~> r.hash_bit::bit(64))::integer <= 10
    order by p.hash_bit <~> r.hash_bit::bit(64)
    limit 50;

    if r.video_thumb_hash_bit is not null then
      perform 1
      from public.hashes a
      where (a.video_thumb_hash_bit <~> r.video_thumb_hash_bit::bit(64))::integer <= 10
      order by a.video_thumb_hash_bit <~> r.video_thumb_hash_bit::bit(64)
      limit 50;

      perform 1
      from public.partner p
      where (p.video_thumb_hash_bit <~> r.video_thumb_hash_bit::bit(64))::integer <= 10
      order by p.video_thumb_hash_bit <~> r.video_thumb_hash_bit::bit(64)
      limit 50;
    end if;

    samples := samples + 1;
    sample_ms := extract(epoch from clock_timestamp() - ts) * 1000;
    -- Already warm: samples are fast, so stop early and save CPU.
    exit when samples >= 3 and sample_ms < 120;
  end loop;

  return jsonb_build_object(
    'samples', samples,
    'ms', round(extract(epoch from clock_timestamp() - t0) * 1000)
  );
end;
$$;

revoke all on function public.warm_match_index(integer) from public, anon;
grant execute on function public.warm_match_index(integer) to authenticated;

commit;
