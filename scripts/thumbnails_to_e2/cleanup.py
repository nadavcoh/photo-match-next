#!/usr/bin/env python3
"""
Delete the thumbnails from the Supabase Storage bucket AFTER the e2 copy has
been verified. Uses the Storage API (never SQL deletes on storage.objects),
so Supabase also removes the underlying files.

It refuses to delete anything unless every wanted object is present in e2
with the right size. Orphans (objects with no DB row) are deleted too, so it
also refuses unless they are already downloaded in --orphans-dir (made by
backfill.py --orphans-dir), or you explicitly pass --discard-orphans.

  python cleanup.py --config /path/to/config.json --orphans-dir DIR          # plan only
  python cleanup.py --config /path/to/config.json --orphans-dir DIR --yes    # really deletes

Afterwards run sql/thumbnails_to_e2/vacuum_full_storage_objects.sql to give
the disk space back to the database.
"""

import argparse
import time

import requests

from common import (
    SB_BUCKET, classify, connect_db, list_e2, list_row_ids,
    list_supabase_objects, load_settings, orphans_not_downloaded,
    report_verification, s3_client,
    sb_headers, with_retries,
)


def delete_batch(s, names):
    def go():
        r = requests.delete(
            f"{s['SUPABASE_URL']}/storage/v1/object/{SB_BUCKET}",
            headers={**sb_headers(s), "Content-Type": "application/json"},
            json={"prefixes": names}, timeout=120,
        )
        r.raise_for_status()
        return len(r.json())
    return with_retries(go)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config")
    ap.add_argument("--batch", type=int, default=500)
    ap.add_argument("--orphans-dir", help="folder holding the orphans downloaded by backfill.py")
    ap.add_argument("--discard-orphans", action="store_true",
                    help="delete the orphans without keeping a local copy")
    ap.add_argument("--yes", action="store_true", help="actually delete (default: plan only)")
    args = ap.parse_args()

    s = load_settings(args.config)
    s3 = s3_client(s)
    conn = connect_db(s)
    objects = list_supabase_objects(conn)
    wanted, orphans = classify(objects, list_row_ids(conn))
    print(f"{len(objects)} objects in Supabase bucket: {len(wanted)} wanted, {len(orphans)} orphans")

    print("Checking e2 holds every wanted object ...")
    e2 = list_e2(s3, s["E2_BUCKET"])
    if not report_verification(wanted, orphans, e2):
        raise SystemExit("ABORT: e2 is not a complete copy yet. Run backfill.py again.")

    if orphans:
        if args.discard_orphans:
            print(f"NOTE: {len(orphans)} orphans will be deleted without a local copy.")
        elif not args.orphans_dir:
            raise SystemExit(
                f"ABORT: {len(orphans)} orphans have no local copy. Run backfill.py with "
                f"--orphans-dir <folder>, then pass the same folder here (or --discard-orphans).")
        else:
            missing = orphans_not_downloaded(orphans, args.orphans_dir)
            if missing:
                raise SystemExit(f"ABORT: {len(missing)} orphans are not in {args.orphans_dir} "
                                 f"(e.g. {missing[0][0]}). Run backfill.py --orphans-dir again.")
            print(f"All {len(orphans)} orphans are saved in {args.orphans_dir}.")

    names = [n for n, _ in objects]
    if not args.yes:
        print(f"Plan: delete {len(names)} objects from Supabase Storage. Re-run with --yes.")
        return

    deleted = 0
    for i in range(0, len(names), args.batch):
        deleted += delete_batch(s, names[i:i + args.batch])
        print(f"  deleted {deleted}/{len(names)}")
        time.sleep(0.2)

    with conn.cursor() as cur:
        cur.execute("select count(*) from storage.objects where bucket_id = %s", (SB_BUCKET,))
        left = cur.fetchone()[0]
    print(f"Done. {left} objects remain in storage.objects for bucket '{SB_BUCKET}'.")
    print("Next: run sql/thumbnails_to_e2/vacuum_full_storage_objects.sql")
    raise SystemExit(0 if left == 0 else 1)


if __name__ == "__main__":
    main()
