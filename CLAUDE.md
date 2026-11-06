# CLAUDE.md

Notes-to-self for future Claude sessions on `photo-match-next`. Read this
before making changes — it'll save a full re-read of the codebase.

## What this app is

A private, single-user Next.js tool for reconciling a backlog of WhatsApp
media exports (table `wa`) against a Google Photos library (`hashes`) and a
partner's library (`partner`), using perceptual-hash (pHash) similarity. The
user swipes through unmatched WA items one at a time, the app suggests
candidates ranked by Hamming distance / pixel distance, an auto-select
heuristic pre-picks the most likely match, and the user commits (or skips,
or undoes).

This is the Next.js rewrite of an earlier Flask app (`photo-match-pwa`,
mentioned in code comments) — most "port of X" comments refer to that.

It's a personal tool, not a product: hardcoded single-user auth, no tests,
inline styles everywhere (no CSS modules / styled-components), `page.tsx` is
one large 800-line client component. That's intentional for this project's
scope — don't "fix" it into a more conventional architecture unless asked.

## Stack

- **Next.js 15** (App Router, TypeScript, React 19) on **Vercel**
- **Supabase**: Postgres (with `pgvector` for Hamming-distance bit-string
  queries) + Storage (private bucket `thumbnails`) + Auth (GitHub OAuth)
- **Backblaze B2** (S3-compatible API) for full-size original WhatsApp media
  previews — see "Cloudinary → B2 migration" below
- **sharp** for server-side pixel-distance scoring (auto-select fallback)
- No ORM — raw `@supabase/supabase-js` `.from()` calls + 4 hand-written
  Postgres RPC functions for the pgvector queries (see
  `supabase-rls-and-rpc.sql`)

## Architecture map

```
src/app/page.tsx              ← THE app. One big client component (~800 lines):
                                 toasts, candidate grid, settings panel, keyboard
                                 shortcuts (←/→/n/p, Enter/c=commit, r=refresh,
                                 e=search wider, 1-9=pick candidate N),
                                 prefetch-next-item cache, and the "Search
                                 wider" escalate button (fast → wide → exact).
src/components/WAMediaPreview.tsx
                               ← Full-size original media (photo/video) preview,
                                 shown only when item.filename starts with "Media".
                                 Fetches a signed URL from /api/media.

src/app/api/match/route.ts    ← GET: next unmatched wa item + hashes/partner
                                 candidates (via RPC) + pixel-distance scoring +
                                 auto-select id. This is the core business logic.
                                 `?offset=N` picks the item; `?mode=fast|wide|exact`
                                 picks the search depth (default fast).
src/app/api/match/commit/route.ts   ← POST: set wa.id_hash (or mark processed)
src/app/api/match/skip/route.ts     ← POST: mark wa.processed = true
src/app/api/match/undo/route.ts     ← POST: revert last commit/skip
src/app/api/media/route.ts    ← POST: { filename } → signed B2 GET URL for the
                                 full-size original (see lib/b2.ts)
src/app/api/health/route.ts   ← GET: liveness check (polled every 30s client-side)
src/app/api/version/route.ts  ← GET: git SHA / Vercel commit SHA, for Settings panel

src/lib/types.ts              ← All shared request/response shapes
src/lib/thumbnails.ts         ← Deterministic Supabase Storage path builder for
                                 small JPEG thumbnails (wa/hashes/partner buckets)
src/lib/pixelDistance.ts      ← sharp-based MAE pixel distance + fallback auto-select
src/lib/b2.ts                 ← Backblaze B2 (S3-compatible) signed-URL helper for
                                 full-size original media (NOT thumbnails)
src/lib/supabase-client.ts    ← Browser Supabase client (anon key)
src/lib/supabase-server.ts    ← Server Supabase client (SSR cookies, Route Handlers)
src/middleware.ts             ← Supabase session auth + hardcoded email allowlist

src/app/login/page.tsx        ← "Sign in with GitHub" button
src/app/auth/callback/route.ts← OAuth code → session exchange

supabase-rls-and-rpc.sql      ← RLS policies + the 4 match_*_image/video() RPCs
                                 (each with a p_mode: fast | wide | exact)
supabase-auth-setup.txt       ← DB trigger restricting auth.users to one email
supabase/config.toml          ← Standard `supabase init` output; makes the repo usable by
                                 the Supabase CLI / GitHub integration
supabase/migrations/20261031120000_search_modes_for_match_functions.sql
                               ← Same functions as above, as a migration for an existing
                                 DB (generated from one source — keep the two in sync if
                                 you edit either). Quick, safe on an empty DB.
supabase/migrations/20261031120200_fix_match_function_return_types.sql
                               ← Supersedes the function definitions in ...120000 (those
                                 failed on every call — see "explicit casts" below).
                                 Same text as supabase-rls-and-rpc.sql Part 4/5.
supabase/migrations/20261031120100_rebuild_hnsw_indexes.sql
                               ← (Re)builds the 4 HNSW indexes with m=32,
                                 ef_construction=200. Pure SQL, idempotent, skips
                                 tables that don't exist and indexes already done.
                                 SLOW on prod — run via psql first (see header).
supabase/migrations/20261106120000_rebuild_big_hnsw_indexes.sql
                               ← Same idempotent function as ...120100, as a new migration:
                                 rebuilds the two big HNSW indexes dropped for the
                                 normalized-columns work (the other two are skipped).
supabase/migrations/20261103120000_normalize_columns_expand.sql
                               ← DDL for the normalized columns (lookup tables, new
                                 columns, URL builders) — see "Normalized columns".
supabase/migrations/20261103120100_match_functions_read_normalized_columns.sql
                               ← Supersedes ...120200: match_* rebuild url/size/location/
                                 origin/... from the normalized columns and no longer
                                 return `filesize`. Same text as supabase-rls-and-rpc.sql
                                 Part 4/5.
sql/normalize_columns/        ← Runbook (README.md) + manual psql scripts for that
                                 change: backfill, contract (drops old columns),
                                 VACUUM FULL. Deliberately not in supabase/migrations.
sql/hnsw_recall_tests.sql     ← Recall/latency/behaviour checks for the match_* RPCs
                                 (a test, not a migration — deliberately not in
                                 supabase/migrations)
```

