#!/usr/bin/env python3
"""
Copy every thumbnail from the Supabase Storage bucket to the IDrive e2 bucket.

Safe to re-run at any time: it lists e2 first and only copies objects that are
missing (or have a different size), so running it again after the app/scrapers
switch is the "delta pass". Supabase Storage is only read, never modified.

  python backfill.py --config /path/to/phash/config.json --dry-run
  python backfill.py --config ... --limit 200          # small trial first
  python backfill.py --config ...                      # the real run

Orphans (objects whose DB row no longer exists) are not copied.
Exit code 0 only if verification at the end is clean.
"""

import argparse
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from common import (
    SB_BUCKET, classify, connect_db, list_e2, list_row_ids,
    list_supabase_objects, load_settings, report_verification, s3_client,
    sb_headers, sb_object_url, with_retries,
)

_local = threading.local()


def session():
    if not hasattr(_local, "s"):
        _local.s = requests.Session()
    return _local.s


def copy_one(s, s3, name, size):
    def download():
        r = session().get(sb_object_url(s, name), headers=sb_headers(s), timeout=60)
        r.raise_for_status()
        if size >= 0 and len(r.content) != size:
            raise IOError(f"size {len(r.content)} != expected {size}")
        return r.content

    body = with_retries(download)
    with_retries(lambda: s3.put_object(
        Bucket=s["E2_BUCKET"], Key=name, Body=body, ContentType="image/jpeg"))
    return len(body)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", help="JSON settings file (phash config.json works)")
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--limit", type=int, help="copy at most N objects (trial run)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--failed-file", default="backfill_failed.txt")
    args = ap.parse_args()

    s = load_settings(args.config)
    s3 = s3_client(s)

    print("Reading Supabase object list and DB row ids ...")
    conn = connect_db(s)
    objects = list_supabase_objects(conn)
    wanted, orphans = classify(objects, list_row_ids(conn))
    conn.close()
    print(f"  {len(objects)} objects in Supabase bucket '{SB_BUCKET}': "
          f"{len(wanted)} wanted, {len(orphans)} orphans")
    for name, why in orphans[:10]:
        print(f"    orphan: {name} ({why})")

    print("Listing e2 bucket ...")
    e2 = list_e2(s3, s["E2_BUCKET"])
    todo = [(n, sz) for n, sz in wanted if n not in e2 or (sz >= 0 and e2[n] != sz)]
    print(f"  {len(e2)} objects already in e2; {len(todo)} to copy")

    if args.limit:
        todo = todo[: args.limit]
        print(f"  --limit: copying only {len(todo)}")
    if args.dry_run or not todo:
        print("Dry run, nothing copied." if args.dry_run else "Nothing to copy.")
    else:
        done = failed = copied_bytes = 0
        failures = []
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            futs = {ex.submit(copy_one, s, s3, n, sz): n for n, sz in todo}
            for f in as_completed(futs):
                try:
                    copied_bytes += f.result()
                    done += 1
                except Exception as e:  # keep going, report at the end
                    failed += 1
                    failures.append(f"{futs[f]}\t{type(e).__name__}: {e}")
                if (done + failed) % 1000 == 0:
                    rate = (done + failed) / max(time.time() - t0, 1e-6)
                    print(f"  {done + failed}/{len(todo)} ({failed} failed, {rate:.0f}/s)")
        print(f"Copied {done} objects ({copied_bytes / 1e6:.1f} MB), {failed} failed "
              f"in {time.time() - t0:.0f}s")
        if failures:
            with open(args.failed_file, "w", encoding="utf-8") as fh:
                fh.write("\n".join(failures) + "\n")
            print(f"  failures written to {args.failed_file} (re-run to retry them)")

    print("Verifying against Supabase ...")
    e2 = list_e2(s3, s["E2_BUCKET"])
    ok = report_verification(wanted, orphans, e2)
    if args.limit or args.dry_run:
        print("(partial run: 'missing' above is expected)")
    raise SystemExit(0 if (ok or args.limit or args.dry_run) else 1)


if __name__ == "__main__":
    main()
