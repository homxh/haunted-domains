#!/usr/bin/env python3
"""Convert Supabase SQL Editor export pages into data/ghosts.json.

Usage (from the repo root, after downloading every page of the export):
  python3 scripts/export_to_ghosts.py ghosts-0.csv ghosts-100.csv ...
  python3 scripts/export_to_ghosts.py ghosts.json            # one JSON page

The SQL Editor caps a result at 100 rows, so the query in
data/DATA-README.md is run in pages (LIMIT 100 OFFSET 0, 100, 200, ...).
Pass every page to this script. Each file may be the SQL Editor's JSON
download (an array of row objects) or its CSV download.

The rows are merged by domain. A domain that appears more than once with
identical values is kept once; a domain that appears with different values
is an error. Every row carries total_ghosts (the full ghost count) plus
window_start / window_end, and the script fails unless:
  - all rows agree on total_ghosts, window_start, and window_end
  - the merged ghost count equals total_ghosts (a missing or capped page
    shows up here)

It then writes data/ghosts.json in the exact shape the app and validator
expect:
  {"meta": {...}, "ghosts": [...]}
Sets rdap_status to "unknown" and rdap_checked_at to "" — run
scripts/rdap_check.py afterwards to fill in the real snapshot.
Exits non-zero on missing columns, no rows, bad integers, or a count
mismatch.
"""

import csv
import json
import sys

OUT = "data/ghosts.json"

REQUIRED = [
    "domain", "tld", "first_seen", "last_seen", "days_on_board",
    "days_missing", "last_rank", "last_score", "risk", "last_price",
    "last_ends", "age_years", "backlinks", "history",
    "window_start", "window_end", "total_ghosts",
]


def load_rows(path):
    if path.endswith(".json"):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            # tolerate a wrapper object: use its first list value
            lists = [v for v in data.values() if isinstance(v, list)]
            if not lists:
                raise SystemExit(f"{path}: JSON export has no row array")
            data = lists[0]
        if not isinstance(data, list):
            raise SystemExit(f"{path}: JSON export is not an array of rows")
        return data
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def to_str(raw):
    return "" if raw is None else str(raw)


def to_int(raw, field, domain):
    if isinstance(raw, bool):
        raise SystemExit(f"bad integer for {field} on {domain}: {raw!r}")
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise SystemExit(f"bad integer for {field} on {domain}: {raw!r}")


def convert(r):
    """Turn one export row into a ghost object."""
    domain = to_str(r["domain"]).strip()
    if not domain or domain.endswith(".example"):
        raise SystemExit(f"bad domain in export: {domain!r}")
    return {
        "domain": domain,
        "tld": to_str(r["tld"]).strip(),
        "first_seen": to_str(r["first_seen"]).strip(),
        "last_seen": to_str(r["last_seen"]).strip(),
        "days_on_board": to_int(r["days_on_board"], "days_on_board", domain),
        "days_missing": to_int(r["days_missing"], "days_missing", domain),
        "last_rank": to_int(r["last_rank"], "last_rank", domain),
        "last_score": to_int(r["last_score"], "last_score", domain),
        "risk": to_str(r["risk"]).strip(),
        "last_price": to_str(r["last_price"]),
        "last_ends": to_str(r["last_ends"]),
        "age_years": to_int(r["age_years"], "age_years", domain),
        "backlinks": to_str(r["backlinks"]),
        "history": to_str(r["history"]),
        "rdap_status": "unknown",
        "rdap_checked_at": "",
    }


def main(paths):
    if not paths:
        raise SystemExit(
            "usage: python3 scripts/export_to_ghosts.py PAGE [PAGE ...]"
            "  (each PAGE is a .csv or .json download)")

    merged = {}      # domain -> ghost
    totals = set()   # distinct total_ghosts values seen
    starts = set()   # distinct window_start values seen
    ends = set()     # distinct window_end values seen
    row_count = 0

    for path in paths:
        try:
            rows = load_rows(path)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SystemExit(f"{path}: cannot read export ({exc})")
        print(f"{path}: {len(rows)} rows")
        for r in rows:
            missing = [c for c in REQUIRED if c not in r]
            if missing:
                raise SystemExit(f"{path}: missing columns: {missing}")
            ghost = convert(r)
            domain = ghost["domain"]
            if domain in merged and merged[domain] != ghost:
                raise SystemExit(
                    f"{path}: conflicting rows for {domain}: the pages disagree, "
                    "so the data changed between pages. Re-run every page.")
            merged[domain] = ghost
            totals.add(to_int(r["total_ghosts"], "total_ghosts", domain))
            starts.add(to_str(r["window_start"]).strip())
            ends.add(to_str(r["window_end"]).strip())
            row_count += 1

    if row_count == 0:
        raise SystemExit("empty export: no ghosts exported")
    if len(totals) != 1:
        raise SystemExit(f"pages disagree on total_ghosts: {sorted(totals)}")
    if len(starts) != 1 or len(ends) != 1:
        raise SystemExit(
            f"pages disagree on the window: starts {sorted(starts)}, ends {sorted(ends)}")

    total = totals.pop()
    if len(merged) != total:
        raise SystemExit(
            f"merged {len(merged)} unique ghosts from {row_count} rows, but "
            f"total_ghosts is {total}: a page is missing or the result was capped. "
            "Nothing was written.")

    ghosts = sorted(merged.values(), key=lambda g: (g["last_seen"], g["domain"]))
    meta = {
        "window": f"{starts.pop()} to {ends.pop()}",
        "ghost_count": len(ghosts),
        "sample": False,
        "rdap_checked_at": "",
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "ghosts": ghosts}, f, indent=2, ensure_ascii=False)
    print(f"wrote {OUT}: {len(ghosts)} ghosts, window {meta['window']}")


if __name__ == "__main__":
    main(sys.argv[1:])
