#!/usr/bin/env python3
"""Convert a Supabase SQL Editor export into data/ghosts.json.

Usage (from the repo root, after downloading the export):
  python3 scripts/export_to_ghosts.py ghosts.json   # or ghosts.csv

Accepts the SQL Editor's JSON download (preferred — an array of row
objects) or its CSV download. Reads the export produced by the query in
data/DATA-README.md (which carries window_start / window_end on every
row) and writes data/ghosts.json in the exact shape the app and
validator expect:
  {"meta": {...}, "ghosts": [...]}
Sets rdap_status to "unknown" and rdap_checked_at to "" — run
scripts/rdap_check.py afterwards to fill in the real snapshot.
Exits non-zero on missing columns, empty input, or bad integers.
"""

import csv
import json
import sys

OUT = "data/ghosts.json"

REQUIRED = [
    "domain", "tld", "first_seen", "last_seen", "days_on_board",
    "days_missing", "last_rank", "last_score", "risk", "last_price",
    "last_ends", "age_years", "backlinks", "history",
    "window_start", "window_end",
]


def load_rows(path):
    if path.endswith(".json"):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            # tolerate a wrapper object: use its first list value
            lists = [v for v in data.values() if isinstance(v, list)]
            if not lists:
                raise SystemExit("JSON export has no row array")
            data = lists[0]
        if not isinstance(data, list):
            raise SystemExit("JSON export is not an array of rows")
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


def main():
    if len(sys.argv) != 2:
        raise SystemExit(
            "usage: python3 scripts/export_to_ghosts.py ghosts.json"
            "  (or ghosts.csv)")
    rows = load_rows(sys.argv[1])
    if not rows:
        raise SystemExit("empty export: no ghosts exported")
    missing = [c for c in REQUIRED if c not in rows[0]]
    if missing:
        raise SystemExit(f"missing columns: {missing}")

    ghosts = []
    for r in rows:
        domain = to_str(r["domain"]).strip()
        if not domain or domain.endswith(".example"):
            raise SystemExit(f"bad domain in export: {domain!r}")
        ghosts.append({
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
        })
    ghosts.sort(key=lambda g: (g["last_seen"], g["domain"]))
    meta = {
        "window": f"{rows[0]['window_start']} to {rows[0]['window_end']}",
        "ghost_count": len(ghosts),
        "sample": False,
        "rdap_checked_at": "",
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "ghosts": ghosts}, f, indent=2, ensure_ascii=False)
    print(f"wrote {OUT}: {len(ghosts)} ghosts, window {meta['window']}")


if __name__ == "__main__":
    main()
