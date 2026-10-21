#!/usr/bin/env python3
"""
puzzle_io.py — structured representation for polyhex puzzles.

Defines a JSON document that fully describes a board, a piece set, and
optionally a challenge (the clue pieces plus the intended solution). This is
the interchange format between the solver, the challenge generator, and the
viewer UI.

DOCUMENT SHAPE
--------------
{
  "schema": "polyhex/1",
  "name": "IQ Six Pro",
  "coordinates": "axial",          // neighbours: (+1,0)(-1,0)(0,+1)(0,-1)(+1,-1)(-1,+1)
  "board": [[q, r], ...],          // every playable cell
  "pieces": [
    {
      "id": "lime",
      "label": "Lime",
      "color": "#B4D335",
      "cells": [[q, r], ...],      // canonical orientation, origin-normalised
      "allowFlip": false           // true if the plastic is double-sided
    }
  ],
  "challenge": {                   // optional
    "given":    [{"piece": "lime", "cells": [[q, r], ...]}, ...],
    "solution": [{"piece": "lime", "cells": [[q, r], ...]}, ...],
    "completions": 1,
    "searchEffort": 14
  }
}

All coordinates are axial [q, r] integer pairs. Cells in `board` and in each
placement are absolute board positions; cells inside a `pieces` entry are the
shape's own local frame.

USAGE
-----
    python3 puzzle_io.py --export puzzle.json
    python3 puzzle_io.py --export challenge.json --challenge 3
    python3 puzzle_io.py --validate challenge.json
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from typing import Dict, List, Optional, Sequence

from polyhex_solver import (
    Piece,
    Placement,
    Puzzle,
    demo_puzzle,
    normalize,
    parse_shape,
)

SCHEMA = "polyhex/1"

# Colours sampled from the moulded plastic: lime, mint, sky, sun, tangerine,
# grape, cobalt, teal, blossom, vermilion, ultramarine, crimson.
PALETTE = [
    "#B4D335", "#6FD9BC", "#4FB4E8", "#F2C230", "#F5872E", "#7B4EA3",
    "#2E7BD6", "#159C93", "#EE6FA8", "#E8412C", "#1E3FBF", "#D6224C",
]


# --------------------------------------------------------------------------
# Serialisation
# --------------------------------------------------------------------------

def placement_to_dict(pl: Placement) -> dict:
    return {"piece": pl.piece, "cells": [list(c) for c in sorted(pl.cells)]}


def placement_from_dict(d: dict) -> Placement:
    return Placement(d["piece"], frozenset(tuple(c) for c in d["cells"]))


def puzzle_to_dict(puzzle: Puzzle, name: str = "Untitled",
                   colors: Optional[Dict[str, str]] = None,
                   labels: Optional[Dict[str, str]] = None) -> dict:
    colors = colors or {}
    labels = labels or {}
    pieces = []
    for i, p in enumerate(puzzle.pieces):
        pieces.append({
            "id": p.name,
            "label": labels.get(p.name, p.name),
            "color": colors.get(p.name, PALETTE[i % len(PALETTE)]),
            "cells": [list(c) for c in sorted(normalize(p.cells))],
            "allowFlip": p.allow_flip,
        })
    return {
        "schema": SCHEMA,
        "name": name,
        "coordinates": "axial",
        "board": [list(c) for c in sorted(puzzle.board)],
        "pieces": pieces,
    }


def puzzle_from_dict(doc: dict) -> Puzzle:
    if doc.get("schema") != SCHEMA:
        raise ValueError(f"unsupported schema {doc.get('schema')!r}, expected {SCHEMA!r}")
    if doc.get("coordinates", "axial") != "axial":
        raise ValueError("only axial coordinates are supported")
    board = frozenset(tuple(c) for c in doc["board"])
    pieces = [
        Piece(p["id"],
              frozenset(tuple(c) for c in p["cells"]),
              bool(p.get("allowFlip", True)))
        for p in doc["pieces"]
    ]
    return Puzzle(board, pieces)


def attach_challenge(doc: dict, given: Sequence[Placement],
                     solution: Sequence[Placement],
                     completions: Optional[int] = None,
                     search_effort: Optional[int] = None) -> dict:
    doc = dict(doc)
    doc["challenge"] = {
        "given": [placement_to_dict(p) for p in given],
        "solution": [placement_to_dict(p) for p in solution],
        "completions": completions,
        "searchEffort": search_effort,
    }
    return doc


def save(doc: dict, path: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2)
        fh.write("\n")


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------

def validate(doc: dict) -> List[str]:
    """Return a list of problems; empty means the document is well-formed."""
    problems: List[str] = []

    if doc.get("schema") != SCHEMA:
        problems.append(f"schema is {doc.get('schema')!r}, expected {SCHEMA!r}")
        return problems

    try:
        board = set(tuple(c) for c in doc["board"])
    except Exception as exc:
        problems.append(f"board is malformed: {exc}")
        return problems

    if not board:
        problems.append("board has no cells")

    ids = [p["id"] for p in doc.get("pieces", [])]
    if len(ids) != len(set(ids)):
        problems.append("piece ids are not unique")

    area = sum(len(p["cells"]) for p in doc.get("pieces", []))
    if area != len(board):
        problems.append(f"piece area {area} does not match board area {len(board)}")

    ch = doc.get("challenge")
    if ch:
        known = set(ids)
        for key in ("given", "solution"):
            seen_cells: set = set()
            for pl in ch.get(key, []):
                if pl["piece"] not in known:
                    problems.append(f"{key}: unknown piece {pl['piece']!r}")
                cells = set(tuple(c) for c in pl["cells"])
                if not cells <= board:
                    problems.append(f"{key}: {pl['piece']} extends off the board")
                if cells & seen_cells:
                    problems.append(f"{key}: {pl['piece']} overlaps another piece")
                seen_cells |= cells
            if key == "solution" and seen_cells and seen_cells != board:
                problems.append("solution does not cover the board exactly")

        given_ids = {p["piece"] for p in ch.get("given", [])}
        sol = {p["piece"]: set(tuple(c) for c in p["cells"]) for p in ch.get("solution", [])}
        for pl in ch.get("given", []):
            cells = set(tuple(c) for c in pl["cells"])
            if pl["piece"] in sol and sol[pl["piece"]] != cells:
                problems.append(f"clue {pl['piece']} contradicts the stated solution")
        if sol and not given_ids <= set(sol):
            problems.append("clue pieces are not a subset of the solution")

    return problems


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--export", metavar="PATH", help="write a puzzle document")
    ap.add_argument("--challenge", type=int, metavar="N",
                    help="include a challenge giving away N pieces")
    ap.add_argument("--name", default="Demo hex puzzle")
    ap.add_argument("--validate", metavar="PATH", help="check a document")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args(argv)

    if args.validate:
        problems = validate(load(args.validate))
        if problems:
            print(f"{len(problems)} problem(s) in {args.validate}:")
            for p in problems:
                print(f"  - {p}")
            return 1
        print(f"{args.validate}: valid")
        return 0

    if args.export:
        from challenge_generator import make_challenge

        rng = random.Random(args.seed)
        puzzle = demo_puzzle()
        doc = puzzle_to_dict(puzzle, name=args.name)

        if args.challenge is not None:
            ch = make_challenge(puzzle, args.challenge, rng)
            if ch is None:
                print("no challenge could be built", file=sys.stderr)
                return 1
            doc = attach_challenge(doc, ch.given, ch.solution,
                                   ch.n_completions, ch.search_effort)

        problems = validate(doc)
        if problems:
            print("refusing to write an invalid document:", file=sys.stderr)
            for p in problems:
                print(f"  - {p}", file=sys.stderr)
            return 1

        save(doc, args.export)
        print(f"wrote {args.export}")
        return 0

    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
