# Column normalization — changes for three repos

> **Status (2026-11-06): every step below has been carried out, except installing
> the webos build on the TV** (the code is on `main`; its deploy run failed because
> the TV was unreachable and still needs a re-run). These are the
> original hand-off notes (2026-11-03) for rolling the column normalization out
> across `photo-match-next`, `webos-local-slideshow` and the private `phash`
> repo; kept for context. The tarball they mention is not in this repo, and the
> phash patch script (`apply_normalize_patch.py`) was never committed: the phash
> changes were applied by hand (phash commit `675547e`). For the migration order
> that was actually followed, see [`README.md`](./README.md) in this folder.

Unpack next to your checkouts, or copy the folders over them:

    tar -xzf normalize-columns.tar.gz        # creates photo-match-next/, webos-local-slideshow/, phash/

## photo-match-next  (new + modified files, drop-in)
- NEW  supabase/migrations/20261103120000_normalize_columns_expand.sql   (DDL only, instant)
- NEW  supabase/migrations/20261103120100_match_functions_read_normalized_columns.sql  (guarded: fails until the backfill is done)
- NEW  sql/normalize_columns/{README.md, 0_drop_big_hnsw_indexes.sql, 1_backfill.sql, 2_contract.sql, 3_vacuum_full.sql}
- MOD  src/app/api/match/route.ts, src/lib/types.ts, src/app/page.tsx   (legacy `filesize` removed)
- MOD  supabase-rls-and-rpc.sql, CLAUDE.md
Follow sql/normalize_columns/README.md for the order. Do NOT merge 2_contract.sql into migrations/.

## webos-local-slideshow  (modified files, drop-in)
- src/app.js, server/photo_serve.py, server/photo_serve_dryrun.py, README.md
Deploy these BEFORE running the contract step (the TV reads hashes.lat/lon and location_names).

## phash  (private repo — patch script, run from the repo root)
    copy gphoto_normalize.py and apply_normalize_patch.py into the repo root
    python apply_normalize_patch.py --dry-run
    python apply_normalize_patch.py
Patches gphoto_selenium_v2.py, partner.py, album_wa.py and appends to CLAUDE.md.
All-or-nothing: aborts without writing if any expected text isn't found exactly once.
