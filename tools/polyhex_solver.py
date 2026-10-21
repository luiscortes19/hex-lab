#!/usr/bin/env python3
"""
polyhex_solver.py — exact-cover solver for hexagonal tiling puzzles
(IQ Six Pro / IQ Snow / any polyhex packing puzzle).

Answers, for any starting configuration:
    - is it solvable at all?
    - how many complete solutions does it admit?
    - if unsolvable, can we certify that cheaply?

COORDINATE SYSTEM
-----------------
Axial coordinates (q, r). The six neighbours of (q, r) are:
    (q+1, r) (q-1, r) (q, r+1) (q, r-1) (q+1, r-1) (q-1, r+1)

Boards and pieces are drawn as text grids. Column index -> q, line index -> r.
A '#' (or any non-'.', non-space char) marks a cell. Because the lattice is
sheared, a text rectangle is a *rhombus* on the hex grid, not a rectangle.
Draw a hexagon by cutting the rhombus corners with '.'.

    Example: a bar of 3 hexes running along +q
        ###

    Example: a "triangle" tri-hex
        ##
        #.

USAGE
-----
    python3 polyhex_solver.py --selftest
    python3 polyhex_solver.py --count
    python3 polyhex_solver.py --survey 300
"""

from __future__ import annotations

import argparse
import random
import sys
from dataclasses import dataclass, field
from typing import Dict, FrozenSet, Iterable, List, Optional, Sequence, Set, Tuple

Cell = Tuple[int, int]

NEIGHBOUR_OFFSETS: Tuple[Cell, ...] = (
    (1, 0), (-1, 0), (0, 1), (0, -1), (1, -1), (-1, 1),
)


# --------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------

def parse_shape(text: str) -> FrozenSet[Cell]:
    """Parse a text grid into a set of axial cells."""
    cells: Set[Cell] = set()
    for r, line in enumerate(text.strip("\n").splitlines()):
        for q, ch in enumerate(line):
            if ch not in (".", " "):
                cells.add((q, r))
    if not cells:
        raise ValueError("shape is empty")
    return frozenset(cells)


def normalize(cells: Iterable[Cell]) -> FrozenSet[Cell]:
    """Translate a cell set so its minimum corner sits at the origin."""
    cells = list(cells)
    min_q = min(q for q, _ in cells)
    min_r = min(r for _, r in cells)
    return frozenset((q - min_q, r - min_r) for q, r in cells)


def rotate60(cells: Iterable[Cell]) -> FrozenSet[Cell]:
    """Rotate 60 degrees about the origin: (q, r) -> (-r, q + r)."""
    return frozenset((-r, q + r) for q, r in cells)


def reflect(cells: Iterable[Cell]) -> FrozenSet[Cell]:
    """Mirror across a lattice axis: (q, r) -> (r, q)."""
    return frozenset((r, q) for q, r in cells)


def orientations(cells: FrozenSet[Cell], allow_flip: bool = True) -> List[FrozenSet[Cell]]:
    """All distinct orientations of a shape (6 rotations, x2 if flippable)."""
    seen: Set[FrozenSet[Cell]] = set()
    for base in ([cells, reflect(cells)] if allow_flip else [cells]):
        current = base
        for _ in range(6):
            seen.add(normalize(current))
            current = rotate60(current)
    return sorted(seen, key=lambda s: sorted(s))


def neighbours(cell: Cell) -> Iterable[Cell]:
    q, r = cell
    for dq, dr in NEIGHBOUR_OFFSETS:
        yield (q + dq, r + dr)


def components(cells: Set[Cell]) -> List[Set[Cell]]:
    """Connected components of a cell set under hex adjacency."""
    remaining = set(cells)
    out: List[Set[Cell]] = []
    while remaining:
        start = remaining.pop()
        comp = {start}
        stack = [start]
        while stack:
            for nb in neighbours(stack.pop()):
                if nb in remaining:
                    remaining.discard(nb)
                    comp.add(nb)
                    stack.append(nb)
        out.append(comp)
    return out


# --------------------------------------------------------------------------
# Puzzle model
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Piece:
    name: str
    cells: FrozenSet[Cell]
    allow_flip: bool = True

    @property
    def size(self) -> int:
        return len(self.cells)