### Two completely separate "media" concepts — don't conflate them

1. **Thumbnails** (`src/lib/thumbnails.ts`) — small JPEGs in Supabase Storage
   bucket `thumbnails`, path convention `{prefix}/{chunkDir}/{prefix}_{id}.jpg`.
   Used for the candidate grid + pixel-distance scoring. Browser fetches these
   directly via `supabase.storage.createSignedUrl()` in the `SignedImage`
   component (`page.tsx`) — no API route involved.
2. **Full-size original media** (`src/lib/b2.ts` + `/api/media`) — the actual
   synced WhatsApp photo/video, shown in `WAMediaPreview` below the item card,
   only when `filename` starts with `"Media"`. This is what migrated from
   Cloudinary to Backblaze B2.

## Auth model

Single allowed user, hardcoded email `Cohen.n@gmail.com` in **three** places
that all need to stay in sync if it ever changes:
- `src/middleware.ts` (`ALLOWED_EMAIL`) — blocks every request
- `supabase-auth-setup.txt` — DB trigger blocks the email from ever signing up
- (the GitHub OAuth app itself has no allowlist — anyone can attempt sign-in,
  middleware + DB trigger are what actually gate access)

No service-role key is used anywhere (by design — see git history /
code comments about its removal). All DB and Storage access goes through
the authenticated user's JWT, with RLS policies in `supabase-rls-and-rpc.sql`
granting the `authenticated` role full CRUD on `wa` and read-only on
`hashes`/`partner`.

## Cloudinary → Backblaze B2 migration (done — see below)

**Status: migrated.** The app used to fetch full-size WhatsApp media previews
from Cloudinary; it now fetches them from Backblaze B2. If you're reading
this before doing that migration, it's already done — check git log /
just re-read `src/lib/b2.ts`.

