#!/usr/bin/env python3
"""Attach an RDAP resurrection snapshot to data/ghosts.json.

For each ghost, queries https://rdap.org/domain/<domain> once:
  HTTP 200 -> registered, HTTP 404 -> available, anything else -> unknown.
Writes rdap_status + rdap_checked_at back into the file, in place.

Rules (see data/DATA-README.md):
  - 1 request per second, 10s timeout, one retry on network error.
  - Skips ghosts whose snapshot is less than 24h old (unless --force).
  - Never runs in the browser; the app ships this snapshot only.
  - stdlib only. No API keys.

Usage:
  python3 scripts/rdap_check.py [--force] [--limit N] [--dry-run]
"""

import argparse
import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

PATH = "data/ghosts.json"
RDAP_URL = "https://rdap.org/domain/%s"
RATE_LIMIT_S = 1.0
TIMEOUT_S = 10


def check(domain):
    """Return 'registered', 'available', or 'unknown' for one domain."""
    req = urllib.request.Request(
        RDAP_URL % domain, headers={"Accept": "application/json"}
    )
    for _ in range(2):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
                return "registered" if r.status == 200 else "unknown"
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return "available"
            return "unknown"
        except Exception:
            time.sleep(RATE_LIMIT_S)
    return "unknown"


def fresh(stamp, max_age_h=24):
    try:
        dt = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - dt).total_seconds() < max_age_h * 3600
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with open(PATH, encoding="utf-8") as f:
        data = json.load(f)
    if data.get("meta", {}).get("sample"):
        raise SystemExit("refusing to run on the sample file: replace it with the real export first")

    ghosts = data["ghosts"]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    counts = {"registered": 0, "available": 0, "unknown": 0, "skipped": 0}
    for i, g in enumerate(ghosts):
        if args.limit and i >= args.limit:
            break
        if not args.force and fresh(g.get("rdap_checked_at", "")):
            counts["skipped"] += 1
            continue
        status = check(g["domain"])
        counts[status] += 1
        print(f"{g['domain']}: {status}")
        if not args.dry_run:
            g["rdap_status"] = status
            g["rdap_checked_at"] = now
        time.sleep(RATE_LIMIT_S)

    if not args.dry_run:
        with open(PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"done: {counts} (checked_at={now})")


if __name__ == "__main__":
    main()
