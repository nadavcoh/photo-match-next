# Parity test for the in-memory hash index

Checks `src/lib/hashIndex.ts` against the real SQL match functions (`'exact'` mode)
on a local Postgres 16 with pgvector and synthetic data. Needs `pg` and `tsx`
(`npm install --no-save pg tsx`, they are not project dependencies).

1. Create a database and the minimal schema: `psql -f schema.sql` (a scratch
   database, never the real one).
2. Load synthetic rows into `hashes` and `partner` (any data with clustered
   near-duplicate 64-bit hashes works; see the 2026-11-14 run in CLAUDE.md).
3. Apply `supabase/migrations/20261103120100_match_functions_read_normalized_columns.sql`
   and `supabase/migrations/20261114130000_hash_index_export.sql` (create a stub
   `public.api_stats(id int)` table and the `anon` role first).
4. `PGDATABASE=<db> npx tsx scripts/hash_index_parity/parity.ts`

Exit code 0 = every check passed.
