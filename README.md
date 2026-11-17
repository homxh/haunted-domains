# Haunted Domains — Kiroween 2026 Costume Contest

A Halloween-themed interactive graveyard for domains that vanished from the
domsect.io leaderboard, plus a resurrection-value radar: which domains died,
when they were last seen, what they last listed for, whether they are
registered right now, and whether they are worth sniping. Static site — no
backend, no login, no API keys.

Live demo: _(add the GitHub Pages URL after deploy)_
Devpost submission: _(add after submitting)_

## Quick start

1. Create a **public** GitHub repo named `haunted-domains` with an MIT
   license. Do NOT add `.kiro` to `.gitignore` — judges check for it.
2. Export the real ghost list (Supabase SQL Editor, query in
   `data/DATA-README.md`) — download the result as `ghosts.csv` into
   the repo root (download is CSV-only), then run `python3
   scripts/export_to_ghosts.py ghosts.csv` to write the real
   `data/ghosts.json`. The sample file is shape-only, two `.example`
   rows, and must NOT ship — delete it.
3. Run `python3 scripts/rdap_check.py` to attach a resurrection-status snapshot
   (registered / available / unknown, with `checked_at`) to every ghost.
4. Copy this starter pack into the repo root and commit.
5. Open the repo in **Kiro** (IDE). Your 4,000 Kiroween credits
   (`kiroween-20-26`, expire Dec 31, 2026) fund the build. Kiro Pro is
   active on the account, so **Sonnet 5.5** is available — use it for the
   build, not Auto.
6. In Kiro, open the spec at `.kiro/specs/haunted-domains/` and execute
   `tasks.md` top to bottom (requirements → design → tasks is already
   written; the steering doc in `.kiro/steering/product.md` states the
   data-integrity and honest-framing rules).
7. Enable **GitHub Pages** from the repo root. No build step.
8. Record the under-3-minute demo video, upload to YouTube (public),
   submit on Devpost before **Dec 4, 2026, 2:00 PM PT**.

## What's in here

| Path | What it is |
| --- | --- |
| `data/ghosts.sample.json` | SAMPLE ONLY (2 `.example` rows): the exact shape of `data/ghosts.json` |
| `data/DATA-README.md` | Provenance, ghost definition, export query, RDAP method, data rules |
| `scripts/rdap_check.py` | Batch RDAP snapshot: attaches `rdap_status` + `checked_at` to ghosts |
| `.kiro/specs/haunted-domains/requirements.md` | EARS-style requirements (8 requirements) |
| `.kiro/specs/haunted-domains/design.md` | Architecture, data model, visual design, testing |
| `.kiro/specs/haunted-domains/tasks.md` | Implementation plan, checkboxed |
| `.kiro/steering/product.md` | Product + data-integrity + honest-framing steering for Kiro |

## The honest-framing rule (non-negotiable)

"Death" in this app means **last seen on the domsect.io Top 60 board** —
nothing more. The data cannot prove a domain expired or was deleted, and
the app must never claim it did. A ghost's "death date" is its `last_seen`
date; its "last price" is its last listed GoDaddy price. The resurrection
status is an RDAP snapshot with a `checked_at` timestamp, not a live check.
See Requirement 8.

## Credits budget (rough)

- 4,000 Kiroween credits on the account; the Haunted Earnings build used
  only a handful, so the budget is effectively untouched.
- Sonnet 5.5 (1.3x) on Kiro Pro for the build; Haiku 5.5 (0.06x) for small
  edits. Do not use Auto — the model it picks cannot be verified afterward.

## Submission checklist

- [ ] Real `data/ghosts.json` exported (sample replaced), RDAP snapshot attached
- [ ] Public GitHub repo, MIT license, `.kiro` present at root
- [ ] Live app URL (GitHub Pages)
- [ ] Demo video < 3 min, public on YouTube
- [ ] Devpost form: category **Costume Contest**, app URL, repo URL, video URL
- [ ] Startup bonus: founder + LinkedIn + domsect.io (Best Startup Project, $10,000)
- [ ] Blog post mentioning Kiroween 2026 (Bonus Blog, 2,000 credits)
- [ ] Social post starting with `#KiroweenHackathon26` (Social Blitz, 3-month Pro+)
- [ ] Submit before Dec 4, 2026, 2:00 PM PT

## Prizes at stake

Best Costume Contest $5,000 · Best Startup Project $10,000 · Best Demo
$1,000 · Bonus Blog 2,000 credits · Social Blitz 3-month Pro+. One Overall
OR one Category prize, plus any number of Bonus prizes. Theoretical ceiling
for this project: $16,000.
