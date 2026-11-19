# Implementation Plan — Haunted Domains

## 1. Repository setup

- [ ] 1. Create the public GitHub repo `haunted-domains` with an MIT license
- [ ] 1.1 Copy this starter pack into the repo root and commit (do NOT add
  `.kiro` to `.gitignore`)
- [ ] 1.2 Confirm the repo is public and the spec is visible at
  `.kiro/specs/haunted-domains/`

## 2. Real data export and RDAP snapshot

- [x] 2. Run the export query in `data/DATA-README.md` (Supabase SQL
  Editor), download the result as `ghosts.csv` into the repo root, and
  run `python3 scripts/export_to_ghosts.py ghosts.csv` to write the real
  `data/ghosts.json`
- [x] 2.1 Fill in the Coverage section of `data/DATA-README.md` (ghost
  count, earliest/latest `last_seen`)
- [x] 2.2 Delete `data/ghosts.sample.json` from the repo
- [x] 2.3 Run `python3 scripts/rdap_check.py` and record the snapshot
  counts in `data/DATA-README.md`
- [x] 2.4 Run `python3 scripts/validate_data.py` — it must exit 0 before
  any app code is written

## 3. Validator and Kiro hook

- [x] 3. Write `scripts/validate_data.py` (schema, counts, no `.example`,
  `sample` false, RDAP fields present, `days_missing` consistent)
- [x] 3.1 Write the Kiro hook `.kiro/hooks/validate-ghosts.json` (v1 hook
  schema; the older `.kiro.hook` format is superseded in Kiro IDE 1.x) that
  runs the validator on `data/ghosts.json` after edits
- [x] 3.2 Verify the hook fires in the Kiro IDE (or record it as
  unverified with the reason)
  - UNVERIFIED: this build ran in Kiro Web, which has no IDE, so the
    `PostFileSave` trigger was not observed firing. The hook command itself
    (`python3 -B scripts/validate_data.py`) was run by hand from the repo
    root and exits 0. Confirm in the Kiro IDE Agent Hooks panel.

## 4. App shell and graveyard index

- [x] 4. Write `index.html` (hero, filter bar, views, error state, skip
  link, per-view headings for focus management)
  - Scope notes: the filter bar markup lands with task 6, so no inert
    controls ship in between. The `#/?q=` route and the show-more reset
    already work. The `#/<domain>` view is a placeholder heading until
    task 5.
- [x] 4.1 Write `assets/style.css` (haunted theme, tombstone cards,
  responsive 360/1000/1440, no horizontal scrolling)
- [x] 4.2 Write `assets/app.js` routing (`#/`, `#/<domain>`, `#/?q=`) and
  the graveyard index (one card per ghost: domain, last seen,
  days missing, last price verbatim, last score, tier badge)
- [x] 4.3 Implement the meta line (ghost count, window, disclaimer) and
  the empty/error states

## 5. Ghost detail and resurrection radar

- [x] 5. Implement the detail view (full history, last price + listing
  end labelled "Listing ended" or "Listing set to end" relative to
  `meta.rdap_checked_at`, backlinks, history line)
- [x] 5.1 Implement the resurrection status display (`rdap_status` +
  `rdap_checked_at`, plain language for `unknown`)
- [x] 5.2 Implement the value radar (score/age/backlinks inputs visible,
  price shown alongside, never folded in)
- [x] 5.3 Enforce Requirement 8 in copy: "last seen on the board" only,
  no "expired" / "deleted" anywhere in UI or comments

## 6. Search and filter

- [x] 6. Implement TLD / risk / RDAP-status filters and text search
  (domain name, case-insensitive) with a visible result count
- [x] 6.1 Implement the debounced, de-duplicated live-region announcement
  for the result count (same pattern as Haunted Earnings PR #4)

## 7. Accessibility pass (same baseline as Haunted Earnings PR #4)

- [x] 7. Apply the PR #4 baseline from the start: skip link with script
  handler, focus moves to the view heading on route change (only when
  focus was lost), per-view `document.title`, hidden headings naming
  cards, field-border and placeholder contrast, `aria-live` only on the
  status element

## 8. Playwright checks

- [ ] 8. Write `tests/pwcheck/check.js` (counts vs data, card fields vs
  data, routing, search/filter, empty state, error states, layouts at
  1440/1000/360, zero console errors)
- [ ] 8.1 Run the suite against the merged code; all checks must pass
  without edits to the test file
- [ ] 8.2 Run `scripts/validate_data.py` again after the final data change

## 9. Deploy and submit

- [ ] 9. Enable GitHub Pages from the repo root; verify the live URL
- [ ] 9. Record the under-3-minute demo video, upload to YouTube (public)
- [ ] 9.1 Publish the Bonus Blog post on dev.to (mention Kiroween 2026)
- [ ] 9.2 Publish the Social Blitz post (starts with
  `#KiroweenHackathon26`, favourite thing about Kiro + how it changed the
  approach)
- [ ] 9.3 Fill in the Devpost form (Costume Contest, app URL, repo URL,
  video URL, Startup bonus with LinkedIn + domsect.io) and submit before
  Dec 4, 2026, 2:00 PM PT
