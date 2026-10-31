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
  queries), Storage (thumbnails), Auth (GitHub OAuth)
- **Backblaze B2** (S3-compatible API) — full-size original media previews
- **sharp** — server-side pixel-distance scoring
- Deployed on **Vercel**

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
  so a **preview branch** starts without them. Both migrations succeed there
  (the index one skips missing tables) but the branch can't run the app.
  `supabase db pull` would capture a baseline migration if you want branches
  to be usable.
- `supabase/config.toml` says `major_version = 17`; it should match your
  project's Postgres major version (`show server_version;`). It only matters
  for local development and branches.
- The app works with the migrations applied before or after it deploys: it
  only sends `p_mode` when you press the escalate button.

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