What changed:
- Deleted `src/lib/cloudinary-search.ts`, `src/app/api/cloudinary/media/route.ts`,
  `src/app/api/cloudinary/sign/route.ts` (the last one was already dead code —
  not called from any client). Removed `cloudinary` and `next-cloudinary`
  (also unused — no `CldImage`/`CldVideoPlayer` anywhere) from `package.json`.
- Added `src/lib/b2.ts` (S3-compatible client + key-builder + presigned-URL
  helper) and `src/app/api/media/route.ts` (replaces `/api/cloudinary/media`).
  Added `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`.
- Updated `WAMediaPreview.tsx` to call `/api/media` and drop the now-unused
  `resourceType` field in the request body.

**Why this was a net simplification, not just a swap:** Cloudinary's old
"Dynamic Folders" sync mode assigned every asset a random Base64 `public_id`,
so the old code needed a rate-limited Search API call (cached via
`unstable_cache`, `revalidate: false`) just to translate a known filename
into Cloudinary's internal id before it could even sign a URL. B2 object
keys are just the literal path — **as long as the upload/sync pipeline
preserves the original `wa.filename` relative path as the B2 key**, the new
route builds the key with one string concatenation. No search, no cache
layer, no Cloudinary Search API quota to worry about.

**What was lost:** Cloudinary applied an on-the-fly resize
(`crop:'limit', width:960`) to every served image. B2 has no transform
pipeline, so `/api/media` now serves the original file as-is —
`WAMediaPreview` already renders at `width:100%; height:auto` so this is a
bandwidth/cost concern, not a correctness one. If it matters, resize at
upload time in the sync pipeline, or add a `sharp`-based resize step in the
route (sharp is already a dependency — see `pixelDistance.ts`).

**Required env vars** (replace the old `CLOUDINARY_*` ones, which can be
deleted from Vercel project settings):
```
B2_APPLICATION_KEY_ID   # from a B2 Application Key — NOT the master key
B2_APPLICATION_KEY      # the matching secret
B2_BUCKET_NAME          # bucket holding the synced "Media/..." files
B2_ENDPOINT             # e.g. https://s3.us-west-004.backblazeb2.com
B2_REGION               # e.g. us-west-004 — must match the bucket's region
B2_MEDIA_PREFIX         # optional. Set only if files live under a folder
                        # rather than at bucket root (mirrors the old
                        # gphoto_phash_media/ Cloudinary root folder).
```

**Pending action item for the user:** the actual media files need to exist
in the B2 bucket at the right keys (`{B2_MEDIA_PREFIX}/{wa.filename}`) for
this to work — this migration only changes how the app *reads* media, not
how/whether it got uploaded to B2 in the first place. If there's a separate
sync script (akin to whatever ran `cloudinary sync -O type authenticated`
before), it needs to be repointed at B2.

## Known dead/legacy bits worth knowing about

- `WAMediaPreviewProps.path` — explicitly marked unused in a comment
  ("the full relative path is encoded in filename itself"). Still passed
  in some callers maybe; harmless to leave, fine to remove if touching that
  component anyway.
- `next.config.ts` comment says thumbnails are "served via our own
  `/api/thumbnail` proxy" — that's stale. Thumbnails are fetched directly
  from Supabase Storage via signed URLs now (see `SignedImage` in
  `page.tsx`); there is no `/api/thumbnail` route in this codebase.

## Duration/resolution/filesize badges: `wa` schema constrains what's possible

`wa`'s actual columns (confirmed from `table_wa.txt`): `id`, `filename`,
`timestamp`, `id_hash`, `processed`, `filetype`, `duration`, `hash_bit`,
`video_thumb_hash_bit`. **No `size` or `filesize` column** — so there's no
`wa`-side reference value to compare a candidate's resolution or file size
against. This shapes the three badges differently:

- **⏱ Duration** — `wa.duration` exists, so this stays a relative
  comparison: `closenessVariant(c.duration, waDuration)` in `page.tsx`
  (green within 5%, yellow within 25%, red beyond, grey if either side is
  missing).