@dataclass
class Placement:
    piece: str
    cells: FrozenSet[Cell]

    def __repr__(self) -> str:
        return f"{self.piece}@{sorted(self.cells)}"


@dataclass
class Puzzle:
    board: FrozenSet[Cell]
    pieces: List[Piece]
    placements: List[Placement] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.placements:
            self.placements = self.generate_placements()

    def generate_placements(self) -> List[Placement]:
        """Every legal (piece, orientation, translation) triple."""
        out: List[Placement] = []
        board = self.board
        qs = [q for q, _ in board]
        rs = [r for _, r in board]
        for piece in self.pieces:
            for orient in orientations(piece.cells, piece.allow_flip):
                for dq in range(min(qs) - 1, max(qs) + 2):
                    for dr in range(min(rs) - 1, max(rs) + 2):
                        moved = frozenset((q + dq, r + dr) for q, r in orient)
                        if moved <= board:
                            out.append(Placement(piece.name, moved))
        return out

    @property
    def total_cells(self) -> int:
        return len(self.board)

    @property
    def piece_cells(self) -> int:
        return sum(p.size for p in self.pieces)


# --------------------------------------------------------------------------
# Dancing Links (Knuth's Algorithm X)
# --------------------------------------------------------------------------

class DLX:
    """Exact cover via dancing links, using flat arrays for speed."""

    def __init__(self, columns: Sequence[object], rows: Sequence[Tuple[object, Sequence[object]]]):
        self.col_ids = list(columns)
        index = {c: i for i, c in enumerate(self.col_ids)}
        n = len(self.col_ids)

        # Node arrays. Node 0 is the root; nodes 1..n are column headers.
        self.L = list(range(-1, n)) + []
        self.R = list(range(1, n + 2))
        self.L[0] = n
        self.R[n] = 0
        self.U = list(range(n + 1))
        self.D = list(range(n + 1))
        self.C = list(range(n + 1))
        self.size = [0] * (n + 1)
        self.row_label: List[object] = [None] * (n + 1)

        for i in range(1, n + 1):
            self.L[i] = i - 1
            self.R[i] = (i + 1) if i < n else 0
            self.U[i] = self.D[i] = i

        for label, cols in rows:
            first = None
            for c in cols:
                ci = index[c] + 1
                node = len(self.C)
                self.C.append(ci)
                self.row_label.append(label)
                self.U.append(self.U[ci])
                self.D.append(ci)
                self.D[self.U[ci]] = node
                self.U[ci] = node
                self.size[ci] += 1
                if first is None:
                    self.L.append(node)
                    self.R.append(node)
                    first = node
                else:
                    self.L.append(self.L[first])
                    self.R.append(first)
                    self.R[self.L[first]] = node
                    self.L[first] = node

    def cover(self, c: int) -> None:
        L, R, U, D, C, size = self.L, self.R, self.U, self.D, self.C, self.size
        R[L[c]] = R[c]
        L[R[c]] = L[c]
        i = D[c]
        while i != c:
            j = R[i]
            while j != i:
                D[U[j]] = D[j]
                U[D[j]] = U[j]
                size[C[j]] -= 1
                j = R[j]
            i = D[i]

    def uncover(self, c: int) -> None:
        L, R, U, D, C, size = self.L, self.R, self.U, self.D, self.C, self.size
        i = U[c]
        while i != c:
            j = L[i]
            while j != i:
                size[C[j]] += 1
                D[U[j]] = j
                U[D[j]] = j
                j = L[j]
            i = U[i]
        R[L[c]] = c
        L[R[c]] = c

    def select_column(self) -> int:
        """Minimum-remaining-values heuristic."""
        best, best_size = -1, float("inf")
        c = self.R[0]
        while c != 0:
            if self.size[c] < best_size:
                best, best_size = c, self.size[c]
                if best_size <= 1:
                    break
            c = self.R[c]
        return best

    def solve(self, limit: Optional[int] = None):
        """Yield solutions as lists of row labels. Stops after `limit` if given."""
        solution: List[object] = []
        count = 0

        def search():
            nonlocal count
            if self.R[0] == 0:
                count += 1
                yield list(solution)
                return
            c = self.select_column()
            if self.size[c] == 0:
                return
            self.cover(c)
            r = self.D[c]
            while r != c:
                solution.append(self.row_label[r])
                j = self.R[r]
                while j != r:
                    self.cover(self.C[j])
                    j = self.R[j]
                yield from search()
                if limit is not None and count >= limit:
                    j = self.L[r]
                    while j != r:
                        self.uncover(self.C[j])
                        j = self.L[j]
                    solution.pop()
                    self.uncover(c)
                    return
                j = self.L[r]
                while j != r:
                    self.uncover(self.C[j])
                    j = self.L[j]
                solution.pop()
                r = self.D[r]
            self.uncover(c)

        yield from search()


