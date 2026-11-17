#!/usr/bin/env python3
"""Validate data/ghosts.json against the Haunted Domains data contract.

Usage:
  python3 scripts/validate_data.py [path/to/ghosts.json]

Exit code 0: every check passed (warnings may still be printed).
Exit code 1: at least one check failed; each failure is printed on its own line.

Checks (see data/DATA-README.md and .kiro/specs/haunted-domains/design.md):
  - the file parses and has the top-level keys "meta" and "ghosts"
  - data/ghosts.sample.json is not present next to the data file
  - meta: window ("YYYY-MM-DD to YYYY-MM-DD"), ghost_count, sample == false,
    rdap_checked_at
  - meta.ghost_count equals the number of ghosts
  - every ghost has exactly the documented fields, with the documented types
  - no domain ends in ".example"; domains are unique and match their tld
  - dates are real calendar dates inside the observed window, and a ghost's
    last_seen is before the window end (it is absent from the latest board)
  - days_missing equals window end minus last_seen
  - days_on_board fits between first_seen and last_seen
  - rdap_status is registered / available / unknown, and rdap_checked_at is
    present on every ghost as a UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)

Prices, history text, and listing-end text are only checked for presence.
They are display strings and are never parsed or reformatted.

stdlib only. No network access.
"""

import json
import os
import re
import sys
from datetime import date, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PATH = os.path.join(ROOT, "data", "ghosts.json")

STR_FIELDS = [
    "domain", "tld", "first_seen", "last_seen", "risk", "last_price",
    "last_ends", "backlinks", "history", "rdap_status", "rdap_checked_at",
]
INT_FIELDS = [
    "days_on_board", "days_missing", "last_rank", "last_score", "age_years",
]
GHOST_FIELDS = set(STR_FIELDS) | set(INT_FIELDS)
META_FIELDS = {"window", "ghost_count", "sample", "rdap_checked_at"}
RDAP_STATUSES = {"registered", "available", "unknown"}

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
WINDOW_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})$")


def is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def parse_date(text):
    """Return a date for a strict YYYY-MM-DD string, else None."""
    if not isinstance(text, str) or not DATE_RE.match(text):
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def parse_stamp(text):
    """Return a datetime for a strict YYYY-MM-DDTHH:MM:SSZ string, else None."""
    if not isinstance(text, str) or not STAMP_RE.match(text):
        return None
    try:
        return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None


def check_meta(meta, ghosts, errors, warnings):
    """Validate the meta block. Returns (window_start, window_end) or None."""
    if not isinstance(meta, dict):
        errors.append("meta: must be an object")
        return None

    missing = sorted(META_FIELDS - set(meta))
    extra = sorted(set(meta) - META_FIELDS)
    if missing:
        errors.append(f"meta: missing fields {missing}")
    if extra:
        errors.append(f"meta: unexpected fields {extra}")

    if "sample" in meta and meta["sample"] is not False:
        errors.append(f"meta.sample must be false, got {meta['sample']!r}")

    if "ghost_count" in meta:
        count = meta["ghost_count"]
        if not is_int(count):
            errors.append(f"meta.ghost_count must be an integer, got {count!r}")
        elif count != len(ghosts):
            errors.append(
                f"meta.ghost_count is {count} but ghosts has {len(ghosts)} entries")

    window = None
    if "window" in meta:
        m = WINDOW_RE.match(meta["window"]) if isinstance(meta["window"], str) else None
        start = parse_date(m.group(1)) if m else None
        end = parse_date(m.group(2)) if m else None
        if start is None or end is None:
            errors.append(
                f"meta.window must look like 'YYYY-MM-DD to YYYY-MM-DD', got {meta['window']!r}")
        elif start > end:
            errors.append(f"meta.window starts after it ends: {meta['window']!r}")
        else:
            window = (start, end)

    if "rdap_checked_at" in meta:
        stamp = meta["rdap_checked_at"]
        stamps = [g["rdap_checked_at"] for g in ghosts
                  if isinstance(g, dict) and parse_stamp(g.get("rdap_checked_at"))]
        latest = max(stamps) if stamps else ""
        if stamp == "":
            warnings.append(
                "meta.rdap_checked_at is empty; the design defines it as the latest "
                f"snapshot time (ghosts carry {latest or 'no valid timestamps'})")
        elif parse_stamp(stamp) is None:
            errors.append(
                f"meta.rdap_checked_at must be YYYY-MM-DDTHH:MM:SSZ, got {stamp!r}")
        elif latest and stamp != latest:
            errors.append(
                f"meta.rdap_checked_at is {stamp} but the latest ghost snapshot is {latest}")
    return window


