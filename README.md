# Hex Puzzle Lab

A playable, fully offline web app for the 56-cell / 12-piece hex packing puzzle
(IQ-style, pieces may be flipped). Place pieces by hand and the app tells you,
exactly, how many ways the rest of the board can still be finished — and what
those completions have in common.

## What it does

- **Play** — drag pieces onto the board; Turn (R) and Flip (F) reshape the one
  in hand. Tap a placed piece to pick it back up. Undo with Ctrl+Z.
- **Exact counts** — every change starts a full count in a background thread.
  The empty board has 59,494 solutions; that one is precomputed so the app
  opens instantly.
- **Statistics**
  - *Completions*: exact number of ways to finish from the current position.
  - *Spots per piece* (on each chip): distinct positions that piece takes
    across all completions. `locked` means the same spot in every one.
  - *Cells settled*: empty cells that are always filled by the same piece.
  - *Cell breakdown*: tap an empty cell to see which pieces fill it, and how often.
  - *Heat map*: each empty cell tinted by its most likely piece.
- **Completions** — step through up to 300 actual completions; cells that
  differ from the previous one are ringed.
- **Hint** — marks which spots of the held piece still lead to a solution.
- **Deal a challenge** — N clue pieces lifted from a random solution.

## Install on a phone

Served from GitHub Pages (`/docs` on the main branch):

- **iOS** — open in Safari → Share → *Add to Home Screen*
- **Android** — Chrome → *Install app* (or the in-app *Install app* button)

After the first load the app needs no network at all: fonts, solver, puzzle
and statistics are all inside `index.html`, and a service worker keeps a copy
on the device.

## Layout

```
src/        source: app.js, solver.js, worker.js, style.css, body.html,
            puzzle.json, fonts.css (embedded woff2), empty-analysis.json
assets/     manifest, icons, service worker template
docs/       BUILT app — what GitHub Pages serves (do not edit by hand)
tools/      Python toolkit: DLX solver, challenge generator, polyhex/1 I/O,
            precompute.js for the empty-board cache
tests/      e2e.py — headless-browser check of every feature
build.py    src + assets -> docs/
```

## Develop

```bash
python3 build.py              # rebuild docs/
python3 tests/e2e.py          # 19 end-to-end checks (needs playwright)
node tools/precompute.js      # only if the puzzle or solver changes (~80 s)
```

`build.py` names the offline cache after a hash of the page, so every rebuild
reaches installed copies on their next launch. No manual version bump.

## How the solver works

The board is an **exact cover** problem: 56 cell constraints + 12 piece
constraints, one row per legal placement (2,867 with flips). The search always
fills the lowest-numbered empty cell, trying every placement that covers it,
so each solution is found exactly once. Cell sets are 64-bit masks split into
two 32-bit halves, so overlap checks are single AND operations.