# --------------------------------------------------------------------------
# Solving API
# --------------------------------------------------------------------------

def build_matrix(puzzle: Puzzle, preplaced: Sequence[Placement] = ()):
    """Reduce the board by pre-placed pieces, then build the cover matrix."""
    used_cells: Set[Cell] = set()
    used_pieces: Set[str] = set()
    for pl in preplaced:
        if not pl.cells <= puzzle.board:
            raise ValueError(f"{pl} lies outside the board")
        if pl.cells & used_cells:
            raise ValueError(f"{pl} overlaps another pre-placed piece")
        if pl.piece in used_pieces:
            raise ValueError(f"piece {pl.piece} placed twice")
        used_cells |= pl.cells
        used_pieces.add(pl.piece)

    free_cells = set(puzzle.board) - used_cells
    free_pieces = [p for p in puzzle.pieces if p.name not in used_pieces]

    columns: List[object] = [("cell", c) for c in sorted(free_cells)]
    columns += [("piece", p.name) for p in free_pieces]

    free_names = {p.name for p in free_pieces}
    rows = []
    for pl in puzzle.placements:
        if pl.piece in free_names and pl.cells <= free_cells:
            cols = [("cell", c) for c in sorted(pl.cells)] + [("piece", pl.piece)]
            rows.append((pl, cols))
    return columns, rows, free_cells, free_pieces


def count_solutions(puzzle: Puzzle, preplaced: Sequence[Placement] = (),
                    limit: Optional[int] = None) -> Tuple[int, List[List[Placement]]]:
    """Return (count, sample solutions). `limit` caps the search."""
    columns, rows, _, _ = build_matrix(puzzle, preplaced)
    dlx = DLX(columns, rows)
    found: List[List[Placement]] = []
    count = 0
    for sol in dlx.solve(limit=limit):
        count += 1
        if len(found) < 3:
            found.append(list(preplaced) + sol)
        if limit is not None and count >= limit:
            break
    return count, found


def is_solvable(puzzle: Puzzle, preplaced: Sequence[Placement] = ()) -> bool:
    count, _ = count_solutions(puzzle, preplaced, limit=1)
    return count > 0


# --------------------------------------------------------------------------
# Cheap impossibility certificates
# --------------------------------------------------------------------------