- **Resolution** (`c.size`, e.g. `"1920x1080"`) — no `wa` reference
  available, so this uses **absolute** thresholds instead
  (`resolutionVariant` in `page.tsx`):
  - Video, by short side (orientation-independent): ≥1080px → green
    (1080p+), ≥720px → yellow (720p), below → red (<720p).
  - Image, by total megapixels: ≥8MP → green (full smartphone-camera
    resolution), ≥1.5MP → yellow (WhatsApp "HD" quality range), below →
    red (WhatsApp default/low-res compression).
  - These cutoffs are a judgment call, not a spec from WhatsApp/phone
    vendors — tune the constants in `resolutionVariant` if real-world
    candidates cluster differently.
- **Filesize** (`c.filesize_bytes`) — same absolute-threshold
  philosophy as resolution, applied to bytes instead of pixels
  (`filesizeVariant` in `page.tsx`). `filesize_bytes` is the only file-size
  field: the legacy `filesize` text column was merged into it (see "Normalized
  columns" below), so there is no text fallback any more:
  - Video: ≥8MB → green, ≥1MB → yellow, below → red.
  - Image: ≥2MB → green, ≥200KB → yellow, below → red.
  - These are a rough proxy for the same three tiers as resolution (full
    capture / WhatsApp HD / WhatsApp default), not a measured mapping —
    tune them if real files land somewhere unexpected. `partner` didn't
    select a file size at all until the technical-metadata migration below —
    see that section for what's now available on both tables.

`WAItemCard` only ever shows `wa`'s own `duration` badge (uncolored, it's
the reference point) — no size/filesize badges there since `wa` has neither
column.

## Technical/codec metadata badges (migration_technical_metadata.sql)

Source: `frontend_changes.md` (from the `phash` repo). Adds 8 new columns to
both `hashes` and `partner` — all `NULL` on rows inserted before the
migration, and the four JPEG-only fields are `NULL` on any non-JPEG file.
`jpeg_quant_tables` (raw per-row DQT arrays) is deliberately **not**
selected by any RPC — nothing in the UI needs the raw table, only the
derived `jpeg_quality` estimate; shipping it would be a lot of JSON for no
display purpose.

All four RPC functions (`match_hashes_image/video`, `match_partner_image/
video` in `supabase-rls-and-rpc.sql`) now return the other 7 columns as a
plain passthrough. This required a `DROP FUNCTION` before each
`CREATE OR REPLACE` — Postgres treats an added output column as a return-
type change, which `CREATE OR REPLACE` alone refuses to do — so **re-run
`supabase-rls-and-rpc.sql`** to pick this up.

Badges added to `CandidateCard` (`page.tsx`), all with a 3-tier good/ok/bad
judgment call — tune if real data clusters differently than guessed here:

- **Q:N (`jpeg_quality`)** — `jpegQualityVariant`: ≥85 → green, ≥65 →
  yellow, below → red. JPEG only; badge doesn't render for other formats.
- **Chroma subsampling (`pixel_format`)** — `chromaInfo` derives a label
  from ffprobe's raw `pix_fmt` (no column stores this pre-formatted): 4:4:4
  → green, 4:2:2 → yellow, 4:2:0 → yellow. Note both 4:2:2 and 4:2:0 land on
  yellow now — 4:2:0 being anything other than green does **not** mean
  something's wrong, it's the near-universal default for consumer
  photos/video, not a defect. Unrecognized `pix_fmt` values are shown
  as-is, uncolored.
- **HDR/wide-gamut (`bit_depth` + `color_primaries`)** — `hdrInfo`: flags
  "HDR" (green — a genuine step up) only when both a >8-bit depth AND
  non-standard primaries line up together; "SDR" (yellow — the ordinary
  baseline, not something to celebrate) when neither does; a middle
  "N-bit" or bare primaries-name (also yellow) when only one signal fires,
  since either alone is a weak/noisy indicator on its own. `smpte432`
  (Display P3) and `bt470bg` (PAL/SECAM) are included in the "standard"
  primaries list alongside `bt709`/`smpte170m` — common, ordinary values
  that shouldn't trip the wide-gamut/HDR flag on their own. Renders
  nothing when both inputs are NULL, rather than defaulting to "SDR" from
  missing data.
