#!/usr/bin/env python3
"""
challenge_generator.py — build playable challenges for a polyhex puzzle.

Given a board and piece set, this finds a random complete solution, then
selects N of its pieces to leave on the board as the starting position. The
rest is yours to solve.

WHY N PIECES ISN'T THE WHOLE STORY
----------------------------------
Any subset of a real solution is *solvable* by construction -- the solution
it came from still completes it. But solvable is not the same as *good*. A
good challenge is one where the remaining pieces fit in exactly ONE way, so
there is a single right answer to find.

Uniqueness is what N actually controls:
    small N  -> few clues, many completions, ambiguous (and usually harder)
    large N  -> many clues, unique completion, easier

So the generator does not just pick N pieces at random. It searches subsets
of size N looking for one whose completion count is exactly 1, and tells you
honestly when no such subset exists at that N.

DIFFICULTY
----------
Two independent knobs are reported:
    pieces_given   -- fewer is harder
    search_effort  -- DLX nodes explored to find the answer; a proxy for how
                      much backtracking a human faces. Higher is harder.
A challenge with few pieces AND high search effort is the genuinely nasty one.

USAGE
-----
    python3 challenge_generator.py --challenge 3
    python3 challenge_generator.py --challenge 3 --allow-ambiguous
    python3 challenge_generator.py --calibrate
    python3 challenge_generator.py --ladder
"""

from __future__ import annotations

import argparse
import random
import sys
from dataclasses import dataclass
from itertools import combinations
from typing import Dict, List, Optional, Sequence, Set, Tuple

from polyhex_solver import (
    Cell,
    DLX,
    Piece,
    Placement,
    Puzzle,
    build_matrix,
    count_solutions,
    demo_puzzle,
    parse_shape,
)


# --------------------------------------------------------------------------
# Instrumented solving
# --------------------------------------------------------------------------

