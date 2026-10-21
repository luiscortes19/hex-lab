/* Analysis worker. Runs in a background thread so a full count never freezes
   the board. Talks to the page with three messages:

     page -> worker  {type:"init", doc}              build the placement table once
     page -> worker  {type:"analyze", id, given, keep}
                        given: placement indices already on the board
                        keep:  how many complete solutions to send back for browsing
     worker -> page  {type:"progress", id, count, nodes}
     worker -> page  {type:"sols", id, solutions}    first `keep` solutions, sent early
     worker -> page  {type:"done", id, count, nodes, ms, use, solutions}
                        use[i] = how many completions use placement i

   Everything the page shows as statistics is derived from `use`: a placement
   with use>0 appears in at least one completion, so the set of such
   placements is exactly "where each piece can still go". */

let PZ = null;

self.onmessage = e => {
  const m = e.data;
  if (m.type === "init") { PZ = buildPuzzle(m.doc); return; }
  if (m.type === "analyze") analyze(m.id, m.given, m.keep);
};

function analyze(id, givenIdx, keep) {
  const t0 = Date.now();
  const P = PZ.placements;
  const use = new Uint32Array(P.length);
  const solutions = [];
  const stack = [];
  const { fullLo, fullHi, byCell } = PZ;

  const given = givenIdx.slice();
  let cLo = 0, cHi = 0, u = 0;
  for (const i of givenIdx) { cLo |= P[i].lo; cHi |= P[i].hi; u |= P[i].pieceBit; }

  let count = 0, nodes = 0, lastPost = t0;

  function rec(cLo, cHi, u) {
    nodes++;
    if ((nodes & 0xFFFF) === 0) {
      const now = Date.now();
      if (now - lastPost > 150) { lastPost = now; self.postMessage({ type: "progress", id, count, nodes }); }
    }
    if (cLo === fullLo && cHi === fullHi) {
      count++;
      for (let k = 0; k < stack.length; k++) use[stack[k]]++;
      if (solutions.length < keep) {
        solutions.push(given.concat(stack));
        if (solutions.length === keep) self.postMessage({ type: "sols", id, solutions });
      }
      return;
    }
    const low = lowestClear(cLo, cHi, fullLo, fullHi);
    const list = byCell[low];
    for (let k = 0; k < list.length; k++) {
      const pl = list[k];
      if ((pl.lo & cLo) === 0 && (pl.hi & cHi) === 0 && (pl.pieceBit & u) === 0) {
        stack.push(pl.idx);
        rec((cLo | pl.lo) >>> 0, (cHi | pl.hi) >>> 0, u | pl.pieceBit);
        stack.pop();
      }
    }
  }

  rec(cLo >>> 0, cHi >>> 0, u);
  self.postMessage({ type: "done", id, count, nodes, ms: Date.now() - t0, use, solutions }, [use.buffer]);
}
