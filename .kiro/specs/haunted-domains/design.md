# Design Document — Haunted Domains

## Overview

Haunted Domains is a static single-page app (HTML + CSS + vanilla JS, no
build step, no backend) served from GitHub Pages. It renders the ghost
list from `data/ghosts.json` at runtime. The visual language mirrors
Haunted Earnings (dark haunted theme, purple/orange) but the information
architecture is its own: a graveyard index, a ghost detail view, and a
resurrection-value radar. The RDAP snapshot is produced offline by
`scripts/rdap_check.py` and shipped as data — the browser never calls
RDAP.

## Architecture

```
haunted-domains/
├── index.html            # shell: hero, filter bar, views, error state
├── assets/
│   ├── app.js            # routing, rendering, search/filter, radar
│   └── style.css         # haunted theme, responsive layout
├── data/
│   ├── ghosts.json       # REAL export (replaces the sample before build)
│   ├── ghosts.sample.json# shape-only sample, 2 .example rows — do not ship
│   └── DATA-README.md    # provenance, ghost definition, RDAP method
├── scripts/
│   ├── validate_data.py  # schema + counts validator (exit non-zero on fail)
│   └── rdap_check.py     # batch RDAP snapshot (offline, 1 req/sec)
├── tests/pwcheck/        # Playwright checks (counts, rendering, routing,
│   │                     # error states, zero console errors)
│   └── check.js
├── .kiro/specs/haunted-domains/   # this spec
├── .kiro/steering/product.md      # product + data-integrity steering
└── .kiro/hooks/validate-ghosts.json       # validator hook (Kiro IDE 1.x v1 schema)
```

## Data model

One ghost (from `data/ghosts.json`, see `data/DATA-README.md` for the
export query):

```json
{
  "domain": "g13a.com", "tld": ".com",
  "first_seen": "2026-10-14", "last_seen": "2026-10-21",
  "days_on_board": 8, "days_missing": 26,
  "last_rank": 12, "last_score": 78, "risk": "low",
  "last_price": "$69", "last_ends": "2026-10-22T14:00:00",
  "age_years": 11, "backlinks": "500+ referring domains",
  "history": "First seen 2014, 320 snapshots",
  "rdap_status": "registered", "rdap_checked_at": "2026-11-17T00:00:00Z"
}
```

Meta block: `window` (observed dates), `ghost_count`, `sample`
(must be false in the shipped file), `rdap_checked_at` (latest snapshot).

Value radar (display only): a 0–100 signal from `last_score` (weight 0.5),
`age_years` capped at 20 (weight 0.25), and backlinks presence (weight
0.25: `"n/a"` scores 0, otherwise 1). Shown as "Resurrection value: N/100
(score S · age A yrs · backlinks B)" with the inputs visible. The last
price is shown alongside, never folded into the number.

## Views and routing (hash router, same pattern as Haunted Earnings)

- `#/` — graveyard index: meta line, filter bar (TLD / risk / RDAP status
  / search), ghost cards sorted by `last_seen` ascending (oldest death
  first), recency tier badge (fresh / cold / ancient).
- `#/<domain>` — ghost detail: full history, last price + listing end,
  resurrection status + checked_at, value radar with inputs.
- `#/?q=<term>` — search results across domain names.
- Error state: if `ghosts.json` fails to load, show the error panel with
  the URL and HTTP status; the filter bar stays visible but inert.

## Visual design

- Dark haunted theme: near-black purple background, violet + pumpkin
  orange accents, tombstone/ghost SVG art (original, no third-party
  assets). Hero names "Haunted Domains" + "Kiroween 2026".
- Ghost cards: tombstone silhouette via CSS, `last_seen` as the
  "death date" engraving, price as the "last offering".
- Radar: a simple horizontal meter + the three inputs listed, no chart
  library.
- Responsive: 360px / 1000px / 1440px, no horizontal scrolling. Same
  accessibility baseline as Haunted Earnings post-PR-#4 (skip link,
  focus management on route change, per-view `document.title`,
  `aria-live` status for the result count, visible focus ring).

## Testing

- `scripts/validate_data.py`: schema (all required fields, types, date
  formats), `ghost_count` matches the array length, no `.example`
  domains, `meta.sample` is false, every ghost has `rdap_status` and
  `rdap_checked_at`, `days_missing` consistent with `last_seen` and the
  window end.
- Kiro hook `.kiro/hooks/validate-ghosts.json` (v1 schema, `PostFileSave`
  trigger matching `data/ghosts.json`): runs the validator after edits.
- `tests/pwcheck/check.js` (Playwright, headless Chromium): ghost count
  vs data file, card fields vs data (domain, last_seen, price verbatim),
  routing (index → detail → back), search/filter, empty state, error
  state (data file renamed), layouts at 1440/1000/360, zero console
  errors. Mirrors the Haunted Earnings check suite's structure.

## Decisions and open questions

- Decided: ghosts are "absent from the latest board", not "expired" —
  see Requirement 8. No invented death threshold.
- Decided: RDAP is an offline batch snapshot, never a live browser call.
- Decided: the export has 1,199 ghosts, so the index renders every card
  into the DOM and reveals 60 at a time with a "Show 60 more" button
  (the label shows the real number left when fewer than 60 remain).
  The count line is always visible: "Showing 60 of 1,199". Search and
  filters apply to all 1,199 ghosts, not only the revealed ones. When a
  search or filter changes, the reveal resets to the first 60 matches and
  the line reads "Showing 60 of 214 matching". Hidden cards stay in the
  DOM (Playwright asserts the full count). After "Show more", focus moves
  to the first newly revealed card.
- Open: whether the same domsect.io startup can claim Best Startup for
  two submissions — the rules do not say. Assume one claim; do not plan
  the budget around two.
