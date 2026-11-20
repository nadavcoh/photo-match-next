-- =============================================================================
-- Raise the statement timeout for the `authenticated` role (8s -> 30s)
--
-- Why
-- ───
-- /api/match calls the match_* RPCs, and export_hash_index, as `authenticated`,
-- which Supabase limits to 8s. Production logs (Nov 14-20) show repeated
-- "canceling statement due to statement timeout" from:
--   match_hashes_video   fast + wide   (wide: hnsw.ef_search = 400)
--   match_hashes_image   fast + exact
--   match_partner_video  wide
--   export_hash_index    hashes + partner
--
-- Measured on the production instance: the image-type branch of
-- match_hashes_video (HNSW on hashes.hash_bit, ef_search = 40) takes about
-- 1.9 s with every page already in shared buffers. ef_search = 400 is roughly
-- ten times that, so wide mode cannot finish inside 8 s; the exact scan has no
-- index at all.
--
-- Why a role setting and not ALTER FUNCTION ... SET statement_timeout
-- ────────────────────────────────────────────────────────────────────
-- PostgreSQL arms the statement timer when the outer statement starts, so a
-- SET in a function's proconfig does not extend the call that is already
-- running. The role setting is applied before the statement starts.
--
-- Scope
-- ─────
-- Applies to every query run as `authenticated`. That is acceptable here: the
-- app is single-user (RLS restricted to the owner, signup restricted by GitHub
-- id). `anon` (3s) and `authenticator` (8s) are left alone.
--
-- Note: the Vercel function must be allowed to wait that long. src/app/api/match
-- exports no maxDuration, so check the project's default function duration.
-- =============================================================================

alter role authenticated set statement_timeout = '30s';

-- PostgREST caches role settings; make it pick the new value up.
notify pgrst, 'reload config';
