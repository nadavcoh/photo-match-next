# Photo Match

A private tool for matching a backlog of WhatsApp media exports against a
Google Photos library (and a partner's library) using perceptual-hash
similarity. Swipe through unmatched items, review ranked candidates, commit
or skip, undo if needed.

This is a personal, single-user app — not a general-purpose product. Auth is
locked to one GitHub account (identified by its GitHub user id).

## Stack

- **Next.js 15** (App Router, TypeScript, React 19)
- **Supabase** — Postgres (with `pgvector` + HNSW indexes for Hamming-distance
  queries), Auth (GitHub OAuth)
- **Backblaze B2** (S3-compatible API) — full-size original media previews
- **IDrive e2** (S3-compatible API) — small JPEG thumbnails
- **sharp** — server-side pixel-distance scoring
- Deployed on **Vercel** (functions in `fra1`, next to the Supabase database)

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You'll be redirected to
`/login` until you sign in with the allowed GitHub account.

## Environment variables

Create a `.env.local` with:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=

# Backblaze B2 (S3-compatible API) — full-size media previews
B2_APPLICATION_KEY_ID=
B2_APPLICATION_KEY=
B2_BUCKET_NAME=
B2_ENDPOINT=            # e.g. https://s3.us-west-004.backblazeb2.com
B2_REGION=              # e.g. us-west-004
B2_MEDIA_PREFIX=        # optional — only if media isn't stored at bucket root

# IDrive e2 (S3-compatible API) — thumbnails; a read-only key is enough here
E2_ACCESS_KEY_ID=
E2_SECRET_ACCESS_KEY=
E2_ENDPOINT=            # bare regional endpoint, e.g. https://s3.<region>.idrivee2.com (no bucket name in the host)
E2_REGION=              # the bucket's region name
E2_BUCKET=thumbnails    # optional, defaults to "thumbnails"

# Matching sensitivity (optional, default 10)
HAMMING_THRESHOLD=10

# Search engine (optional, default db): db | memory | compare.
# See CLAUDE.md, "In-memory matching (MATCH_ENGINE)".
MATCH_ENGINE=db
```

### Database setup

Run, in order, in the Supabase SQL editor:

1. `supabase-auth-setup.txt` — optional extra trigger that restricts new
   Supabase Auth sign-ups to the owner's GitHub account (the restriction in
   use is the `restrict_signup` hook, migration
   `20261117130000_restrict_signup_by_github_id.sql`)
2. `supabase-rls-and-rpc.sql` — enables RLS, adds the owner-only policies, and
   creates the four `match_*_image`/`match_*_video` RPC functions used for
   pgvector similarity queries (each takes an optional `p_mode` — see
   [Search modes](#search-modes-and-the-search-wider-button))
3. `supabase/migrations/20261031120100_rebuild_hnsw_indexes.sql` — creates
   the four HNSW indexes (or rebuilds existing ones with stronger
   parameters). **Run this one from `psql`, not the SQL editor** — index
   builds outlast the editor's timeout. Instructions are in the file header.

You'll also need three Postgres tables (`wa`, `hashes`, `partner`) with
`pgvector` `bit(64)` hash columns — see the RPC function definitions in
`supabase-rls-and-rpc.sql` for the expected columns.

### Migrations and the Supabase GitHub integration

Database changes made after the initial setup live in `supabase/migrations/`
as `YYYYMMDDHHMMSS_name.sql` files — the layout the Supabase CLI and the
GitHub integration expect (`supabase/config.toml` is the standard
`supabase init` output). They're plain SQL (no `psql` meta-commands),
idempotent, and applied in timestamp order. In the integration's settings,
set the Supabase directory to `supabase` and the production branch to
`master`.

| Migration | Notes |
|---|---|
| `20261031120000_search_modes_for_match_functions.sql` | The original `p_mode` versions of the four `match_*` functions. **Broken as shipped** (every call failed on a column-type mismatch); superseded by `20261031120200`, then by `20261103120100`. Quick; safe anywhere. |
| `20261031120100_rebuild_hnsw_indexes.sql` | Rebuilds the four HNSW indexes with `m = 32, ef_construction = 200`. **Slow and write-blocking on a populated database.** |
| `20261031120200_fix_match_function_return_types.sql` | Fixes the first migration's functions, which failed on every call (a column-type mismatch, e.g. `duration` is `double precision`). Supersedes their definitions (itself superseded by `20261103120100`, which keeps the casts). Quick. |
| `20261103120000_normalize_columns_expand.sql` | Adds the normalized columns (`photo_id`, `lat`/`lon`, `width`/`height`, `*_id`, `quant_profile_id`) and the lookup tables with their RLS policies. Additive; the old columns keep working. See [Normalized columns](#normalized-columns). |
| `20261103120100_match_functions_read_normalized_columns.sql` | Rewrites the four `match_*` functions to read the normalized columns (and drops the legacy `filesize` output). |
| `20261106120000_rebuild_big_hnsw_indexes.sql` | Same idempotent function as `...120100`: rebuilds the two big HNSW indexes (`hashes`, `partner`) that were dropped during the normalization, skipping the ones already on `m = 32`. **Slow and write-blocking.** |
| `20261110120000_restrict_rls_to_owner.sql` | Replaces the overlapping RLS policies with one owner-only policy per command (SELECT on every table, UPDATE on `wa`), revokes `TRUNCATE`/`TRIGGER`/`REFERENCES` from `authenticated` and all access to those tables from `anon`, and pins `restrict_signup`'s `search_path`. `supabase-rls-and-rpc.sql` now creates the same policies, so re-running that file is safe. Quick. |
| `20261113120000_warm_match_index.sql` | `warm_match_index()`: runs a few random searches so a fresh database connection is warm for the next real request (called by `/api/warm`). Quick. |
| `20261114120000_api_stats.sql` | `api_stats` (raw rows), `api_stats_daily` (rollup) and `compact_api_stats()`, with owner-only RLS. Quick. |
| `20261114130000_hash_index_export.sql` | `export_hash_index()`, `get_hashes_rows()`, `get_partner_rows()` and `api_stats.engine`, for in-memory matching (`MATCH_ENGINE`). Quick. |
| `20261115120000_api_compare.sql` | `api_compare` (verdicts of `MATCH_ENGINE=compare`) and its 30-day retention in `compact_api_stats()`. Quick. |
| `20261117120000_owner_policies_by_user_id.sql` | Recreates every owner policy (including `api_stats`, `api_stats_daily`, `api_compare`) as `auth.uid() = <owner user id>` instead of comparing the JWT email. Quick. |
| `20261117130000_restrict_signup_by_github_id.sql` | `public.restrict_signup` (Auth "Before User Created" hook) now lets a sign-up through only for GitHub user id `29537286`. Quick. |
| `20261121120000_raise_authenticated_statement_timeout.sql` | Raises the `authenticated` role's `statement_timeout` from 8 s to 30 s (and reloads PostgREST's config), so slow `match_*` / `export_hash_index` calls can finish. Quick. See [Timeouts and limits](#timeouts-and-limits). |

**Slow migrations.** An HNSW index rebuild on a populated database outlasts the
SQL editor's timeout, runs as one file under the integration, and blocks writes to
its table while it builds. For those (`20261031120100`, `20261106120000`), run the
file once by hand from `psql` before pushing it, so the integration finds nothing
left to build and just records it:

```bash
psql "<direct connection string, port 5432>" \
  -f supabase/migrations/<the slow migration>.sql
```

Pushing to the production branch is what triggers the integration to apply
pending migrations, so do this first. Every other file in `supabase/migrations/`
is applied by the integration alone; don't run migration SQL through the Supabase
connector. Things to know:

- The app tables (`wa`, `hashes`, `partner`) are not created by any migration,
  so a **preview branch** starts without them. The October migrations succeed
  there (the index ones skip missing tables) but the branch can't run the app,
  and the normalized-columns migrations (which alter `hashes`/`partner`) need
  the tables to exist.
  `supabase db pull` would capture a baseline migration if you want branches
  to be usable.
- `supabase/config.toml` says `major_version = 17`; it should match your
  project's Postgres major version (`show server_version;`). It only matters
  for local development and branches.
- The app works with the migrations applied before or after it deploys: it
  only sends `p_mode` when you press the escalate button.
- Before running DDL by hand on `hashes` or `partner` (an index drop or rebuild,
  `ALTER`, `VACUUM FULL`), check `pg_stat_activity` for sessions stuck
  `idle in transaction`: a leftover scraper connection holds a lock that makes the
  statement wait until it times out. The query is in [`CLAUDE.md`](./CLAUDE.md),
  "Normalized columns".

## Normalized columns

To keep the database small, `hashes` and `partner` store compact columns
instead of the text Google Photos shows: `photo_id` (the URL is rebuilt with
`gphoto_photo_url()`), `lat`/`lon`, `width`/`height`, small dictionary ids for
origin / camera / location name (`origins`, `camera_names`, `location_names`),
`quant_profile_id` (one row per distinct JPEG quantization-table set in
`jpeg_quant_profiles`), and a single `filesize_bytes`. The `match_*` functions
rebuild the display values, so the API response shape is unchanged apart from
the removed `filesize` text field.

As of 2026-11-06 the migration is finished on the live database: the old
columns are dropped and both tables were `VACUUM FULL`ed. The runbook that did
it is in [`sql/normalize_columns/`](./sql/normalize_columns/README.md); the
column map and gotchas are in [`CLAUDE.md`](./CLAUDE.md) ("Normalized
columns"). Anything that inserts rows (the private `phash` scrapers) must write
`photo_id` and the `*_id` columns. The `webos-local-slideshow` TV app reads
`lat`/`lon` and `location_names(value)` directly, so its RLS needs a SELECT
policy on `location_names`.

## Working through the queue

The page reads the ids of all unmatched items once (`GET /api/match/queue`,
about 30 KB for a few thousand items) and fetches each item by id
(`GET /api/match?id=`). Results are cached by id, and the next five items are
prefetched in the background (two requests at a time), so committing or skipping
moves to an item that is usually already loaded. Because the cache is keyed by id
and not by queue position, committing or skipping never makes it stale.

- Counters read "N remaining" and "N of count".
- The current item's id is kept in the URL (`#wa-<id>`), so a reload reopens it.
- **Commit is optimistic.** The item leaves the queue and the next one appears
  immediately; the save finishes in the background (it survives a reload, and the
  browser warns before you leave while one is pending). If a save fails, the item
  goes back to its place in the queue and an error toast names it.
- **Undo** puts the item back in the queue and shows it again. If the last commit
  is still saving, undo waits for it first.
- If an item was handled in another tab, it is dropped from the queue
  automatically.
- The queue is read on load and on ↻ / undo; items added by the scrapers in the
  meantime appear after ↻.

Keys: `Enter` or `c` commit, `←`/`p` previous, `→`/`n` next, `r` refresh,
`e` search wider, `1`–`9` pick a candidate. The design and its limits are in
[`CLAUDE.md`](./CLAUDE.md) under "Queue, ids and the item cache".

## Skipped photos

The ⏭️ button in the header opens `/skipped`: every item that was skipped (marked
processed without a match), newest first, 48 at a time with "Load more". Tap a
thumbnail to see the original (photos and videos synced to B2) and press
**Back to queue** to put it back; it is then in the unmatched queue again
(the main page picks it up on load or ↻). Only the **Skip** button leads here: the
UI always commits with a selected candidate, so nothing else marks an item processed.

## Search modes and the "Search wider" button

Candidate search uses HNSW indexes, which are *approximate*: they can miss a
real match, and when they do the app just shows "no candidates". So each item
can be searched at three depths:

| Mode | What it does | Typical cost (≈150k rows) |
|---|---|---|
| `fast` (default) | HNSW, `hnsw.ef_search = 40` | a few ms |
| `wide` | HNSW, `hnsw.ef_search = 400` | ~20 ms |
| `exact` | full scan, cannot miss | ~35 ms (`hashes`) |

Every item opens on `fast`. If the candidates look wrong, press **Search
wider** (or `e`): the first press re-runs the item at `wide`, the second at
`exact`. Refreshing (↻), or opening an item that isn't cached, searches it at
`fast`. An escalated result stays in the cache with its item (about 20 minutes),
so stepping back to an item you just escalated shows it as you left it.

The costs above are for a warm database connection; a fresh connection is much
slower on its first searches (see "Warm-up" in [`CLAUDE.md`](./CLAUDE.md)).

With `MATCH_ENGINE=memory` (see "In-memory matching" in [`CLAUDE.md`](./CLAUDE.md))
candidates come from an exact scan in the function's memory instead, so the modes
don't apply: the response reports `exact` and the button is hidden. The modes
matter whenever the database answers (the default engine, a fresh instance, any
fallback). In production, `MATCH_ENGINE=compare` agreed with the database on every
check that completed (651 of 651 between 2026-11-15 and 2026-11-25; 3 database
checks timed out), and an in-memory search took about 0.1 s against several seconds
on the database path (figures in `CLAUDE.md`, "In-memory matching").

The measurements behind this, and the reasons for each design choice, are in
[`CLAUDE.md`](./CLAUDE.md) under "HNSW recall and search modes".

### Checking recall

`sql/hnsw_recall_tests.sql` compares `fast` and `wide` against `exact` on real
items from `wa`. Re-run it when the data has grown by a third or more, after a
bulk import, after rebuilding an index or upgrading pgvector, or whenever a
match you know exists isn't offered. After any change to the `match_*` functions,
also run Part 4d: it calls every function in every mode and must return 12 rows
without an error. (It's plain SQL — works in the SQL editor or `psql`.)

## Timeouts and limits

- **Database.** The API routes run as the `authenticated` role, whose
  `statement_timeout` is 30 s (Supabase's default is 8 s; raised by migration
  `20261121120000_raise_authenticated_statement_timeout.sql`). `anon` stays at 3 s.
  It is a role setting because a timeout set inside a function does not extend the
  call that is already running.
- **Vercel.** `/api/match` and `/api/warm` export `maxDuration = 60`, a cap well above the
  30 s database timeout. Fluid Compute is on, so routes that set none use the project default of
  300 s (Project Settings → Functions).
- If searches still time out, `MATCH_ENGINE=memory` takes the candidate search out
  of the database. The evidence and the reasoning are in
  [`CLAUDE.md`](./CLAUDE.md), "Timeouts and function limits".

## Performance: warm-up, in-memory matching and statistics

- **Warm-up.** On the Free plan's Nano compute a fresh database connection is slow for
  its first searches (1 to 2 s each) and speeds up after a few dozen. The page pings
  `/api/warm?n=1` every 15 s while it is visible (`src/app/WarmUp.tsx`), never while a
  `/api/match` request is in flight, with a 4 s budget. Trying `n=2` and a 5.5 s budget
  gave no robust gain (numbers in `CLAUDE.md`, "Warm-up and long-term statistics"). `pg_prewarm` does not help
  either (the cold cost belongs to the connection, not to shared buffers), and the compute size can only be
  changed on a paid plan.
- **In-memory matching.** `MATCH_ENGINE=memory` keeps the 64-bit hashes of `hashes` and
  `partner` (about 240,000 rows, ~5 MB) in the function's memory and finds candidates
  with an exact Hamming scan (about 1.5 ms); only the matching rows' display columns
  come from the database. `compare` answers the same way and checks it against the
  database in `exact` mode after each response. `?engine=db|memory|compare` on
  `/api/match` overrides the variable for one request. A fresh function instance answers
  from the database until its index has loaded, and any problem falls back to the
  database. The page shows which engine answered and why ("⚡ memory · exact" or
  "🗄 database", with the reason beside it) and hides **Search wider** only when memory
  answered. `scripts/hash_index_parity/` tests the engine against the real SQL
  functions on a local Postgres (4,007 checks, 0 failures). Design and upkeep rules:
  `CLAUDE.md`, "In-memory matching (MATCH_ENGINE)".
- **Statistics.** Vercel Hobby keeps about an hour of logs, so every `/api/match` and
  `/api/warm` request also writes one row to `api_stats` after the response (timings
  per phase, mode, engine, candidate counts), and each `compare` check writes one row to
  `api_compare` (`match` / `mismatch` / `error`). Raw rows are kept 30 days (warm pings
  7), a daily rollup (`api_stats_daily`) is kept for good, and `compact_api_stats()`
  does the rollup and cleanup (called now and then from `/api/warm`). Example queries:
  `sql/stats/report.sql`.

## Project structure

See [`CLAUDE.md`](./CLAUDE.md) for a full architecture map, the auth model,
and notes on the Cloudinary → Backblaze B2 migration.

## Scripts

```bash
npm run dev     # start dev server
npm run build   # production build
npm run start   # run a production build
npm run lint    # next lint (no ESLint config exists yet, so it only offers to create one)
```

There is no automated test suite. Verify app changes with:

```bash
npx tsc --noEmit
npx next build
```

`next build` needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
to be set; placeholder values are enough to check that the build compiles.

Database-side checks live in `sql/` — see "Checking recall" above.

`scripts/hash_index_parity/` is a parity test for the in-memory engine; it needs a local
Postgres with pgvector and `npm install --no-save pg tsx` (neither is a project
dependency), see its README. It is excluded from `tsconfig.json`.

One-time migration scripts (Supabase Storage → IDrive e2: backfill, verify,
cleanup, orphan lookup, `VACUUM FULL`) live in `scripts/thumbnails_to_e2/` and
`sql/thumbnails_to_e2/` — see the README there for the runbook.
