# Requirements Document — Haunted Domains

## Introduction

Haunted Domains is a Halloween-themed interactive graveyard for the
Kiroween 2026 Costume Contest. It turns the domsect.io leaderboard
pipeline's real daily data into an explorable web experience: domains that
vanished from the Top 60 board, when they were last seen, what they last
listed for, whether they are registered right now, and whether they are
worth sniping. The dataset is real — every ghost comes from 42 consecutive
days (2026-10-06 → 2026-11-16) of Top 60 rows in Supabase
`domain_leaderboard`, 60 rows a day. The anchor was verified in two steps:
2026-10-13 → 2026-11-16 first, then 2026-10-06 → 2026-10-12 at 60 rows on
each day. The app is a static site: no backend, no login, no API keys.

## Glossary

- **Ghost**: a domain that appeared in the Top 60 on some `list_date` and
  does not appear on any later `list_date` in the observed window.
- **Last seen**: the ghost's last board date. This is the app's "death
  date". It proves disappearance from the board — nothing more.
- **Days missing**: the latest board date minus `last_seen`.
- **Resurrection status**: the RDAP snapshot for a ghost — `registered`,
  `available`, or `unknown` — with a `checked_at` timestamp.
- **Value radar**: the "worth sniping" signal, computed from the ghost's
  last score, age, backlinks, and last price. Not an appraisal.
- **Display set**: the ghosts in `data/ghosts.json`. The sample file with
  `.example` rows is shape-only and must NOT ship.
- **Kiroween**: the hackathon. Submission deadline Dec 4, 2026, 2:00 PM PT.

## Requirements

### Requirement 1 — Graveyard index

**User Story:** As a visitor, I want to see all the dead domains at a
glance, so I can pick one to investigate.

#### Acceptance Criteria

1. WHEN the app loads, THE SYSTEM SHALL render one card per ghost showing
   domain, `last_seen` date, `days_missing`, last listed price, and last
   score.
2. WHEN the page loads, THE SYSTEM SHALL display the dataset meta line:
   the ghost count and observed window, rendered from `meta.ghost_count`
   and `meta.window` as read from `data/ghosts.json` (no hardcoded dates or
   counts), and the "not investment advice" disclaimer.
3. WHEN a ghost is shown, THE SYSTEM SHALL label its death as "last seen
   on the board" with the date; it SHALL NOT use the words "expired" or
   "deleted" anywhere in the UI.

### Requirement 2 — Ghost detail

**User Story:** As a visitor, I want the full history of a dead domain, so
I can judge what it was worth.

#### Acceptance Criteria

1. WHEN a ghost card is selected, THE SYSTEM SHALL show first seen, last
   seen, days on board, days missing, last rank, last score, risk label,
   age, backlinks, and the history line.
2. WHEN a price is shown, THE SYSTEM SHALL show the `last_price` string
   verbatim from the data; it SHALL NOT recompute, reformat, or invent a
   price.
3. WHEN a ghost's listing end is shown, THE SYSTEM SHALL label it "listing
   ended" with the `last_ends` value; it SHALL NOT present it as an expiry
   or deletion date.

### Requirement 3 — Resurrection radar

**User Story:** As a visitor, I want to know whether a dead domain can be
brought back and whether it is worth it, so I can decide to snipe it.

#### Acceptance Criteria

1. WHEN a ghost is shown, THE SYSTEM SHALL show its `rdap_status`
   (`registered` / `available` / `unknown`) together with the
   `rdap_checked_at` timestamp.
2. WHEN a ghost is shown, THE SYSTEM SHALL show a value signal computed
   from its last score, age, backlinks, and last price — displayed as a
   plain score with its inputs visible, never as a price prediction.
3. THE SYSTEM SHALL NOT perform live RDAP lookups from the visitor's
   browser; the status shown SHALL always be the shipped snapshot.
4. WHEN `rdap_status` is `unknown`, THE SYSTEM SHALL say so plainly
   instead of guessing.

### Requirement 4 — Search and filter

**User Story:** As a visitor, I want to filter and search the graveyard, so
I can find the ghosts I care about without scrolling.

#### Acceptance Criteria

1. WHEN a TLD, risk label, or resurrection status is selected from the
   filter, THE SYSTEM SHALL show only matching ghosts, with a visible
   result count.
2. WHEN a search term is entered, THE SYSTEM SHALL match it against the
   domain name, case-insensitively.
3. WHEN a filter produces zero results, THE SYSTEM SHALL show an explicit
   empty state instead of a blank page.

### Requirement 5 — Costume Contest presentation

**User Story:** As a judge, I want the app to look unmistakably Halloween
and polished, so the Costume Contest theme is obvious in the first five
seconds.

#### Acceptance Criteria

1. THE SYSTEM SHALL use a dark haunted theme (dark background, purple/orange
   accents) consistently across all views.
2. THE SYSTEM SHALL include a Halloween hero header naming the project
   "Haunted Domains" and the Kiroween 2026 event.
3. THE SYSTEM SHALL NOT use copyrighted images, music, or third-party
   trademarks; all visuals SHALL be original CSS/SVG.
4. THE SYSTEM SHALL be responsive: usable at 360px mobile width and 1440px
   desktop width with no horizontal scrolling.

### Requirement 6 — Static deployment

**User Story:** As the developer, I want the app to deploy as a static
site, so judges can open a public URL with no setup.

#### Acceptance Criteria

1. THE SYSTEM SHALL run entirely client-side from static files; it SHALL
   require no server, database, or API key.
2. THE SYSTEM SHALL load `data/ghosts.json` at runtime and render from it;
   no ghost data SHALL be hard-coded in HTML.
3. THE SYSTEM SHALL include a `data/DATA-README.md` documenting provenance,
   the ghost definition, the RDAP method, and the disclaimer.
4. THE SYSTEM SHALL be deployable to GitHub Pages from the repository root
   with no build step.

### Requirement 7 — Kiro usage evidence

**User Story:** As a judge, I want to see that the app was built with
Kiro, so the Technological Implementation criterion can be scored.

#### Acceptance Criteria

1. THE REPOSITORY SHALL contain this spec (requirements, design, tasks)
   under `.kiro/specs/haunted-domains/`.
2. THE REPOSITORY SHALL contain a steering document under `.kiro/steering/`
   stating the product, data-integrity, and honest-framing rules.
3. THE REPOSITORY SHALL contain at least one Kiro hook that validates
   `data/ghosts.json` against its schema (required fields present, counts
   consistent with meta, no `.example` domains, no `sample: true`).
4. THE `.kiro` DIRECTORY SHALL NOT be listed in `.gitignore`.

### Requirement 8 — Honest framing (hard rule)

**User Story:** As a judge, I want the app's claims to match its data, so
I can trust what it shows.

#### Acceptance Criteria

1. THE SYSTEM SHALL describe a ghost's death only as "last seen on the
   board" with the `last_seen` date. The words "expired" and "deleted"
   SHALL NOT appear in the UI, copy, or code comments about ghosts.
2. THE SYSTEM SHALL NOT invent a death threshold: every domain absent from
   the latest board SHALL be listed, with `days_missing` shown; recency
   tiers (fresh < 7 days, cold 7–30 days, ancient > 30 days) are display
   buckets only.
3. THE SYSTEM SHALL show the RDAP `checked_at` timestamp next to every
   resurrection status, and SHALL NOT imply the status is live.
4. THE SYSTEM SHALL NOT display any price except the verbatim `last_price`
   from the data, and SHALL NOT present the value signal as an appraisal
   or a price prediction.