class CountingDLX(DLX):
    """DLX that tallies how many search nodes it visits."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.nodes = 0

    def select_column(self) -> int:
        self.nodes += 1
        return super().select_column()


def solve_randomized(puzzle: Puzzle, preplaced: Sequence[Placement] = (),
                     rng: Optional[random.Random] = None,
                     limit: int = 1) -> Tuple[List[List[Placement]], int]:
    """
    Find up to `limit` solutions, exploring rows in random order so repeated
    calls return different solutions. Returns (solutions, search_effort).
    """
    rng = rng or random.Random()
    columns, rows, _, _ = build_matrix(puzzle, preplaced)
    rows = list(rows)
    rng.shuffle(rows)
    dlx = CountingDLX(columns, rows)
    out: List[List[Placement]] = []
    for sol in dlx.solve(limit=limit):
        out.append(list(preplaced) + sol)
        if len(out) >= limit:
            break
    return out, dlx.nodes


def random_solution(puzzle: Puzzle, rng: random.Random) -> Optional[List[Placement]]:
    sols, _ = solve_randomized(puzzle, rng=rng, limit=1)
    return sols[0] if sols else None


def completions(puzzle: Puzzle, preplaced: Sequence[Placement], cap: int = 2) -> int:
    """How many ways the position can be completed (capped for speed)."""
    n, _ = count_solutions(puzzle, preplaced, limit=cap)
    return n


# --------------------------------------------------------------------------
# Challenge construction
# --------------------------------------------------------------------------

@dataclass
class Challenge:
    given: List[Placement]          # pieces to place on the board
    remaining: List[str]            # piece names the player must fit
    solution: List[Placement]       # the full intended solution
    n_completions: int              # 1 == unique
    search_effort: int              # DLX nodes to solve from the given position
    attempts: int                   # subsets tried while searching

    @property
    def unique(self) -> bool:
        return self.n_completions == 1


def make_challenge(puzzle: Puzzle, n: int, rng: random.Random,
                   require_unique: bool = True,
                   solution_tries: int = 12,
                   subset_tries: int = 250) -> Optional[Challenge]:
    """
    Build a challenge that gives away N pieces.

    Strategy: draw a random full solution, then search subsets of size N of
    its placements for one with exactly one completion. If `require_unique`
    is False, return the subset with the fewest completions found.
    """
    total_pieces = len(puzzle.pieces)
    if not 0 <= n <= total_pieces:
        raise ValueError(f"N must be between 0 and {total_pieces}")

    best: Optional[Challenge] = None
    attempts = 0

    for _ in range(solution_tries):
        solution = random_solution(puzzle, rng)
        if solution is None:
            return None

        # Enumerate subsets exhaustively when cheap, sample when not.
        indices = range(len(solution))
        all_subsets = list(combinations(indices, n))
        rng.shuffle(all_subsets)
        budget = all_subsets[:subset_tries]

        for subset in budget:
            attempts += 1
            given = [solution[i] for i in subset]
            n_comp = completions(puzzle, given, cap=2)
            _, effort = solve_randomized(puzzle, given, rng=rng, limit=1)
            remaining = [p.name for p in puzzle.pieces
                         if p.name not in {g.piece for g in given}]
            cand = Challenge(given, remaining, solution, n_comp, effort, attempts)

            if best is None or cand.n_completions < best.n_completions:
                best = cand
            if cand.unique:
                return cand

        if not require_unique and best is not None:
            return best

    return best


def minimum_unique_n(puzzle: Puzzle, rng: random.Random,
                     subset_tries: int = 200) -> Optional[int]:
    """Smallest N for which a uniquely-solvable challenge could be found."""
    for n in range(0, len(puzzle.pieces) + 1):
        ch = make_challenge(puzzle, n, rng, require_unique=True,
                            solution_tries=4, subset_tries=subset_tries)
        if ch is not None and ch.unique:
            return n
    return None


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------

def render(puzzle: Puzzle, placements: Sequence[Placement],
           shear: bool = True, empty: str = ".") -> str:
    """
    Draw the board with each placed piece shown as its initial letter.
    `shear` indents successive rows to reflect the true hex offset, which is
    what you want when copying the layout onto physical plastic.
    """
    symbol: Dict[Cell, str] = {}
    seen: Dict[str, str] = {}
    # Assign letters from the puzzle's full piece list so a piece keeps the
    # same letter whether we are drawing clues or the whole solution.
    for piece in puzzle.pieces:
        used = set(seen.values())
        ch = next((c for c in piece.name.upper() + "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                   if c.isalpha() and c not in used), "?")
        seen[piece.name] = ch
    shown = {pl.piece for pl in placements}
    for pl in placements:
        for cell in pl.cells:
            symbol[cell] = seen[pl.piece]
    seen = {k: v for k, v in seen.items() if k in shown}

    rows = sorted({r for _, r in puzzle.board})
    lines = []
    for r in rows:
        qs = [q for q, rr in puzzle.board if rr == r]
        lo, hi = min(qs), max(qs)
        pad = " " * (r if shear else 0)
        cells = []
        for q in range(lo, hi + 1):
            if (q, r) not in puzzle.board:
                cells.append(" ")
            else:
                cells.append(symbol.get((q, r), empty))
        lines.append(pad + " " * (2 * lo) + " ".join(cells))

    legend = "  ".join(f"{ch}={name}" for name, ch in seen.items())
    return "\n".join(lines) + (f"\n\nlegend: {legend}" if legend else "")


def describe(challenge: Challenge, puzzle: Puzzle) -> str:
    out = []
    out.append(f"Place these {len(challenge.given)} piece(s) to start:\n")
    out.append(render(puzzle, challenge.given))
    out.append("")
    for pl in challenge.given:
        coords = ", ".join(f"({q},{r})" for q, r in sorted(pl.cells))
        out.append(f"  {pl.piece:<6} -> {coords}")
    out.append("")
    out.append(f"Then fit the remaining {len(challenge.remaining)}: "
               f"{', '.join(challenge.remaining)}")
    out.append("")
    if challenge.unique:
        out.append("Completions: 1 (unique -- exactly one right answer)")
    else:
        cap = "2+" if challenge.n_completions >= 2 else str(challenge.n_completions)
        out.append(f"Completions: {cap} (AMBIGUOUS -- more than one valid finish)")
    out.append(f"Search effort: {challenge.search_effort} nodes")
    out.append(f"Subsets tried: {challenge.attempts}")
    out.append("")
    out.append("Intended solution:\n")
    out.append(render(puzzle, challenge.solution))
    return "\n".join(out)


# --------------------------------------------------------------------------
# Calibration
# --------------------------------------------------------------------------

def calibrate(puzzle: Puzzle, rng: random.Random, samples: int = 40) -> List[dict]:
    """
    For each N, sample random N-subsets of real solutions and measure how
    often the position is uniquely completable. This is the difficulty curve
    for your specific puzzle.
    """
    table = []
    for n in range(0, len(puzzle.pieces) + 1):
        unique = 0
        efforts = []
        comps = []
        for _ in range(samples):
            solution = random_solution(puzzle, rng)
            if solution is None:
                break
            given = rng.sample(solution, n)
            c = completions(puzzle, given, cap=50)
            _, effort = solve_randomized(puzzle, given, rng=rng, limit=1)
            comps.append(c)
            efforts.append(effort)
            if c == 1:
                unique += 1
        if not comps:
            continue
        table.append({
            "pieces_given": n,
            "unique_rate": unique / len(comps),
            "median_completions": sorted(comps)[len(comps) // 2],
            "median_effort": sorted(efforts)[len(efforts) // 2],
        })
    return table


def print_calibration(table: List[dict]) -> None:
    print(f"{'given':>6}  {'unique rate':>12}  {'med completions':>16}  {'med effort':>11}")
    print("-" * 52)
    for row in table:
        comps = row["median_completions"]
        shown = f"{comps}+" if comps >= 50 else str(comps)
        print(f"{row['pieces_given']:>6}  {row['unique_rate']:>11.0%}  "
              f"{shown:>16}  {row['median_effort']:>11}")


def ladder(puzzle: Puzzle, rng: random.Random) -> None:
    """Print one unique challenge at each N, hardest first."""
    for n in range(len(puzzle.pieces), -1, -1):
        ch = make_challenge(puzzle, n, rng, require_unique=True,
                            solution_tries=6, subset_tries=150)
        if ch is None:
            continue
        tag = "unique" if ch.unique else "ambiguous"
        print(f"\n{'=' * 60}")
        print(f"N = {n} pieces given  |  {tag}  |  effort {ch.search_effort}")
        print(f"{'=' * 60}")
        print(render(puzzle, ch.given))


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--challenge", type=int, metavar="N",
                    help="generate a challenge giving away N pieces")
    ap.add_argument("--allow-ambiguous", action="store_true",
                    help="accept a non-unique challenge if no unique one is found")
    ap.add_argument("--calibrate", action="store_true",
                    help="show the uniqueness/difficulty curve across all N")
    ap.add_argument("--ladder", action="store_true",
                    help="print one challenge at every N, hardest first")
    ap.add_argument("--min-unique", action="store_true",
                    help="find the fewest pieces that still pin a unique answer")
    ap.add_argument("--puzzle", metavar="PATH",
                    help="load a polyhex/1 document instead of the built-in demo")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args(argv)

    if not any([args.challenge is not None, args.calibrate, args.ladder,
                args.min_unique]):
        ap.print_help()
        return 0

    rng = random.Random(args.seed)
    if args.puzzle:
        import puzzle_io
        puzzle = puzzle_io.puzzle_from_dict(puzzle_io.load(args.puzzle))
    else:
        puzzle = demo_puzzle()
    print(f"Board: {puzzle.total_cells} cells | Pieces: {len(puzzle.pieces)} | "
          f"Legal placements: {len(puzzle.placements)}\n")

    if args.challenge is not None:
        ch = make_challenge(puzzle, args.challenge, rng,
                            require_unique=not args.allow_ambiguous)
        if ch is None:
            print(f"No challenge found with N={args.challenge}. "
                  f"The puzzle may have no solutions at all.")
            return 1
        if not ch.unique and not args.allow_ambiguous:
            print(f"NOTE: no uniquely-solvable {args.challenge}-piece start was "
                  f"found. Showing the most constrained one located.\n")
        print(describe(ch, puzzle))

    if args.min_unique:
        n = minimum_unique_n(puzzle, rng)
        if n is None:
            print("No N produced a unique challenge.")
        else:
            print(f"Fewest pieces giving a unique answer: {n}")

    if args.calibrate:
        print_calibration(calibrate(puzzle, rng))

    if args.ladder:
        ladder(puzzle, rng)

    return 0


if __name__ == "__main__":
    sys.exit(main())