- **Color profile (`color_space` + `color_transfer`)** — `colorProfileInfo`:
  the everyday SD/HD baseline (`bt709`/`smpte170m`/`bt470bg` space with a
  `bt709`/`smpte170m`-style transfer — e.g. `"bt709/bt709"`,
  `"smpte170m/bt709"`, `"bt470bg/smpte170m"`) is yellow, not green — it's
  just standard, not exceptional. Green is reserved for a genuinely wide
  space paired with an HDR-style transfer (e.g. `"bt2020nc/arib-std-b67"` —
  BT.2020 + HLG). Red is for values that match neither list on either axis.
  Deliberately separate from the HDR badge above (different columns:
  `color_space`/`color_transfer` here vs. `bit_depth`/`color_primaries`
  there) — a file can land in either independently.
- **Color range (`color_range`)** — `colorRangeInfo`: `"pc"` (full 0-255) →
  green, `"tv"` (limited 16-235) → yellow (this is the default convention
  for most consumer video/JPEG, not a defect, hence yellow rather than
  red), anything else → red as an unrecognized value.

None of these have a `wa`-side reference to compare against (same
constraint as resolution/filesize above) — they're all absolute
judgment-call thresholds on the candidate's own value.

**Partner and hashes badges are guaranteed identical by construction**, not
by coincidence: `HashCandidate`/`PartnerCandidate` both extend the same
`TechnicalMetadata` interface, `technicalMetadataFrom()` in `route.ts` maps
both RPC row shapes through identical field names, and `CandidateCard`
renders every technical/duration/resolution/filesize badge off `c.<field>`
with no source-specific branching — the only conditionally-rendered fields
are the ones that are genuinely source-specific (`origin`, `camera_name`,
`location` only exist on `HashCandidate`; there's no partner equivalent in
the schema, not a UI oversight).

## Video hashing: two independent hash spaces, never cross-compared

Video hashing uses two different sources, and each side of a comparison must
be the *same* hash type — never mix them:

- `hash_bit` — whole-video hash from the `videohash2` Python package.
  Imperfect on its own (source of the second hash below).
- `video_thumb_hash_bit` — `imagehash` hash of the video's first frame.

Both `wa` and `hashes`/`partner` store both columns for genuine video rows.
`match_hashes_video`/`match_partner_video` (in `supabase-rls-and-rpc.sql`)
compare `wa.hash_bit` only to the candidate's `hash_bit` (**H:** badge), and
`wa.video_thumb_hash_bit` only to the candidate's `video_thumb_hash_bit`
(**T:** badge) — two separate distances, never crossed.

**Candidate search uses `thumb_hamming` only.** `hash_bit` (videohash2) isn't
reliable enough on its own to drive candidate selection or thresholding, so
it plays no part in either the top-50 candidate-widening query or the
`<= HAMMING_THRESHOLD` filter — a candidate is kept purely on
`thumb_hamming`. (In `exact` mode that two-branch widening is replaced by one
full scan comparing `COALESCE(video_thumb_hash_bit, hash_bit)` to the thumb
hash, capped at the 50 closest rows overall instead of 50 per branch — same
rule, applied to every row. See the next section.) `hamming` (**H:**) is still computed and returned on every
row that has it (for display / manual judgment), it just never decides
whether a row appears at all.

