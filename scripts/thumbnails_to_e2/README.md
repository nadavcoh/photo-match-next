# Thumbnails: Supabase Storage → IDrive e2

One-time migration of the ~253k thumbnail objects (~0.9 GB) out of Supabase
Storage. Why: `storage.objects` is 226 MB (table + indexes) of the ~397 MB
database. App and scraper code for e2 is already written (`src/lib/e2.ts`,
and `thumb_store.py` in the phash repo); these scripts move the existing data.

Key layout is unchanged: `{prefix}/{chunk:06d}/{prefix}_{id}.jpg`.

## Setup (once)

```bash
pip install -r requirements.txt
```

Settings come from a JSON file (`--config`) and/or environment variables. The
phash scrapers' `config.json` already has `DB_*`, `SUPABASE_URL` and
`SUPABASE_KEY` (service-role key); add the e2 keys to it:

```json
"E2_ENDPOINT": "https://<e2 endpoint>", "E2_REGION": "<region>",
"E2_ACCESS_KEY_ID": "...", "E2_SECRET_ACCESS_KEY": "...", "E2_BUCKET": "thumbnails"
```

Use a **read/write** e2 key here (and for the scrapers). The Vercel app gets a
separate **read-only** key.

## Runbook

1. **Trial.** `python backfill.py --config config.json --dry-run`, then
   `--limit 200`. Dry run only reads. The orphans it lists
   (`hashes_214548`, `partner_34734`, …) are objects with no DB row; they are
   never copied to e2. Add `--orphans-dir <folder>` to a real run to download
   them to your machine instead (keeps their key paths).
   `orphan_lookup.py` (read-only) then hashes each downloaded orphan and lists
   the closest rows in `hashes` / `partner` by Hamming distance, to see
   whether an orphan belongs to a row that still exists:
   `python orphan_lookup.py --config config.json --orphans-dir <folder>`
   (needs `imagehash`, `pillow`, `psycopg2-binary`; 0-4 bits = very likely the
   same item).
2. **Backfill.** `python backfill.py --config config.json`. Supabase is only
   read. Safe to re-run and to interrupt: it lists e2 first and copies only
   what is missing or has a different size. Failures go to
   `backfill_failed.txt`. It ends by verifying e2 against `storage.objects`;
   exit code 0 means every wanted object is in e2 with the right size.
3. **Cutover (hard cut).** Stop the scrapers. Set the `E2_*` env vars (read-only
   key) on the Vercel project and deploy the app commit; update the phash
   scrapers and add the `E2_*` keys to their `config.json`. Run `backfill.py`
   once more (delta pass for thumbnails written to Supabase in the meantime).
   Open the match page: thumbnails render, and the Vercel runtime logs show no
   `[e2]` errors.
4. **Rollback window.** The Supabase objects are untouched until step 5.
   Rollback = redeploy the previous Vercel deployment and revert the scrapers.
   Any scraper run from the old code after cutover writes to Supabase only;
   re-run `backfill.py` to pick those up.
5. **Cleanup (no way back).** `python cleanup.py --config config.json
   --orphans-dir <folder>` prints the plan and refuses to continue unless e2 is
   a complete copy and every orphan is already in that folder (or you pass
   `--discard-orphans`); add `--yes` to delete via the Storage API (this also
   removes the orphans from Supabase). Never delete with SQL on
   `storage.objects`.
6. **Reclaim the space.** Run `sql/thumbnails_to_e2/vacuum_full_storage_objects.sql`
   (three separate calls; a manual script, not a migration). The `postgres`
   role can do this because it holds MAINTAIN on `storage.objects`.
