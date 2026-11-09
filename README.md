# Photo Match

A private tool for matching a backlog of WhatsApp media exports against a
Google Photos library (and a partner's library) using perceptual-hash
similarity. Swipe through unmatched items, review ranked candidates, commit
or skip, undo if needed.

This is a personal, single-user app — not a general-purpose product. Auth is
locked to one hardcoded email address.

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
```

### Database setup

Run, in order, in the Supabase SQL editor:

1. `supabase-auth-setup.txt` — restricts new Supabase Auth sign-ups to a
   single allowed email
2. `supabase-rls-and-rpc.sql` — enables RLS, adds storage policies, and
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
| `20261031120000_search_modes_for_match_functions.sql` | Replaces the four `match_*` functions with the `p_mode` versions. Quick; safe anywhere, including an empty database. |
| `20261031120100_rebuild_hnsw_indexes.sql` | Rebuilds the four HNSW indexes with `m = 32, ef_construction = 200`. **Slow and write-blocking on a populated database.** |
| `20261031120200_fix_match_function_return_types.sql` | Fixes the first migration's functions, which failed on every call (a column-type mismatch, e.g. `duration` is `double precision`). Supersedes their definitions. Quick. |
| `20261103120000_normalize_columns_expand.sql` | Adds the normalized columns (`photo_id`, `lat`/`lon`, `width`/`height`, `*_id`, `quant_profile_id`) and the lookup tables with their RLS policies. Additive; the old columns keep working. See [Normalized columns](#normalized-columns). |
| `20261103120100_match_functions_read_normalized_columns.sql` | Rewrites the four `match_*` functions to read the normalized columns (and drops the legacy `filesize` output). |
| `20261106120000_rebuild_big_hnsw_indexes.sql` | Same idempotent function as `...120100`: rebuilds the two big HNSW indexes (`hashes`, `partner`) that were dropped during the normalization, skipping the ones already on `m = 32`. **Slow and write-blocking.** |

**Before the integration first applies these to production**, run the second
one by hand so it has nothing left to build (the integration then just
records it):

```bash
psql "<direct connection string, port 5432>" \
  -f supabase/migrations/20261031120100_rebuild_hnsw_indexes.sql
```

Pushing to the production branch is what triggers the integration to apply
pending migrations, so do this first. Things to know:

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
`exact`. Committing, skipping, undoing, or refreshing (↻) reloads the item at
`fast`; an escalated result is otherwise kept for the app's usual 30-second
cache, so stepping back to an item you just escalated shows it as you left it.

The measurements behind this, and the reasons for each design choice, are in
[`CLAUDE.md`](./CLAUDE.md) under "HNSW recall and search modes".

### Checking recall

`sql/hnsw_recall_tests.sql` compares `fast` and `wide` against `exact` on real
items from `wa`. Re-run it when the data has grown by a third or more, after a
bulk import, after rebuilding an index or upgrading pgvector, or whenever a
match you know exists isn't offered. (It's plain SQL — works in the SQL editor
or `psql`.)

## Project structure

See [`CLAUDE.md`](./CLAUDE.md) for a full architecture map, the auth model,
and notes on the Cloudinary → Backblaze B2 migration.

## Scripts

```bash
npm run dev     # start dev server
npm run build   # production build
npm run start   # run a production build
npm run lint    # next lint
```

There is no automated test suite. Verify app changes with:

```bash
npx tsc --noEmit
npx next build
```

Database-side checks live in `sql/` — see "Checking recall" above.

One-time migration scripts (Supabase Storage → IDrive e2: backfill, verify,
cleanup, `VACUUM FULL`) live in `scripts/thumbnails_to_e2/` and
`sql/thumbnails_to_e2/` — see the README there for the runbook.
