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
                                 1-9=pick candidate N), prefetch-next-item cache.
src/components/WAMediaPreview.tsx
                               ← Full-size original media (photo/video) preview,
                                 shown only when item.filename starts with "Media".
                                 Fetches a signed URL from /api/media.

src/app/api/match/route.ts    ← GET: next unmatched wa item + hashes/partner
                                 candidates (via RPC) + pixel-distance scoring +
                                 auto-select id. This is the core business logic.
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
supabase-auth-setup.txt       ← DB trigger restricting auth.users to one email
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
- **Filesize** (`c.filesize` / `c.filesize_bytes`) — same absolute-threshold
  philosophy as resolution, applied to bytes instead of pixels
  (`filesizeVariant` in `page.tsx`). Prefers the exact `filesize_bytes`
  column (see migration below); falls back to parsing the legacy `filesize`
  text via `parseFileSizeBytes` for pre-migration rows where it's NULL:
  - Video: ≥8MB → green, ≥1MB → yellow, below → red.
  - Image: ≥2MB → green, ≥200KB → yellow, below → red.
  - These are a rough proxy for the same three tiers as resolution (full
    capture / WhatsApp HD / WhatsApp default), not a measured mapping —
    tune them if real files land somewhere unexpected. `partner` didn't
    select `filesize` at all until the technical-metadata migration below —
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

- **Q:N (`jpeg_quality`)** — `jpegQualityVariant`: ≥85 → green, ≥60 →
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
  (Display P3) is included in the "standard" primaries list alongside
  `bt709`/`smpte170m` — it's common on plain, non-HDR iPhone photos, not a
  wide-gamut/HDR signal on its own. Renders nothing when both inputs are
  NULL, rather than defaulting to "SDR" from missing data.
- **Color profile (`color_space` + `color_transfer`)** — `colorProfileInfo`:
  the everyday SD/HD baseline (`bt709`/`smpte170m` space with a
  `bt709`-style transfer — e.g. `"bt709/bt709"`, `"smpte170m/bt709"`) is
  yellow, not green — it's just standard, not exceptional. Green is
  reserved for a genuinely wide space paired with an HDR-style transfer
  (e.g. `"bt2020nc/arib-std-b67"` — BT.2020 + HLG). Red is for values that
  match neither list on either axis. Deliberately separate from the HDR
  badge above (different columns: `color_space`/`color_transfer` here vs.
  `bit_depth`/`color_primaries` there) — a file can land in either
  independently.
- **Color range (`color_range`)** — `colorRangeInfo`: `"pc"` (full 0-255) →
  green, `"tv"` (limited 16-235) → yellow (this is the default convention
  for most consumer video/JPEG, not a defect, hence yellow rather than
  red), anything else → red as an unrecognized value.

None of these have a `wa`-side reference to compare against (same
constraint as resolution/filesize above) — they're all absolute
judgment-call thresholds on the candidate's own value.

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
`thumb_hamming`. `hamming` (**H:**) is still computed and returned on every
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

## Things to double check before assuming they're still true

- The hardcoded allowed email (`Cohen.n@gmail.com`) in `middleware.ts` —
  confirm it's still current before changing auth behavior.
- `HAMMING_THRESHOLD` env var (default `10` if unset) governs match
  sensitivity in `/api/match` — ask before changing the default.
- This file may drift from the code over time. If something here
  contradicts what you read in the actual source, the source wins — update
  this file to match.

## Working conventions for this project

- Package modified/new files as a `tar.gz` archive when delivering changes
  rather than presenting individual files inline.
- No test suite exists; verify changes with `npx tsc --noEmit` and
  `npx next build` rather than assuming.
- Keep the inline-style, single-file-component conventions already in
  `page.tsx` unless explicitly asked to refactor.