def impossibility_certificate(puzzle: Puzzle,
                              preplaced: Sequence[Placement] = ()) -> Optional[str]:
    """
    Return a human-readable reason the configuration cannot be completed,
    or None if no cheap certificate applies.

    These tests are SUFFICIENT for impossibility, never complete -- passing
    them says nothing about solvability. Deciding the general case is
    NP-complete, so you still have to search.
    """
    _, _, free_cells, free_pieces = build_matrix(puzzle, preplaced)

    if not free_pieces:
        return None if not free_cells else f"{len(free_cells)} cells left with no pieces remaining"

    total = sum(p.size for p in free_pieces)
    if total < len(free_cells):
        return f"area mismatch: {len(free_cells)} cells left, only {total} cells of piece area"

    sizes = sorted({p.size for p in free_pieces})
    smallest = sizes[0]

    # 1. Dead pocket: a region too small for any remaining piece.
    for comp in components(free_cells):
        if len(comp) < smallest:
            return (f"dead pocket of {len(comp)} cell(s) at {sorted(comp)[:4]} — "
                    f"smallest remaining piece covers {smallest}")

    # 2. Subset-sum: each region must be partitionable into piece areas.
    reachable = {0}
    for p in free_pieces:
        reachable |= {s + p.size for s in reachable}
    for comp in components(free_cells):
        if len(comp) not in reachable:
            return (f"region of {len(comp)} cells cannot be expressed as a sum of "
                    f"remaining piece sizes {sizes}")

    # 3. Three-colouring invariant on the hex lattice.
    #    Colour c = (q - r) mod 3. Every piece covers a fixed multiset of
    #    colours per orientation; if no combination matches the region's
    #    colour counts, no tiling exists.
    def colour_counts(cells: Iterable[Cell]) -> Tuple[int, int, int]:
        tally = [0, 0, 0]
        for q, r in cells:
            tally[(q - r) % 3] += 1
        return tuple(tally)  # type: ignore[return-value]

    target = colour_counts(free_cells)
    achievable: Set[Tuple[int, int, int]] = {(0, 0, 0)}
    for p in free_pieces:
        variants = set()
        for orient in orientations(p.cells, p.allow_flip):
            # all 3 colour-phase shifts a translation can produce
            for shift in range(3):
                cc = colour_counts((q + shift, r) for q, r in orient)
                variants.add(cc)
        achievable = {
            tuple(a + b for a, b in zip(acc, var))  # type: ignore[misc]
            for acc in achievable for var in variants
        }
        achievable = {a for a in achievable if all(x <= y for x, y in zip(a, target))}
        if not achievable:
            return f"3-colouring invariant violated (region colour counts {target} unreachable)"
    if target not in achievable:
        return f"3-colouring invariant violated (region colour counts {target} unreachable)"

    return None


# --------------------------------------------------------------------------
# The experiment: how often does a random placement survive?
# --------------------------------------------------------------------------

