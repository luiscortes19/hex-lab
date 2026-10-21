/* Exact-cover solver for polyhex puzzles, browser-safe.
   Cell sets are held as two 32-bit halves (lo/hi) so boards up to 64 cells
   use plain integer ops instead of BigInt. */

const NEI = [[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];

const key = cells => cells.map(c=>c[0]+","+c[1]).sort().join(";");
function normalize(cells){
  const mq=Math.min(...cells.map(c=>c[0])), mr=Math.min(...cells.map(c=>c[1]));
  return cells.map(c=>[c[0]-mq,c[1]-mr]);
}
const rot60   = cells => cells.map(([q,r])=>[-r,q+r]);
const reflect = cells => cells.map(([q,r])=>[r,q]);

function orientations(cells, allowFlip){
  const seen=new Map();
  for(const base of (allowFlip ? [cells, reflect(cells)] : [cells])){
    let cur=base;
    for(let i=0;i<6;i++){
      const n=normalize(cur);
      seen.set(key(n), n);
      cur=rot60(cur);
    }
  }
  return [...seen.values()];
}

/* ---- build the placement table ---- */
function buildPuzzle(doc){
  const board=doc.board.map(c=>[c[0],c[1]]);
  const index=new Map(board.map((c,i)=>[c[0]+","+c[1], i]));
  const n=board.length;
  if(n>64) throw new Error("boards over 64 cells are not supported");
  const pieces=doc.pieces.map((p,i)=>({
    id:p.id, color:p.color, label:p.label||p.id, bit:1<<i,
    cells:p.cells.map(c=>[c[0],c[1]]), allowFlip:p.allowFlip!==false
  }));

  const qs=board.map(c=>c[0]), rs=board.map(c=>c[1]);
  const placements=[];
  for(const p of pieces){
    for(const o of orientations(p.cells,p.allowFlip)){
      for(let dq=Math.min(...qs)-1; dq<=Math.max(...qs)+1; dq++){
        for(let dr=Math.min(...rs)-1; dr<=Math.max(...rs)+1; dr++){
          const moved=o.map(([q,r])=>[q+dq,r+dr]);
          let lo=0,hi=0,ok=true,minI=99;
          for(const [q,r] of moved){
            const i=index.get(q+","+r);
            if(i===undefined){ok=false;break;}
            if(i<32) lo|=(1<<i); else hi|=(1<<(i-32));
            if(i<minI) minI=i;
          }
          if(ok) placements.push({idx:placements.length,piece:p.id,pieceBit:p.bit,cells:moved,lo:lo>>>0,hi:hi>>>0,minI});
        }
      }
    }
  }
  const fullLo = n>=32 ? 0xFFFFFFFF : ((1<<n)-1)>>>0;
  const fullHi = n>32 ? (((1<<(n-32))-1)>>>0) : 0;
  const byCell=Array.from({length:n},()=>[]);
  for(const pl of placements) byCell[pl.minI].push(pl);
  return {board,pieces,placements,byCell,n,fullLo,fullHi,allPieces:(1<<pieces.length)-1};
}

const lowestClear=(covLo,covHi,fullLo,fullHi)=>{
  const a=(~covLo & fullLo)>>>0;
  if(a) return 31-Math.clz32(a & -a);
  const b=(~covHi & fullHi)>>>0;
  return 32 + (31-Math.clz32(b & -b));
};

/* ---- count completions, capped ---- */
function countCompletions(pz, given, cap){
  let covLo=0,covHi=0,used=0;
  for(const pl of given){ covLo|=pl.lo; covHi|=pl.hi; used|=pl.pieceBit; }
  covLo>>>=0; covHi>>>=0;
  let total=0, nodes=0;
  const {fullLo,fullHi,byCell}=pz;
  function rec(cLo,cHi,u){
    nodes++;
    if(total>=cap) return;
    if(cLo===fullLo && cHi===fullHi){ total++; return; }
    const low=lowestClear(cLo,cHi,fullLo,fullHi);
    for(const pl of byCell[low]){
      if((pl.lo & cLo)===0 && (pl.hi & cHi)===0 && (pl.pieceBit & u)===0){
        rec((cLo|pl.lo)>>>0,(cHi|pl.hi)>>>0,u|pl.pieceBit);
        if(total>=cap) return;
      }
    }
  }
  rec(covLo,covHi,used);
  return {count:total, nodes, capped: total>=cap};
}

/* ---- one random full solution ---- */
function randomSolution(pz, rand){
  const order=pz.byCell.map(list=>{
    const a=list.slice();
    for(let i=a.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
    return a;
  });
  const {fullLo,fullHi}=pz;
  const out=[];
  function rec(cLo,cHi,u){
    if(cLo===fullLo && cHi===fullHi) return true;
    const low=lowestClear(cLo,cHi,fullLo,fullHi);
    for(const pl of order[low]){
      if((pl.lo & cLo)===0 && (pl.hi & cHi)===0 && (pl.pieceBit & u)===0){
        out.push(pl);
        if(rec((cLo|pl.lo)>>>0,(cHi|pl.hi)>>>0,u|pl.pieceBit)) return true;
        out.pop();
      }
    }
    return false;
  }
  return rec(0,0,0) ? out.slice() : null;
}

/* ---- a challenge that gives away n pieces ---- */
function makeChallenge(pz, n, rand, cap=500){
  const sol=randomSolution(pz,rand);
  if(!sol) return null;
  const idx=sol.map((_,i)=>i);
  for(let i=idx.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[idx[i],idx[j]]=[idx[j],idx[i]];}
  const given=idx.slice(0,n).map(i=>sol[i]);
  const {count,nodes,capped}=countCompletions(pz,given,cap);
  return {given, solution:sol, count, nodes, capped};
}


/* ---- every completion, capped ---- */
function allCompletions(pz, given, cap){
  let cLo=0,cHi=0,u=0;
  for(const p of given){ cLo|=p.lo; cHi|=p.hi; u|=p.pieceBit; }
  const out=[], cur=[];
  const {fullLo,fullHi,byCell}=pz;
  (function rec(cLo,cHi,u){
    if(out.length>=cap) return;
    if(cLo===fullLo && cHi===fullHi){ out.push(given.concat(cur)); return; }
    const low=lowestClear(cLo,cHi,fullLo,fullHi);
    for(const pl of byCell[low]){
      if((pl.lo&cLo)===0 && (pl.hi&cHi)===0 && (pl.pieceBit&u)===0){
        cur.push(pl); rec((cLo|pl.lo)>>>0,(cHi|pl.hi)>>>0,u|pl.pieceBit); cur.pop();
        if(out.length>=cap) return;
      }
    }
  })(cLo>>>0,cHi>>>0,u);
  return out;
}

/* ---- where can this piece legally go right now? ---- */
function legalSpots(pz, pieceId, given){
  let cLo=0,cHi=0,u=0;
  for(const p of given){ cLo|=p.lo; cHi|=p.hi; u|=p.pieceBit; }
  cLo>>>=0; cHi>>>=0;
  return pz.placements.filter(pl=>pl.piece===pieceId &&
    (pl.pieceBit&u)===0 && (pl.lo&cLo)===0 && (pl.hi&cHi)===0);
}