def check_ghost(index, ghost, window, errors):
    """Validate one ghost. Returns its domain when usable, else None."""
    label = f"ghosts[{index}]"
    if not isinstance(ghost, dict):
        errors.append(f"{label}: must be an object")
        return None

    domain = ghost.get("domain")
    if isinstance(domain, str) and domain:
        label = f"ghosts[{index}] {domain}"

    missing = sorted(GHOST_FIELDS - set(ghost))
    extra = sorted(set(ghost) - GHOST_FIELDS)
    if missing:
        errors.append(f"{label}: missing fields {missing}")
    if extra:
        errors.append(f"{label}: unexpected fields {extra}")

    for field in STR_FIELDS:
        if field in ghost:
            value = ghost[field]
            if not isinstance(value, str):
                errors.append(f"{label}: {field} must be a string, got {value!r}")
            elif value.strip() == "":
                errors.append(f"{label}: {field} is empty")
    for field in INT_FIELDS:
        if field in ghost and not is_int(ghost[field]):
            errors.append(f"{label}: {field} must be an integer, got {ghost[field]!r}")

    # Domain and tld.
    if isinstance(domain, str) and domain:
        if domain.lower().endswith(".example"):
            errors.append(f"{label}: sample domain (.example) must not ship")
        if domain != domain.lower():
            errors.append(f"{label}: domain must be lower case")
        tld = ghost.get("tld")
        if isinstance(tld, str) and tld and not domain.endswith(tld):
            errors.append(f"{label}: domain does not end with tld {tld!r}")
        if isinstance(tld, str) and tld and not tld.startswith("."):
            errors.append(f"{label}: tld must start with '.', got {tld!r}")

    # Dates and the numbers derived from them.
    first = parse_date(ghost.get("first_seen"))
    last = parse_date(ghost.get("last_seen"))
    for field, parsed in (("first_seen", first), ("last_seen", last)):
        if field in ghost and isinstance(ghost[field], str) and ghost[field] and parsed is None:
            errors.append(f"{label}: {field} is not a YYYY-MM-DD date: {ghost[field]!r}")
    if first and last and first > last:
        errors.append(f"{label}: first_seen {first} is after last_seen {last}")

    if window and last:
        start, end = window
        if last >= end:
            errors.append(
                f"{label}: last_seen {last} is not before the window end {end}, "
                "so it was on the latest board")
        if last < start:
            errors.append(f"{label}: last_seen {last} is before the window start {start}")
        if is_int(ghost.get("days_missing")) and ghost["days_missing"] != (end - last).days:
            errors.append(
                f"{label}: days_missing is {ghost['days_missing']} but window end {end} "
                f"minus last_seen {last} is {(end - last).days}")
    if window and first and first < window[0]:
        errors.append(f"{label}: first_seen {first} is before the window start {window[0]}")

    days_on_board = ghost.get("days_on_board")
    if is_int(days_on_board):
        if days_on_board < 1:
            errors.append(f"{label}: days_on_board must be at least 1, got {days_on_board}")
        elif first and last and days_on_board > (last - first).days + 1:
            errors.append(
                f"{label}: days_on_board {days_on_board} exceeds the "
                f"{(last - first).days + 1} days between first_seen and last_seen")

    # Ranges.
    if is_int(ghost.get("days_missing")) and ghost["days_missing"] < 1:
        errors.append(f"{label}: days_missing must be at least 1, got {ghost['days_missing']}")
    if is_int(ghost.get("last_rank")) and ghost["last_rank"] < 1:
        errors.append(f"{label}: last_rank must be at least 1, got {ghost['last_rank']}")
    score = ghost.get("last_score")
    if is_int(score) and not 0 <= score <= 100:
        errors.append(f"{label}: last_score must be 0 to 100, got {score}")
    if is_int(ghost.get("age_years")) and ghost["age_years"] < 0:
        errors.append(f"{label}: age_years must not be negative, got {ghost['age_years']}")

    # RDAP snapshot.
    status = ghost.get("rdap_status")
    if isinstance(status, str) and status and status not in RDAP_STATUSES:
        errors.append(
            f"{label}: rdap_status must be one of {sorted(RDAP_STATUSES)}, got {status!r}")
    stamp = ghost.get("rdap_checked_at")
    if isinstance(stamp, str) and stamp and parse_stamp(stamp) is None:
        errors.append(f"{label}: rdap_checked_at must be YYYY-MM-DDTHH:MM:SSZ, got {stamp!r}")

    return domain if isinstance(domain, str) and domain else None


def validate(path):
    """Return (errors, warnings, ghost_count) for the data file at path."""
    errors, warnings = [], []

    sample = os.path.join(os.path.dirname(path), "ghosts.sample.json")
    if os.path.exists(sample):
        errors.append(f"{sample} exists; the sample file must not ship")

    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        errors.append(f"{path}: file not found")
        return errors, warnings, 0
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        errors.append(f"{path}: not valid JSON ({exc})")
        return errors, warnings, 0

    if not isinstance(data, dict):
        errors.append("top level must be an object with 'meta' and 'ghosts'")
        return errors, warnings, 0
    for key in ("meta", "ghosts"):
        if key not in data:
            errors.append(f"top level: missing '{key}'")
    extra = sorted(set(data) - {"meta", "ghosts"})
    if extra:
        errors.append(f"top level: unexpected keys {extra}")
    ghosts = data.get("ghosts")
    if not isinstance(ghosts, list):
        errors.append("ghosts must be an array")
        return errors, warnings, 0
    if not ghosts:
        errors.append("ghosts is empty")

    window = check_meta(data.get("meta"), ghosts, errors, warnings)

    seen = {}
    for i, ghost in enumerate(ghosts):
        domain = check_ghost(i, ghost, window, errors)
        if domain:
            if domain in seen:
                errors.append(f"ghosts[{i}] {domain}: duplicate of ghosts[{seen[domain]}]")
            else:
                seen[domain] = i
    return errors, warnings, len(ghosts)


def main(argv):
    if len(argv) > 2:
        print("usage: python3 scripts/validate_data.py [path/to/ghosts.json]", file=sys.stderr)
        return 1
    path = argv[1] if len(argv) == 2 else DEFAULT_PATH
    errors, warnings, count = validate(path)
    for line in warnings:
        print(f"WARN  {line}")
    for line in errors:
        print(f"FAIL  {line}")
    if errors:
        print(f"validate_data: {len(errors)} problem(s) in {path}")
        return 1
    print(f"validate_data: OK, {count} ghosts in {path} ({len(warnings)} warning(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