def survey(puzzle: Puzzle, trials: int = 200, seed: int = 0,
           solution_cap: int = 100000) -> Dict[str, object]:
    """
    Sample random single placements and measure:
      - fraction that remain solvable
      - how many solutions each surviving placement admits
      - how often a cheap certificate catches the failures
    """
    rng = random.Random(seed)
    baseline, _ = count_solutions(puzzle, limit=solution_cap)

    solvable = 0
    unique = 0
    certified = 0
    counts: List[int] = []

    sample = [rng.choice(puzzle.placements) for _ in range(trials)]
    for pl in sample:
        n, _ = count_solutions(puzzle, [pl], limit=solution_cap)
        if n > 0:
            solvable += 1
            counts.append(n)
            if n == 1:
                unique += 1
        else:
            if impossibility_certificate(puzzle, [pl]) is not None:
                certified += 1

    return {
        "trials": trials,
        "baseline_solutions": baseline,
        "legal_placements": len(puzzle.placements),
        "solvable": solvable,
        "solvable_fraction": solvable / trials if trials else 0.0,
        "unique_solution": unique,
        "unique_fraction": unique / trials if trials else 0.0,
        "median_solutions_when_solvable": (
            sorted(counts)[len(counts) // 2] if counts else 0
        ),
        "max_solutions_when_solvable": max(counts) if counts else 0,
        "failures_caught_by_certificate": certified,
        "failures_total": trials - solvable,
    }


# --------------------------------------------------------------------------
# Puzzle definitions  <-- EDIT THIS SECTION FOR YOUR ACTUAL SET
# --------------------------------------------------------------------------

# A rhombus board, 6 wide x 4 deep = 24 cells, tiled by the 6 tetrahexes
# below. Verified to have solutions; used as the default demo so the survey
# produces meaningful numbers out of the box.
DEMO_BOARD = parse_shape("""
######
######
######
######
""")

DEMO_PIECES = [
    Piece("bar",   parse_shape("#\n#\n#\n#")),
    Piece("L",     parse_shape("##\n#.\n#.")),
    Piece("J",     parse_shape("#.\n#.\n##")),
    Piece("O",     parse_shape("##\n##")),
    Piece("S",     parse_shape("#.\n##\n.#")),
    Piece("Y",     parse_shape("#.#\n##.")),
]

# ---- Template for the real puzzle -----------------------------------------
# Replace the board mask and piece shapes with your set, then run --count.
# Remember: text columns are q, text lines are r, and the lattice is sheared,
# so a hexagonal board looks like a rhombus with '.' corners:
#
# HEX_BOARD = parse_shape("""
# ..###
# .####
# #####
# ####.
# ###..
# """)
#
# Set allow_flip=False on a Piece if its plastic is one-sided (bumps on top
# only). That halves the orientation count and sharply cuts solution totals.


def demo_puzzle() -> Puzzle:
    return Puzzle(DEMO_BOARD, DEMO_PIECES)


# --------------------------------------------------------------------------
# Self-test
# --------------------------------------------------------------------------

def selftest() -> bool:
    ok = True

    def check(label: str, got, want):
        nonlocal ok
        good = got == want
        ok &= good
        print(f"  [{'PASS' if good else 'FAIL'}] {label}: got {got}, want {want}")

    print("Self-test")

    # Orientation counts on known shapes.
    check("bar-2 orientations", len(orientations(parse_shape("##"))), 3)
    check("tri-hex triangle orientations", len(orientations(parse_shape("##\n#."))), 2)

    # Hand-verifiable exact cover: 2x2 rhombus, two labelled dihexes.
    # Unlabelled tilings: {two along q} and {two along r} -> 2.
    # With distinct labels each doubles -> 4.
    tiny = Puzzle(parse_shape("##\n##"),
                  [Piece("a", parse_shape("##")), Piece("b", parse_shape("##"))])
    n, _ = count_solutions(tiny)
    check("2x2 rhombus, 2 labelled dihexes", n, 4)

    # Dead-pocket certificate fires.
    pocket = Puzzle(parse_shape("###"), [Piece("d", parse_shape("##"))])
    check("area-mismatch certificate",
          impossibility_certificate(pocket) is not None, True)

    # Area check: unsolvable when piece area is short.
    check("short area is unsolvable", is_solvable(pocket), False)

    # Independent validation: enumerate free polyhexes by growth and compare
    # against the known sequence 1, 1, 3, 7, 22, 82 (OEIS A000228).
    def grow(shapes):
        out = set()
        for s in shapes:
            for cell in s:
                for nb in neighbours(cell):
                    if nb not in s:
                        canon = min(orientations(normalize(set(s) | {nb})),
                                    key=lambda x: sorted(x))
                        out.add(canon)
        return out

    level = {normalize({(0, 0)})}
    counts = [1]
    for _ in range(5):
        level = grow(level)
        counts.append(len(level))
    check("free polyhex counts n=1..6", counts, [1, 1, 3, 7, 22, 82])

    # Demo puzzle is internally consistent and actually solvable.
    demo = demo_puzzle()
    check("demo areas match", demo.piece_cells, demo.total_cells)
    check("demo is solvable", is_solvable(demo), True)

    print(f"\n{'ALL TESTS PASSED' if ok else 'FAILURES PRESENT'}")
    return ok


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--selftest", action="store_true", help="run correctness checks")
    ap.add_argument("--count", action="store_true", help="count all solutions of the puzzle")
    ap.add_argument("--survey", type=int, metavar="N",
                    help="sample N random placements and report solvability stats")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)

    if not (args.selftest or args.count or args.survey):
        ap.print_help()
        return 0

    if args.selftest:
        return 0 if selftest() else 1

    puzzle = demo_puzzle()
    print(f"Board: {puzzle.total_cells} cells | "
          f"Pieces: {len(puzzle.pieces)} ({puzzle.piece_cells} cells) | "
          f"Legal placements: {len(puzzle.placements)}")

    if args.count:
        n, samples = count_solutions(puzzle)
        print(f"\nTotal solutions: {n}")
        for i, sol in enumerate(samples, 1):
            print(f"  solution {i}: {sol}")

    if args.survey:
        print(f"\nSurveying {args.survey} random single placements...")
        stats = survey(puzzle, trials=args.survey, seed=args.seed)
        width = max(len(k) for k in stats)
        for k, v in stats.items():
            if isinstance(v, float):
                print(f"  {k:<{width}}  {v:.3f}")
            else:
                print(f"  {k:<{width}}  {v}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
