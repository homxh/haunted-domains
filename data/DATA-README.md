# DATA-README — Haunted Domains

## Provenance (real data, no seeding)

Source: the domsect.io leaderboard pipeline (GoDaddy public Inventory
Protocol feed `all_listings.csv.zip` + Wayback CDX enrichment, scored
locally, Top 60/day upserted into Supabase table `domain_leaderboard` on
the OCI production box). Verified live: **35 consecutive days, 2026-10-13
→ 2026-11-16, 60 rows every day** (the 11-01–11-06 batches were confirmed
2026-11-17; the anchor before that was 19 days through 10-31, user-verified).

Pipeline code: `domain-pipeline-v2-2026-10-06.zip` (the `build_row` function
is the schema authority). Each daily row stores: `list_date`, `rank`,
`domain`, `tld`, `age_years`, `score` (0–100), `risk`, `price` (GoDaddy
listing price as displayed, e.g. `"$69"`), `ends_at` (listing end time),
`history`, `backlinks`, plus a `raw` JSON blob (CDX first-seen year and
snapshot count, DataForSEO fields, score components).

## What a "ghost" is (honest definition)

A domain is a ghost when it appeared in the Top 60 on some `list_date` and
does **not** appear on any later `list_date` in the observed window. Its
"death date" is its `last_seen` date — the last day it was on the board.
That is all the data proves. **It is NOT proof the domain expired, was
deleted, or dropped.** The app must label it "last seen on the board" and
never "expired" / "deleted". No invented death threshold: every domain
absent from the latest board is listed, with `days_missing` shown, tiered
by recency in the UI (fresh < 7 days, cold 7–30 days, ancient > 30 days —
tiers are display buckets, not claims about the domain).

## Export query (run in Supabase SQL Editor, download as CSV)

```sql
WITH last_rows AS (
  SELECT DISTINCT ON (domain)
    domain, list_date AS last_seen, rank AS last_rank,
    score AS last_score, price AS last_price, ends_at AS last_ends,
    age_years, tld, risk, history, backlinks
  FROM domain_leaderboard
  ORDER BY domain, list_date DESC
),
first_seen AS (
  SELECT domain, MIN(list_date) AS first_seen, COUNT(*) AS days_on_board
  FROM domain_leaderboard
  GROUP BY domain
)
SELECT l.*, f.first_seen, f.days_on_board,
  ((SELECT MAX(list_date) FROM domain_leaderboard) - l.last_seen) AS days_missing,
  (SELECT MIN(list_date) FROM domain_leaderboard) AS window_start,
  (SELECT MAX(list_date) FROM domain_leaderboard) AS window_end
FROM last_rows l JOIN first_seen f USING (domain)
WHERE l.last_seen < (SELECT MAX(list_date) FROM domain_leaderboard)
ORDER BY l.last_seen ASC;
```

Then, in a terminal in the repo root (the folder containing `data/` and
`scripts/`):

```bash
# 1. Download the query result from the SQL Editor as ghosts.csv
#    (download is CSV-only), then convert it:
python3 scripts/export_to_ghosts.py ghosts.csv
#    -> writes data/ghosts.json (real export, sample replaced)
#
#    JSON alternative: use the copy button (JSON format), then in the
#    terminal run `pbpaste > ghosts.json` and convert that instead:
#    python3 scripts/export_to_ghosts.py ghosts.json

# 2. Attach the RDAP snapshot (about 1 second per ghost):
python3 scripts/rdap_check.py
#    -> fills in rdap_status + rdap_checked_at in data/ghosts.json
```

Delete the downloaded export and `data/ghosts.sample.json` afterwards;
neither ships. Save the result as `data/ghosts.json` with this shape (one object
per ghost, plus a `meta` block). Field names must match exactly — the
validator enforces them.

| Field | Meaning | Source |
| --- | --- | --- |
| `domain` | e.g. `g13a.com` | `domain_leaderboard.domain` |
| `tld` | e.g. `.com` | `tld` |
| `first_seen` / `last_seen` | first / last board dates (`YYYY-MM-DD`) | `MIN/MAX(list_date)` |
| `days_on_board` | number of days the domain appeared | `COUNT(*)` per domain |
| `days_missing` | latest board date minus `last_seen` | computed |
| `last_rank` / `last_score` / `risk` | rank, score (0–100), risk label on `last_seen` | that date's row |
| `last_price` | GoDaddy listing price as displayed, e.g. `"$69"` | `price` (verbatim, never recomputed) |
| `last_ends` | listing end time as displayed | `ends_at` |
| `age_years` | domain age in years on `last_seen` | `age_years` |
| `backlinks` | e.g. `"500+ referring domains"` or `"n/a"` | `backlinks` |
| `history` | one-line provenance text | `history` |
| `rdap_status` | `registered` / `available` / `unknown` | `scripts/rdap_check.py` snapshot |
| `rdap_checked_at` | ISO timestamp of the RDAP check | `scripts/rdap_check.py` snapshot |

## Resurrection check (RDAP snapshot, not live)

`scripts/rdap_check.py` queries `https://rdap.org/domain/<domain>` once
per ghost (1 request/second, stdlib only): HTTP 200 → `registered`,
HTTP 404 → `available`, anything else → `unknown`. It writes
`rdap_status` + `rdap_checked_at` into `ghosts.json`. The app ships that
snapshot — it must NOT do live RDAP lookups from the visitor's browser
(CORS and per-registry rate limits would break in front of a judge). The
UI must show the `checked_at` timestamp next to every status.

## Sample file

`data/ghosts.sample.json` holds 2 rows with `.example` domains. It exists
only so Kiro can build against the exact shape. **It must be replaced by
the real export before the app is submitted.** The validator fails the
build if any domain ends in `.example` or if `meta.sample` is true.

## Coverage (to fill in after the export)

- Observed window: 2026-10-13 → 2026-11-16 (35 days × 60 rows).
- Ghosts found: 100 (earliest `last_seen` 2026-10-06, latest `last_seen` 2026-10-09).
- RDAP snapshot: `checked_at` 2026-11-17T14:40:52Z. 100 registered, 0 available, 0 unknown.

## Disclaimer

For research use — not investment advice. Prices are historical GoDaddy
listing prices, not appraisals. "Worth sniping" signals are computed from
the leaderboard score, age, and backlinks only.
