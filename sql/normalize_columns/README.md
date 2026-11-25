# Normalize hashes/partner columns — runbook

Shrinks the database by storing `url`, `location`, `size`, `origin`,
`camera_name`, `location_name`, `jpeg_quant_tables` and `filesize` compactly
(see CLAUDE.md, "Normalized columns"). All SQL below was tested end to end on a
production-shaped scratch Postgres 16 + pgvector 0.8 (15k/8.6k rows, same
indexes): the match_* output is identical row for row (3,702 rows compared)
except `filesize` (removed) and `filesize_bytes` (back-filled).

Use a **direct** connection (not the pooler) for the psql steps.

**Status: finished** on the live database (contract and `VACUUM FULL` on 2026-11-06).
This file is kept as the record of the procedure, for the next column change that
needs the same expand → backfill → contract shape.

Two things that bit during the rollout:

- **Stuck sessions block the DDL.** `DROP INDEX` (step 0), the contract (step 4) and
  `VACUUM FULL` (step 5) wait for an exclusive lock, and a scraper connection left
  `idle in transaction` holds a share lock on `hashes`/`partner`, so the statement
  ran into the statement timeout. Check first:
  `select pid, state, now() - xact_start as age, left(query, 60) from pg_stat_activity where state like 'idle in transaction%';`
  and terminate (or close) what shows up. The scrapers were fixed later (phash
  `CLAUDE.md`).
- **`\b` is a backspace in Postgres regexes, not a word boundary; use `\y`.** The
  first file-size parser used `\b` and silently parsed nothing; the verification
  block at the end of `1_backfill.sql` is what caught it. Keep a check like that in
  any similar backfill.

| # | What | How | Reversible? |
|---|------|-----|-------------|
| 0 | Drop the two big HNSW indexes (recommended; makes step 2 seconds instead of ~15-20 min) | `psql -f sql/normalize_columns/0_drop_big_hnsw_indexes.sql` | yes — rebuilt in step 6 |
| 1 | Expand: functions, lookup tables, new columns (instant, additive) | merge migration `20261103120000_normalize_columns_expand.sql` (or `psql -1 -f` it) | yes |
| 2 | Backfill + verification (aborts and rolls back if any row does not reconstruct exactly) | `psql -v ON_ERROR_STOP=1 -1 -f sql/normalize_columns/1_backfill.sql` | yes |
| 3 | match_* functions read the new columns; app types/route/page drop `filesize` | merge migration `20261103120100_…` (has a guard: fails until step 2 is done) + deploy the app | yes |
| — | Deploy: webos-local-slideshow (TV app + LAN server), phash scrapers. Confirm the match UI and the TV both look right. | see those repos | — |
| 4 | Contract: drop the old columns, add NOT NULL/CHECK on `photo_id` | re-run `1_backfill.sql`, then `psql -v ON_ERROR_STOP=1 -1 -f sql/normalize_columns/2_contract.sql` | **no** |
| 5 | Return the space: `VACUUM FULL` both tables (exclusive lock; app idle) | `psql -f sql/normalize_columns/3_vacuum_full.sql` (plain psql, not `-1`) | — |
| 6 | Rebuild the HNSW indexes (skip if you skipped step 0) | merge migration `20261106120000_rebuild_big_hnsw_indexes.sql` (or `psql -f` it first; the older `20261031120100` file is already in the migration history) — builds any missing one with m=32, ef_construction=200 | — |
| 7 | Re-run Part 1 of `sql/hnsw_recall_tests.sql` (indexes were rebuilt) | SQL editor / psql | — |

Between steps 1 and 4 an **old** scraper still works for inserts, but the rows it
inserts have no `photo_id`; re-run step 2 (idempotent) before step 4. After step
4 an old scraper fails on insert (by design).

Not part of this runbook: the thumbnails in Storage (`storage.objects` was the
biggest table). They were moved to IDrive e2 separately (see
`scripts/thumbnails_to_e2/`), and Storage was emptied and vacuumed on 2026-11-17.

Historical hand-off notes for rolling the column change out across the three
repos (`photo-match-next`, `webos-local-slideshow`, the private `phash`) are in
[`CROSS_REPO_ROLLOUT.md`](./CROSS_REPO_ROLLOUT.md).
