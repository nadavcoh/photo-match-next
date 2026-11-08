"""
Shared helpers for the one-time Supabase Storage -> IDrive e2 thumbnail
migration (backfill.py, cleanup.py).

Settings come from a JSON file (--config; the phash scrapers' config.json
works, it already has DB_* and SUPABASE_*), with environment variables
overriding any key. Keys:

  DB_NAME DB_USER DB_PASSWORD DB_HOST [DB_PORT]   Supabase Postgres (direct)
  SUPABASE_URL                                    https://<ref>.supabase.co
  SUPABASE_KEY                                    service-role key (the key
                                                  the scrapers upload with)
  E2_ENDPOINT E2_REGION                           e2 S3 endpoint + region
  E2_ACCESS_KEY_ID E2_SECRET_ACCESS_KEY           read/write e2 key
  E2_BUCKET                                       optional, "thumbnails"

Nothing here ever prints a secret.
"""

import json
import os
import re
import sys
import time
from urllib.parse import quote

import boto3
import psycopg2
import requests
from botocore.config import Config

SB_BUCKET = "thumbnails"

# {prefix}/{chunk:06d}/{prefix}_{id}.jpg with chunk == floor(id/1000)*1000
KEY_RE = re.compile(r"^(wa|hashes|partner)/(\d{6})/\1_(\d+)\.jpg$")

SETTING_KEYS = [
    "DB_NAME", "DB_USER", "DB_PASSWORD", "DB_HOST", "DB_PORT",
    "SUPABASE_URL", "SUPABASE_KEY",
    "E2_ENDPOINT", "E2_REGION", "E2_ACCESS_KEY_ID", "E2_SECRET_ACCESS_KEY", "E2_BUCKET",
]
REQUIRED = [k for k in SETTING_KEYS if k not in ("DB_PORT", "E2_BUCKET")]


def load_settings(config_path):
    s = {}
    if config_path:
        with open(config_path, encoding="utf-8") as f:
            s.update(json.load(f))
    for k in SETTING_KEYS:
        if os.environ.get(k):
            s[k] = os.environ[k]
    missing = [k for k in REQUIRED if not s.get(k)]
    if missing:
        sys.exit("Missing settings: " + ", ".join(missing))
    s.setdefault("DB_PORT", 5432)
    s.setdefault("E2_BUCKET", "thumbnails")
    s["SUPABASE_URL"] = s["SUPABASE_URL"].rstrip("/")
    return s


def s3_client(s):
    kwargs = dict(
        endpoint_url=s["E2_ENDPOINT"],
        region_name=s["E2_REGION"],
        aws_access_key_id=s["E2_ACCESS_KEY_ID"],
        aws_secret_access_key=s["E2_SECRET_ACCESS_KEY"],
    )
    # Newer botocore adds CRC checksums to every request by default, which
    # several S3-compatible stores reject. Older botocore doesn't know the option.
    try:
        cfg = Config(
            s3={"addressing_style": "path"},
            retries={"max_attempts": 5, "mode": "standard"},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
            max_pool_connections=64,
        )
    except TypeError:
        cfg = Config(s3={"addressing_style": "path"},
                     retries={"max_attempts": 5, "mode": "standard"},
                     max_pool_connections=64)
    return boto3.client("s3", config=cfg, **kwargs)


def connect_db(s):
    conn = psycopg2.connect(
        database=s["DB_NAME"], user=s["DB_USER"], password=s["DB_PASSWORD"],
        host=s["DB_HOST"], port=s["DB_PORT"],
    )
    # Read-only checks: autocommit so the connection never idles in a transaction.
    conn.autocommit = True
    return conn


def list_supabase_objects(conn):
    """[(name, size_bytes or -1)] for every object in the Supabase bucket."""
    with conn.cursor() as cur:
        cur.execute(
            "select name, coalesce((metadata->>'size')::bigint, -1) "
            "from storage.objects where bucket_id = %s order by name",
            (SB_BUCKET,),
        )
        return [(n, int(sz)) for n, sz in cur.fetchall()]


def list_row_ids(conn):
    ids = {}
    with conn.cursor() as cur:
        for prefix in ("wa", "hashes", "partner"):
            cur.execute(f"select id from {prefix}")  # fixed names, not user input
            ids[prefix] = {r[0] for r in cur.fetchall()}
    return ids


def classify(objects, row_ids):
    """Split objects into (wanted, orphans).

    wanted  = key is well-formed and its DB row exists -> must end up in e2
    orphans = malformed key, or no matching row (e.g. thumbnails of rows that
              were deleted) -> (name, size, reason); not copied to e2. They can
              be downloaded locally (backfill.py --orphans-dir) before
              cleanup.py deletes them
    """
    wanted, orphans = [], []
    for name, size in objects:
        m = KEY_RE.match(name)
        if not m:
            orphans.append((name, size, "unrecognized key"))
            continue
        prefix, chunk, ident = m.group(1), int(m.group(2)), int(m.group(3))
        if chunk != ident // 1000 * 1000:
            orphans.append((name, size, "wrong chunk dir"))
        elif ident not in row_ids[prefix]:
            orphans.append((name, size, "no matching row"))
        else:
            wanted.append((name, size))
    return wanted, orphans


def orphan_local_path(directory, name):
    return os.path.join(directory, *name.split("/"))


def orphans_not_downloaded(orphans, directory):
    """[(name, size)] of orphans missing (or with the wrong size) in a local folder."""
    out = []
    for name, size, _why in orphans:
        p = orphan_local_path(directory, name)
        if not os.path.isfile(p) or (size >= 0 and os.path.getsize(p) != size):
            out.append((name, size))
    return out


def list_e2(s3, bucket):
    """{key: size} for everything in the e2 bucket."""
    out = {}
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket):
        for o in page.get("Contents", []):
            out[o["Key"]] = o["Size"]
    return out


def compare(wanted, e2):
    """(missing, mismatched) names of wanted objects vs. the e2 listing."""
    missing = [n for n, _ in wanted if n not in e2]
    mismatched = [n for n, sz in wanted if n in e2 and sz >= 0 and e2[n] != sz]
    return missing, mismatched


def sb_headers(s):
    return {"Authorization": f"Bearer {s['SUPABASE_KEY']}", "apikey": s["SUPABASE_KEY"]}


def sb_object_url(s, name):
    return f"{s['SUPABASE_URL']}/storage/v1/object/{SB_BUCKET}/{quote(name)}"


def with_retries(fn, attempts=4):
    for i in range(attempts):
        try:
            return fn()
        except Exception:
            if i == attempts - 1:
                raise
            time.sleep(2 ** i)


def report_verification(wanted, orphans, e2):
    missing, mismatched = compare(wanted, e2)
    print(f"  wanted objects : {len(wanted)}")
    print(f"  orphans        : {len(orphans)} (not copied)")
    print(f"  in e2          : {len(e2)} objects")
    print(f"  missing in e2  : {len(missing)}")
    print(f"  size mismatch  : {len(mismatched)}")
    for n in (missing + mismatched)[:10]:
        print("    e.g.", n)
    return not missing and not mismatched
