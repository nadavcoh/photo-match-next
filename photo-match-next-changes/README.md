# Photo Match

A private tool for matching a backlog of WhatsApp media exports against a
Google Photos library (and a partner's library) using perceptual-hash
similarity. Swipe through unmatched items, review ranked candidates, commit
or skip, undo if needed.

This is a personal, single-user app — not a general-purpose product. Auth is
locked to one hardcoded email address.

## Stack

- **Next.js 15** (App Router, TypeScript, React 19)
- **Supabase** — Postgres (with `pgvector` for Hamming-distance queries),
  Storage (thumbnails), Auth (GitHub OAuth)
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
   pgvector similarity queries

You'll also need three Postgres tables (`wa`, `hashes`, `partner`) with
`pgvector` `bit(64)` hash columns — see the RPC function definitions in
`supabase-rls-and-rpc.sql` for the expected columns.

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

There is no automated test suite. Verify changes with:

```bash
npx tsc --noEmit
npx next build
```
