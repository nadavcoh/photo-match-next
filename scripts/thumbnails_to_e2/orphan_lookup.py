"""Compute the phash of each orphan thumbnail and look for matching rows in the DB.

The orphans are 128px thumbnails; the DB stores the phash of the FULL-size
original, so an exact 0-bit match is not guaranteed. The script ranks rows by
Hamming distance (number of differing bits out of 64):
    0-4   almost certainly the same photo/video
    5-10  possible, check by eye
    >10   different image

Usage (from scripts/thumbnails_to_e2, venv active):
    pip install imagehash pillow psycopg2-binary
    python orphan_lookup.py --config d:\\dev\\phash\\phash\\config.json --orphans-dir d:\\dev\\orphans [--top 3]

Read-only: only SELECT statements are run.
"""
import argparse
import json
import re
import sys
from pathlib import Path

import imagehash
import psycopg2
import psycopg2.extras
from PIL import Image, ImageFile

ImageFile.LOAD_TRUNCATED_IMAGES = True

# (table, URL helper function)
TABLES = {
    "hashes": "gphoto_photo_url",
    "partner": "gphoto_partner_photo_url",
}
HASH_COLUMNS = ("hash_bit", "video_thumb_hash_bit")  # whichever exist in a table
NAME_RE = re.compile(r"^(?P<prefix>[a-z]+)_(?P<id>\d+)\.jpg$", re.IGNORECASE)


def phash_bits(path: Path) -> str:
    """64-char '0'/'1' string, built exactly like the scrapers (hex -> 064b)."""
    with Image.open(path) as img:
        return format(int(str(imagehash.phash(img)), 16), "064b")


def existing_hash_columns(cur, table):
    cur.execute(
        """select column_name from information_schema.columns
           where table_schema = 'public' and table_name = %s and column_name = any(%s)""",
        (table, list(HASH_COLUMNS)),
    )
    return [r[0] for r in cur.fetchall()]


def lookup(cur, table, url_fn, columns, bits, top):
    # Distance to the closest of the table's hash columns (a video row stores a
    # video hash in hash_bit and the phash of its thumbnail in video_thumb_hash_bit).
    values = ", ".join(
        f"('{c}', case when t.{c} is null then 65 else bit_count(t.{c} # %(h)s::bit(64)) end)"
        for c in columns
    )
    sql = f"""
        select t.id, t.photo_id, public.{url_fn}(t.photo_id) as url, d.dist, d.col
        from public.{table} t
        cross join lateral (
            select v.col, v.dist from (values {values}) as v(col, dist)
            order by v.dist limit 1
        ) d
        where d.dist <= 64
        order by d.dist, t.id
        limit %(top)s
    """
    cur.execute(sql, {"h": bits, "top": top})
    return cur.fetchall()


def id_exists(cur, table, row_id):
    cur.execute(f"select 1 from public.{table} where id = %s", (row_id,))
    return cur.fetchone() is not None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True)
    ap.add_argument("--orphans-dir", required=True)
    ap.add_argument("--top", type=int, default=3, help="closest rows to show per table (default 3)")
    args = ap.parse_args()

    files = sorted(p for p in Path(args.orphans_dir).rglob("*.jpg") if p.is_file())
    if not files:
        sys.exit(f"No .jpg files under {args.orphans_dir}")

    with open(args.config) as f:
        cfg = json.load(f)
    conn = psycopg2.connect(
        database=cfg["DB_NAME"], user=cfg["DB_USER"], password=cfg["DB_PASSWORD"],
        host=cfg["DB_HOST"], port=cfg["DB_PORT"],
        application_name="orphan-lookup",
    )
    conn.set_session(readonly=True, autocommit=True)
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

    columns = {t: existing_hash_columns(cur, t) for t in TABLES}
    print("hash columns searched:", {t: c for t, c in columns.items()}, "\n")

    for path in files:
        m = NAME_RE.match(path.name)
        label = f"{m['prefix']}_{m['id']}" if m else path.name
        bits = phash_bits(path)
        print(f"=== {label}   ({path})")
        print(f"    phash {int(bits, 2):016x}")
        if m and m["prefix"] in TABLES:
            print(f"    row id {m['id']} in {m['prefix']}: "
                  f"{'EXISTS' if id_exists(cur, m['prefix'], int(m['id'])) else 'no row (confirmed orphan)'}")
        for table, url_fn in TABLES.items():
            if not columns[table]:
                continue
            rows = lookup(cur, table, url_fn, columns[table], bits, args.top)
            print(f"    closest in {table}:")
            for r in rows:
                verdict = "SAME?" if r["dist"] <= 4 else ("maybe" if r["dist"] <= 10 else "different")
                print(f"      dist {r['dist']:>2} [{verdict:>9}]  id={r['id']}  via {r['col']}  {r['url']}")
        print()

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
