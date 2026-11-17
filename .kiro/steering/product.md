# Steering — Haunted Domains

## Product

Haunted Domains is the domsect.io leaderboard's graveyard: domains that
vanished from the Top 60 board, shown with their last-seen date, last
listed price, and a resurrection check. Audience: NamePros domainers and
Kiroween judges. Tone: Halloween, but the data is dead serious — every
number on screen traces to a Supabase row.

## Data-integrity rules (hard)

- Render only what `data/ghosts.json` contains. Never invent, round, or
  reformat a price — `last_price` is shown verbatim.
- Never paraphrase or alter `history` text.
- The sample file (`data/ghosts.sample.json`, `.example` domains) must
  never ship. The validator fails the build if it is present or if
  `meta.sample` is true.
- No number, date, or status may be displayed unless it is in the data
  file or computed transparently from it (days_missing, value radar —
  both with their inputs visible).

## Honest-framing rules (hard)

- "Death" means **last seen on the board**. The words "expired" and
  "deleted" must not appear in the UI, copy, or code comments about
  ghosts.
- Recency tiers (fresh < 7 days, cold 7–30 days, ancient > 30 days) are
  display buckets, not claims.
- Resurrection status is an offline RDAP snapshot. Always show
  `checked_at` next to it. Never call RDAP from the browser.
- The value radar is a display score, not an appraisal or a price
  prediction. The disclaimer ("For research use — not investment
  advice") stays on every view.

## Attribution rules (hard)

- The repo must not mention Muse, agy, Antigravity, or any non-Kiro
  tooling — in code, comments, docs, or commit messages. The visible
  build trail is Kiro (spec, steering, hook, PRs) only.
- The "how Kiro was used" write-up for Devpost must describe the real
  workflow (spec → tasks → PRs → Playwright checks), not a generic claim.

## Engineering rules

- Static site only: HTML + CSS + vanilla JS, no build step, no backend,
  no API keys, no third-party assets (all visuals original CSS/SVG).
- All rendering via `textContent` (never `innerHTML` with data).
- Validator (`scripts/validate_data.py`) must exit 0 before any PR is
  opened. Playwright checks (`tests/pwcheck/check.js`) must pass without
  edits to the test file.
- Apply the Haunted Earnings PR #4 accessibility baseline from the start
  (skip link, focus management, per-view titles, live-region discipline).
