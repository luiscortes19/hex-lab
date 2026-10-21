"""Bitmask exact-cover counter. 56 cells fit in one machine word."""
import sys
def count(pz, report=None):
    cells=sorted(pz.board); idx={c:i for i,c in enumerate(cells)}
    names=[p.name for p in pz.pieces]; pidx={n:i for i,n in enumerate(names)}
    full=(1<<len(cells))-1; allp=(1<<len(names))-1
    by_cell=[[] for _ in cells]
    for pl in pz.placements:
        m=0
        for c in pl.cells: m|=1<<idx[c]
        by_cell[min(idx[c] for c in pl.cells)].append((m,1<<pidx[pl.piece]))
    # order matters: index placements by their lowest cell so we always fill
    # the first empty cell -> no duplicate orderings, each solution counted once
    total=0; nodes=0
    def rec(covered, used):
        nonlocal total, nodes
        nodes+=1
        if covered==full:
            total+=1; return
        low=(~covered & full); low=(low & -low).bit_length()-1
        for m,pb in by_cell[low]:
            if not (m & covered) and not (pb & used):
                rec(covered|m, used|pb)
    sys.setrecursionlimit(10000)
    rec(0,0)
    return total, nodes