**Edge case — GIFs:** an animated GIF lives in `hashes`/`partner` as a plain
image row (`imagehash` of frame 1, `video_thumb_hash_bit` is NULL), but gets
transcoded to MP4 on the `wa` side. There's no dedicated GIF handling — when
a candidate row has no `video_thumb_hash_bit`, its `hash_bit` is treated as
directly comparable to `wa.video_thumb_hash_bit` (both are "first frame"
hashes) and reported as `thumb_hamming`/**T:**. `hamming`/**H:** is NULL for
these rows since there's no video hash on that side to compare.

`page.tsx`'s `CandidateCard` colors **H:** with the full 3-tier good/ok/bad
`hammingClass()` for both images and videos — it's only ever populated for a
genuine same-hash-type comparison (video-to-video or image-to-image), so the
usual scale applies. **T:** (first-frame hash) keeps the simpler 2-tier
green/grey `lowDistanceVariant` for video candidates, since it can be either
a true thumb-to-thumb comparison or the GIF-as-image fallback, and those
aren't calibrated the same way. Image candidates never show T:.

## HNSW recall and search modes (added Oct 2026)

**The bug this fixed.** The `match_*` functions used to filter with
`WHERE hash_bit <~> q <= threshold ORDER BY hash_bit <~> q LIMIT 50`. The
`ORDER BY` lets the planner use the HNSW index, but HNSW returns only about
`hnsw.ef_search` (default 40) nearest candidates and the `WHERE` is applied
*afterwards* to those. When none of the 40 clears the threshold, you get zero
rows — silently, no error — even if exact matches exist. It was found on a
real item whose two distance-0 matches in `hashes` were never returned while
`partner` found its match. Which plan the planner picks varies, so the failure
was intermittent and invisible: "no candidates" looked the same as "no match".

**What was measured** (one Supabase instance, `hashes` ≈ 153k rows with ~8%
duplicate hashes, `partner` ≈ 86k rows; numbers will drift as data grows):

| | Misses |
|---|---|
| Old index (m=16, ef_construction=64), synthetic queries, ef_search 40 | 18 of 323 queries |
| Rebuilt (m=32, ef_construction=200), synthetic, ef_search 40 | 1 of 643 |
| Rebuilt, synthetic, ef_search 400 | 0 of 305 |
| Rebuilt, **real `wa` queries**, ef_search 40 | 6 of 1,000 queries (18 of 5,720 matches) |
| Rebuilt, **real `wa` queries**, ef_search 400 | 0 of 400 (2,066 matches) |

"Synthetic" = rows from `hashes` with ~8 random bits flipped. The rebuild
helped far more on synthetic queries than on real ones; `ef_search = 400` is
what removed the remaining misses on real data. Warm latency on `hashes`:
fast ≈ 3 ms, wide ≈ 21 ms (13–74 ms seen), exact ≈ 35 ms; exact on `partner`
≈ 15 ms. The very first `partner` exact run took ~1.5 s versus ~15 ms on the
next three (cause not established — don't read much into a single slow call).

**The design.**
- Three modes, chosen per call via the optional `p_mode` argument of each
  `match_*` function: `fast` (ef_search 40, the default), `wide` (400),
  `exact` (no index). All four HNSW indexes are built with `m = 32,
  ef_construction = 200`.
- The UI starts every item on `fast`. The **Search wider** button (key `e`)
  re-runs the *same offset* at `wide`, then `exact`. The API echoes
  `search_mode` in the response, and the UI derives its current level from
  that — so cached data carries its own level. Anything that fetches an item
  fresh (commit, skip, undo, ↻, or navigating to an uncached offset) starts on
  `fast`; an escalated result stays in the 30 s cache like any other and is
  shown as the user left it. Prefetch (offset + 1) is always `fast`.
- Why not just always use `exact`? It's ~35 ms and can't miss, and was the
  simplest option; the escalation design was chosen instead to keep `fast`
  quick for the common case. If maintaining it becomes a chore, switching the
  default to `exact` is a one-line change in `route.ts` (`parseMode`) plus
  dropping the HNSW indexes.

**How it's wired — things not to "simplify".**
- The functions are `plpgsql`, not `sql`, so they can call
  `set_config('hnsw.ef_search', …, true)` (transaction-local, so it can't leak
  across pooled connections). Both `fast` and `wide` set it explicitly, so
  `fast` never inherits a wider value. Because of `set_config` they are
  `VOLATILE`, not `STABLE`.
- `#variable_conflict use_column` is required: `RETURNS TABLE` columns are
  plpgsql variables and unqualified `id`, `filename`, … would otherwise be
  "ambiguous".
- **Every output column is explicitly cast to its declared type**
  (`a.duration::integer AS duration`, …). plpgsql's `RETURN QUERY` needs an
  exact type match; the old `LANGUAGE sql` functions applied assignment casts,
  so they tolerated tables whose types differ from the declarations — and
  production's do (`hashes.duration` is `double precision`). The first version
  of the new functions omitted the casts and failed on every call in every
  mode ("structure of query does not match function result type"); because
  `fast` swallows RPC errors the app just showed "no candidates". Fixed by
  migration `…120200`. float → integer rounds, as before. Don't drop the casts.
- `SET plan_cache_mode = force_custom_plan` keeps the planner choosing the HNSW
  index from the real parameter values on every call.
- The `exact` branches use `OFFSET 0` as an optimisation fence. Without it the
  planner can push the `ORDER BY` into the HNSW index and the filter stops
  being exact. Verified plan: Seq Scan + Sort.
- `route.ts` only sends `p_mode` when it isn't `fast` (`withMode`), so the app
  keeps working against a database that hasn't had the migration yet. RPC
  errors used to be swallowed into an empty list; they're now logged, and in
  `wide`/`exact` they're thrown so the user isn't told "nothing found" by a
  search that never ran.
- The old overloads `(text, integer)` / `(text, text, integer)` must be dropped
  (the migration and `supabase-rls-and-rpc.sql` both do this): left in place, a call without `p_mode` would be
  ambiguous.

**Operational notes.**
- Index builds must run from `psql` over a direct/session connection (port
  5432), with `max_parallel_maintenance_workers = 0` and `statement_timeout =
  0`. In the SQL editor they fail three ways we hit: shared-memory error from
  the parallel build, the statement timeout, and "Failed to fetch" when the
  browser connection drops (the build kept running server-side).
- `supabase/migrations/20261031120100_rebuild_hnsw_indexes.sql` builds `_idx2`
  indexes next to the old ones and swaps them in per index; re-running it
  rebuilds nothing. It's plain SQL so the Supabase CLI/GitHub integration can
  apply it, but it runs the whole file at once with the runner's own limits,
  so on a populated database run it via `psql -f` first (the integration then
  finds nothing left to build). Pushing to the production branch is what makes
  the integration apply pending migrations — do the psql step before that.
- No `CREATE INDEX CONCURRENTLY` (can't run in a transaction); the brief write
  lock is accepted for this single-user app.
- **Re-run `sql/hnsw_recall_tests.sql` (Part 1) when the data has grown by
  ~25–50%, after a bulk import, after any index rebuild or pgvector upgrade,
  after changing `HAMMING_THRESHOLD`, or when a known match goes missing.**
  Target: `wide_miss_q = 0`. If `wide` ever misses, raise the 400 (cap 1000)
  in the SQL or make `exact` the default.
- pgvector's iterative scans (`hnsw.iterative_scan`) were tried and rejected:
  `strict_order` still missed; `relaxed_order` found the matches but was no
  faster than `exact`.
- Known weak spot, untested: in `fast`/`wide` the video functions' second
  candidate branch filters `video_thumb_hash_bit IS NULL` *after* an HNSW scan
  on `hash_bit`, so video rows can use up candidate slots. `exact` avoids it.
- The SQL was validated on scratch Postgres 16 + pgvector 0.8.0 databases with
  synthetic data (modes behave as described, `exact` returns exactly the
  brute-force result set), not against the production instance. **The scratch
  tables must use column types that differ from the function declarations**
  (e.g. `duration double precision`, `id bigint`, `varchar` text columns) —
  the first version passed on a scratch DB whose types matched exactly and
  then failed in production. After applying any function change there, run
  `sql/hnsw_recall_tests.sql` Part 4d (smoke test) and Part 1 (recall).

## Things to double check before assuming they're still true

- The hardcoded allowed email (`Cohen.n@gmail.com`) in `middleware.ts` —
  confirm it's still current before changing auth behavior.
- `HAMMING_THRESHOLD` env var (default `10` if unset) governs match
  sensitivity in `/api/match` — ask before changing the default. Changing it
  changes HNSW recall too: re-run `sql/hnsw_recall_tests.sql` (its threshold is
  hardcoded as `10`).
- The `fast`/`wide` search widths (40 / 400) are hardcoded in the SQL
  functions, not env vars.
- This file may drift from the code over time. If something here
  contradicts what you read in the actual source, the source wins — update
  this file to match.

## Working conventions for this project

- Package modified/new files as a `tar.gz` archive when delivering changes
  rather than presenting individual files inline.
- Schema/function changes go in `supabase/migrations/<YYYYMMDDHHMMSS>_name.sql`:
  plain SQL, idempotent, no `psql` meta-commands (`\set`, `\gexec`, …), and
  keep `supabase-rls-and-rpc.sql` in sync for fresh installs. Never edit a
  migration that may already have been applied — add a new one (that's why
  `…120200` exists). Test a migration
  with the real runner before committing: `supabase db push --db-url
  postgresql://…?sslmode=disable` against a scratch database (this is how the
  HNSW migrations were verified).
- No test suite exists; verify changes with `npx tsc --noEmit` and
  `npx next build` rather than assuming.
- Keep the inline-style, single-file-component conventions already in
  `page.tsx` unless explicitly asked to refactor.

## Normalized columns (database-size reduction)

`hashes`/`partner` used to store several values as bulky text. They are now
stored compactly and **rebuilt by the `match_*` functions**, so the JSON the
app receives is unchanged — with one exception: `filesize` (text) no longer
exists in the RPC output, types or UI.

| Was (text/jsonb) | Now | Rebuilt as |
|---|---|---|
| `url` | `photo_id` (NOT NULL, `^[A-Za-z0-9_-]+$`) | `gphoto_photo_url()` / `gphoto_partner_photo_url()` |
| `location` (maps URL) | `lat`, `lon` (`float8`) | `gphoto_location_url(lat, lon)` |
| `size` ("W × H") | `width`, `height` (`int4`) | `width || ' × ' || height` |
| `origin`, `camera_name`, `location_name` | `origin_id`, `camera_name_id`, `location_name_id` → `origins`, `camera_names`, `location_names` | scalar sub-selects |
| `jpeg_quant_tables` (~1.5 KB jsonb/row) | `quant_profile_id` → `jpeg_quant_profiles` (keyed by md5 of the jsonb; not exposed via RLS) | not returned |
| `filesize` (text) | merged into `filesize_bytes` | — |

Things to remember:
- **Current state (2026-11-06).** The column normalization is finished on the
  live DB (runbook steps 0–6): the old columns are dropped (contract), both
  tables were `VACUUM FULL`ed, and the two big HNSW indexes were rebuilt by
  migration `20261106120000_rebuild_big_hnsw_indexes.sql` (m = 32,
  ef_construction = 200). Database size: ~420 MB before, 288 MB with the big
  indexes dropped, ~397 MB with them back — the net saving of this work is
  small. The big remaining item is moving thumbnails out of Supabase Storage
  (`storage.objects`, roughly 215–275 MB); not started. After the rebuild,
  Part 1 of `sql/hnsw_recall_tests.sql` showed zero misses for `fast` and
  `wide` against `exact` in all four tests (200 samples each); Parts 2–3 were
  not re-run. The deployed match route served requests without errors after the
  contract. The webos TV app must be redeployed from the commit that reads the
  normalized columns: its GitHub Action failed on 2026-11-06 because the TV was
  unreachable, and until it runs the old build can't read locations.
- **`filesize_bytes` is mixed precision.** Rows scraped after the technical-
  metadata migration have the exact on-disk size; older rows were back-filled
  by parsing Google Photos' display text with decimal units (KB = 1000), i.e.
  display precision. For MB-sized files Google's "backed up" size also often
  differs from the downloaded file. Fine for the good/ok/bad badge tiers; do
  not treat it as exact.
- The partner-library id is hard-coded in `gphoto_partner_photo_url()` (and in
  `partner.py`). A URL for any other library is refused by the scraper.
- The lookup tables need the authenticated SELECT policy (the functions are
  SECURITY INVOKER). `jpeg_quant_profiles` deliberately has none.
- Inserts without a valid `photo_id` are rejected by the database
  (`NOT NULL` + `CHECK`) once the contract step has run; the scrapers also
  validate before inserting.
- A table rewrite (`VACUUM FULL`, or any `ALTER` that rewrites) rebuilds the
  HNSW indexes. Updating every row without dropping them first is slow
  (≈3 ms/row per HNSW index on a 15k-row copy). See
  `sql/normalize_columns/README.md` for the procedure that was used.
