# Changes in this archive — photo-match-next

Cloudinary → Backblaze B2 migration + CLAUDE.md/README.md.

## New files (add these)
- CLAUDE.md
- README.md
- src/lib/b2.ts
- src/app/api/media/route.ts

## Modified files (overwrite these)
- package.json                          (removed cloudinary/next-cloudinary,
                                          added @aws-sdk/client-s3 +
                                          @aws-sdk/s3-request-presigner)
- src/components/WAMediaPreview.tsx      (now calls /api/media instead of
                                          /api/cloudinary/media)

## Deleted files (delete these — not included in this archive, tars can't
## represent deletions)
- src/lib/cloudinary-search.ts
- src/app/api/cloudinary/media/route.ts
- src/app/api/cloudinary/sign/route.ts   (was already dead code — unused)
- src/app/api/cloudinary/                (now-empty directory)

## Action required after applying
1. `npm install` to pick up the dependency change.
2. Add the B2_* env vars (see README.md) to .env.local and Vercel project
   settings; the CLOUDINARY_* vars can be removed from Vercel once confirmed
   working.
3. Make sure the actual media files exist in the B2 bucket at
   `{B2_MEDIA_PREFIX}/{wa.filename}` — this change only updates how the app
   *reads* media, not how it's uploaded/synced to B2.

Verified with `npx tsc --noEmit` and `npx next build` against the full repo
before this archive was created.
