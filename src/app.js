/* Hex Puzzle Lab — the page.
   Injected by build.py before this file runs:
     DEFAULT_DOC      the polyhex/1 puzzle
     EMPTY_ANALYSIS   precomputed stats for the empty board (or null)
     BUILD            {preview:boolean}
   The solver (solver.js) is loaded as a normal script for quick checks, and its
   source text is also handed to a background worker (worker.js) for full counts. */

const $ = id => document.getElementById(id);
const KEEP = 300;            // completions kept for browsing
const ANALYZE_DELAY = 220;   // ms to wait after a move before recounting

/* ---------- state ---------- */
let doc_ = null, PZ = null, colours = {}, labels = {}, byKey = new Map();
let given = [];              // placements on the board, oldest first
let dealt = new Set();       // placement idx that came from a deal
let dealtList = [];
let mode = "play";           // "play" | "browse"
let held = null;             // {id, cells} piece in hand, normalised
let hoverQR = null, grab = [0,0], dragging = false;
let downAt = null, liftedNow = false;
let hintOn = false, heatOn = false, showCoords = false;
let selCell = null;
let A = null;                // current analysis
let D = null;                // statistics derived from A
let solIdx = 0, prevSol = null;
let syncViable = null;       // hint fallback while the count is still running

/* ---------- hex geometry ---------- */
const R = 20, SQ3 = Math.sqrt(3);
const centre = (q,r) => ({x:R*SQ3*(q+r/2), y:R*1.5*r});
function corners(cx,cy,rad){const p=[];for(let i=0;i<6;i++){const a=Math.PI/180*(60*i-90);p.push([cx+rad*Math.cos(a),cy+rad*Math.sin(a)]);}return p;}
function pixelToAxial(x,y){
  const rf=(2/3*y)/R, qf=(SQ3/3*x - y/3)/R;
  let cx=qf, cz=rf, cy=-cx-cz;
  let rx=Math.round(cx), ry=Math.round(cy), rz=Math.round(cz);
  const dx=Math.abs(rx-cx), dy=Math.abs(ry-cy), dz=Math.abs(rz-cz);
  if(dx>dy&&dx>dz) rx=-ry-rz; else if(dy>dz) ry=-rx-rz; else rz=-rx-ry;
  return [rx,rz];
}
const norm = cs => {const a=Math.min(...cs.map(c=>c[0])),b=Math.min(...cs.map(c=>c[1])); return cs.map(c=>[c[0]-a,c[1]-b]);};
const rot60js = cs => cs.map(([q,r])=>[-r,q+r]);
const reflectjs = cs => cs.map(([q,r])=>[r,q]);
const shapeKey = cs => norm(cs).map(c=>c[0]+","+c[1]).sort().join(";");
const cellKey = c => c[0]+","+c[1];
const plKey = (piece,cells) => piece+"|"+cells.map(cellKey).sort().join(";");
const path = p => "M"+p.map(v=>v[0].toFixed(2)+","+v[1].toFixed(2)).join("L")+"Z";
const SVGNS = "http://www.w3.org/2000/svg";
function el(t,a){const n=document.createElementNS(SVGNS,t);for(const k in a)n.setAttribute(k,a[k]);return n;}
function hexToRgb(h){const n=parseInt(h.slice(1),16);return[n>>16&255,n>>8&255,n&255];}
function shade(hex,amt){const[r,g,b]=hexToRgb(hex);const f=c=>Math.round(amt>0?c+(255-c)*amt:c*(1+amt));return`rgb(${f(r)},${f(g)},${f(b)})`;}
const fmt = n => n.toLocaleString("en-US");
function compact(n){ return n>=1e9?(n/1e9).toFixed(1)+"B": n>=1e6?(n/1e6).toFixed(1)+"M": n>=1e4?Math.round(n/1e3)+"k": fmt(n); }
function anchorIndex(cells){
  const cx=cells.reduce((a,c)=>a+c[0],0)/cells.length, cy=cells.reduce((a,c)=>a+c[1],0)/cells.length;
  let best=0,bd=1e9; cells.forEach((c,i)=>{const d=(c[0]-cx)**2+(c[1]-cy)**2; if(d<bd){bd=d;best=i;}}); return best;
}

/* ---------- gem ---------- */
function drawPiece(parent,cells,colour,cls){
  const g=el("g",{class:"gem"+(cls?" "+cls:"")});
  cells.forEach(([q,r])=>{const{x,y}=centre(q,r); g.appendChild(el("path",{d:path(corners(x,y,R)),fill:shade(colour,-0.55)}));});
  cells.forEach(([q,r])=>{const{x,y}=centre(q,r);
    const o=corners(x,y,R*0.90), i2=corners(x,y,R*0.52);
    g.appendChild(el("path",{d:path(o),fill:shade(colour,-0.22)}));
    const lift=[0.26,0.10,-0.10,-0.26,-0.12,0.08];
    for(let i=0;i<6;i++){const j=(i+1)%6; g.appendChild(el("path",{d:path([o[i],o[j],i2[j],i2[i]]),fill:shade(colour,lift[i])}));}
    g.appendChild(el("path",{d:path(i2),fill:colour}));
    g.appendChild(el("path",{d:path(i2),fill:"none",stroke:shade(colour,0.34),"stroke-width":0.9}));
  });
  parent.appendChild(g); return g;
}

/* ---------- board queries ---------- */
function occupancy(list){ const m=new Map(); list.forEach(p=>p.cells.forEach(c=>m.set(cellKey(c),p))); return m; }
function emptyCells(){ const occ=occupancy(given); return doc_.board.filter(c=>!occ.has(cellKey(c))); }
function previewCells(){
  const cs=held.cells, ai=anchorIndex(cs);
  const tq=hoverQR[0]-grab[0], tr=hoverQR[1]-grab[1];
  const dq=tq-cs[ai][0], dr=tr-cs[ai][1];
  return cs.map(([q,r])=>[q+dq,r+dr]);
}
function previewValid(cells){
  const on=new Set(doc_.board.map(cellKey)), occ=occupancy(given);
  return cells.every(c=>on.has(cellKey(c)) && !occ.has(cellKey(c)));
}
function currentSpots(){
  if(!held) return [];
  const k=shapeKey(held.cells);
  return legalSpots(PZ,held.id,given).filter(sp=>shapeKey(sp.cells)===k);
}
const solved = () => given.length===PZ.pieces.length;

/* ---------- analysis (background worker) ---------- */
let worker=null, workerURL=null, jobId=0, pending=null;
function fingerprint(d){ return JSON.stringify([d.board, d.pieces.map(p=>[p.id,p.cells,p.allowFlip])]); }
function scheduleAnalyze(){ clearTimeout(pending); A=null; D=null; syncViable=null; updateStats(); pending=setTimeout(analyze, ANALYZE_DELAY); }
function analyze(){
  const id=++jobId;
  if(worker){ worker.terminate(); worker=null; }
  if(given.length===0 && typeof EMPTY_ANALYSIS!=="undefined" && EMPTY_ANALYSIS && EMPTY_ANALYSIS.fingerprint===fingerprint(doc_)){
    A={id,running:false,cached:true,count:EMPTY_ANALYSIS.count,nodes:EMPTY_ANALYSIS.nodes,ms:EMPTY_ANALYSIS.ms,
       use:Uint32Array.from(EMPTY_ANALYSIS.use),solutions:EMPTY_ANALYSIS.solutions};
    finish(); return;
  }
  A={id,running:true,count:0,nodes:0,use:null,solutions:[],t0:performance.now()};
  updateStats();
  try{
    if(!workerURL) workerURL=URL.createObjectURL(new Blob([$("solver-src").textContent+"\n"+$("worker-src").textContent],{type:"text/javascript"}));
    worker=new Worker(workerURL);
  }catch(e){ worker=null; }
  if(!worker){ analyzeInline(id); return; }
  worker.onmessage=e=>{
    const m=e.data; if(m.id!==jobId) return;
    if(m.type==="progress"){ A.count=m.count; A.nodes=m.nodes; updateStats(); }
    else if(m.type==="sols"){ A.solutions=m.solutions; if(mode==="browse") render(); updateStats(); }
    else if(m.type==="done"){ Object.assign(A,{running:false,count:m.count,nodes:m.nodes,ms:m.ms,use:m.use,solutions:m.solutions});
      worker.terminate(); worker=null; finish(); }
  };
  worker.onerror=()=>{ if(worker){worker.terminate();worker=null;} analyzeInline(id); };
  worker.postMessage({type:"init",doc:doc_});
  worker.postMessage({type:"analyze",id,given:given.map(p=>p.idx),keep:KEEP});
}
function analyzeInline(id){
  // no worker available: a capped count on the main thread, so the board stays usable
  setTimeout(()=>{
    if(id!==jobId) return;
    const t=performance.now();
    const sols=allCompletions(PZ,given,KEEP);
    const use=new Uint32Array(PZ.placements.length);
    const onBoard=new Set(given.map(p=>p.idx));
    sols.forEach(s=>s.forEach(p=>{ if(!onBoard.has(p.idx)) use[p.idx]++; }));
    Object.assign(A,{running:false,capped:sols.length>=KEEP,count:sols.length,nodes:0,ms:Math.round(performance.now()-t),
      use,solutions:sols.map(s=>s.map(p=>p.idx))});
    finish();
  },10);
}
function finish(){ D=derive(); if(solIdx>=((A&&A.solutions.length)||1)) solIdx=0; render(); renderChips(); updateStats(); }

function derive(){
  if(!A||A.running||!A.use) return null;
  const placed=new Set(given.map(p=>p.piece));
  const spots={}, locked=new Set(), perCell=new Map();
  PZ.pieces.forEach(p=>{ if(!placed.has(p.id)) spots[p.id]=0; });
  for(const pl of PZ.placements){
    const u=A.use[pl.idx]; if(!u) continue;
    spots[pl.piece]=(spots[pl.piece]||0)+1;
    if(u===A.count && !A.capped) locked.add(pl.piece);
    for(const c of pl.cells){ const k=cellKey(c); let m=perCell.get(k); if(!m){m=new Map();perCell.set(k,m);} m.set(pl.piece,(m.get(pl.piece)||0)+u); }
  }
  const empties=emptyCells(); let settled=0;
  for(const c of empties){ const m=perCell.get(cellKey(c)); if(m && m.size===1 && !A.capped) settled++; }
  return {spots,locked,perCell,settled,empties:empties.length,unplaced:Object.keys(spots).length};
}

/* ---------- readouts ---------- */
function updateStats(){
  const total=PZ.pieces.length;
  $("f-placed").textContent=given.length+" / "+total;
  $("f-empty").textContent=emptyCells().length;
  const fc=$("f-count"), sc=$("s-count"), sn=$("s-count-note");
  const sl=$("s-locked"), ss=$("s-settled"), sx=$("s-search"), sxn=$("s-search-note");
  fc.className=""; sc.className="";
  if(solved()){
    fc.textContent="solved"; fc.className="ok"; sc.textContent="Solved"; sc.className="ok";
    sn.textContent="every cell is filled"; sl.textContent="—"; ss.textContent="—"; sx.textContent="—"; sxn.textContent="";
  } else if(!A){
    fc.textContent="…"; sc.textContent="…"; sn.textContent="waiting for the board to settle";
    sl.textContent="…"; ss.textContent="…"; sx.textContent="…"; sxn.textContent="";
  } else if(A.running){
    const s=fmt(A.count)+"…"; fc.textContent=s; sc.textContent=s;
    sn.textContent="counting every completion";
    sl.textContent="…"; ss.textContent="…";
    sx.textContent=compact(A.nodes)+" nodes"; sxn.textContent=((performance.now()-A.t0)/1000).toFixed(1)+" s so far";
  } else {
    const c=A.count, cls=c===0?"bad":c===1?"ok":"warn";
    fc.textContent=c===0?"0 · dead end":c===1?"1 · unique":fmt(c)+(A.capped?"+":""); fc.className=cls;
    sc.textContent=fmt(c)+(A.capped?"+":""); sc.className=cls;
    sn.textContent=c===0?"no way to finish from here":c===1?"exactly one way to finish":A.capped?"at least this many (quick count)":"exact count";
    if(D && c>0){
      sl.textContent=D.locked.size+" of "+D.unplaced;
      ss.textContent=D.settled+" of "+D.empties;
    } else { sl.textContent="—"; ss.textContent="—"; }
    sx.textContent=A.cached?compact(A.nodes)+" nodes":A.nodes?compact(A.nodes)+" nodes":"quick count";
    sxn.textContent=A.cached?"computed ahead of time":(A.ms/1000).toFixed(A.ms<10000?2:0)+" s";
  }
  // banner over the board
  const b=$("banner");
  if(solved() && mode==="play"){ b.hidden=false; b.className="banner ok"; b.textContent="Solved. Every cell is filled."; }
  else if(A && !A.running && A.count===0 && mode==="play" && given.length){ b.hidden=false; b.className="banner bad"; b.textContent="No solution from here. Undo, or tap a piece to pick it back up."; }
  else b.hidden=true;
  // stepper
  const st=$("stepper"), n=(A&&A.solutions.length)||0;
  st.hidden = mode!=="browse";
  if(!st.hidden){
    const tail = A && !A.running && A.count>n ? " of "+fmt(A.count) : A && A.running ? " so far" : "";
    $("solpos").textContent = n ? (solIdx+1)+" / "+n+tail : "none";
  }
  $("play-tools").hidden = mode!=="play";
  $("btn-turn").disabled=!held; $("btn-flip").disabled=!held;
  $("btn-undo").disabled=!given.length && !held;
  $("btn-reset").disabled=!dealtList.length;
  updateCellInfo();
}

function updateCellInfo(){
  const box=$("cellinfo");
  if(!selCell){ box.textContent="Tap an empty cell to see which pieces can fill it."; return; }
  const occ=occupancy(given).get(selCell);
  const head="Cell "+selCell;
  if(occ){ box.innerHTML=""; box.append(head+" holds "+(labels[occ.piece]||occ.piece)+"."); return; }
  if(!A||A.running||!D){ box.textContent=head+": waiting for the count to finish."; return; }
  if(A.count===0){ box.textContent=head+": no completion fills it."; return; }
  const m=D.perCell.get(selCell); if(!m){ box.textContent=head+": no completion fills it."; return; }
  const rows=[...m.entries()].sort((a,b)=>b[1]-a[1]);
  box.innerHTML="";
  const h=document.createElement("div"); h.className="ci-head"; h.textContent=head+(rows.length===1?" is always "+(labels[rows[0][0]]||rows[0][0]):" can be "+rows.length+" pieces");
  box.appendChild(h);
  const list=document.createElement("div"); list.className="ci-rows";
  rows.forEach(([id,u])=>{
    const share=u/A.count;
    const r=document.createElement("div"); r.className="ci-row";
    const sw=document.createElement("i"); sw.style.background=colours[id];
    const nm=document.createElement("span"); nm.textContent=labels[id]||id;
    const bar=document.createElement("b"); const fill=document.createElement("u"); fill.style.width=(share*100).toFixed(1)+"%"; fill.style.background=colours[id]; bar.appendChild(fill);
    const pc=document.createElement("em"); pc.textContent=(share*100<1&&share>0)?"<1%":Math.round(share*100)+"%";
    r.append(sw,nm,bar,pc); list.appendChild(r);
  });
  box.appendChild(list);
}

/* ---------- board ---------- */
function shownPlacements(){
  if(mode==="browse"){
    const s=A&&A.solutions[solIdx];
    return s ? s.map(i=>PZ.placements[i]) : given;
  }
  return given;
}
function render(){
  const svg=$("board"); svg.textContent="";
  let mnX=1e9,mxX=-1e9,mnY=1e9,mxY=-1e9;
  doc_.board.forEach(([q,r])=>{const{x,y}=centre(q,r); mnX=Math.min(mnX,x);mxX=Math.max(mxX,x);mnY=Math.min(mnY,y);mxY=Math.max(mxY,y);});
  const pad=R*1.3;
  svg.setAttribute("viewBox",`${mnX-pad} ${mnY-pad} ${mxX-mnX+2*pad} ${mxY-mnY+2*pad}`);

  const base=el("g",{});
  doc_.board.forEach(([q,r])=>{const{x,y}=centre(q,r); const c=corners(x,y,R*0.93);
    base.appendChild(el("path",{d:path(c),class:"cell-empty"}));
    base.appendChild(el("path",{d:`M${c[3][0].toFixed(2)},${c[3][1].toFixed(2)}L${c[4][0].toFixed(2)},${c[4][1].toFixed(2)}L${c[5][0].toFixed(2)},${c[5][1].toFixed(2)}L${c[0][0].toFixed(2)},${c[0][1].toFixed(2)}`,class:"cell-lip"}));});
  svg.appendChild(base);

  // heat map: each empty cell tinted by the piece that fills it most often
  if(mode==="play" && heatOn && D && A && A.count>0){
    const g=el("g",{class:"heat"}), occ=occupancy(given);
    doc_.board.forEach(c=>{ const k=cellKey(c); if(occ.has(k)) return;
      const m=D.perCell.get(k); if(!m) return;
      let best=null,bu=0; for(const [id,u] of m) if(u>bu){bu=u;best=id;}
      const share=bu/A.count, {x,y}=centre(c[0],c[1]);
      g.appendChild(el("path",{d:path(corners(x,y,R*0.80)),fill:colours[best],"fill-opacity":(0.14+0.6*share).toFixed(3)}));
      if(m.size===1) g.appendChild(el("path",{d:path(corners(x,y,R*0.80)),fill:"none",stroke:colours[best],"stroke-width":1.6}));
    });
    svg.appendChild(g);
  }

  const shown=shownPlacements();
  const layer=el("g",{class:mode==="browse"?"reveal":""});
  shown.forEach(pl=>{
    const g=drawPiece(layer,pl.cells,colours[pl.piece]||"#8a9299", mode==="play"&&dealt.has(pl.idx)?"dealt":"");
    const t=el("title",{}); t.textContent=(labels[pl.piece]||pl.piece)+(dealt.has(pl.idx)?" (dealt clue)":""); g.appendChild(t);
    if(mode==="play" && dealt.has(pl.idx)){ const c=pl.cells[anchorIndex(pl.cells)], {x,y}=centre(c[0],c[1]); layer.appendChild(el("circle",{cx:x,cy:y,r:2.6,class:"pin"})); }
  });
  svg.appendChild(layer);

  if(mode==="browse" && prevSol){
    const now=occupancy(shown), was=occupancy(prevSol), g=el("g",{});
    for(const [k,p] of now){ const w=was.get(k); if(!w||w.piece!==p.piece){ const[q,r]=k.split(",").map(Number); const{x,y}=centre(q,r);
      g.appendChild(el("path",{d:path(corners(x,y,R*0.95)),class:"changed"})); } }
    svg.appendChild(g);
  }

  if(selCell && mode==="play"){ const[q,r]=selCell.split(",").map(Number); const{x,y}=centre(q,r);
    svg.appendChild(el("path",{d:path(corners(x,y,R*0.97)),class:"selcell"})); }

  // hint: outlines for every spot of the held piece in its current orientation
  if(mode==="play" && held && hintOn){
    const spots=currentSpots(), g=el("g",{});
    const ok = sp => (D&&A&&!A.capped) ? A.use[sp.idx]>0 : (syncViable ? syncViable.has(sp.idx) : null);
    spots.forEach(sp=>{ const v=ok(sp);
      sp.cells.forEach(([q,r])=>{const{x,y}=centre(q,r);
        g.appendChild(el("path",{d:path(corners(x,y,R*0.62)),fill:"none",
          stroke:v?"var(--ok)":"var(--dim)","stroke-width":v?1.8:1,"stroke-dasharray":v?"":"2 3","stroke-opacity":v?0.9:0.45}));});
    });
    svg.appendChild(g);
  }

  if(mode==="play" && held && hoverQR){
    const cells=previewCells(), ok=previewValid(cells);
    const g=el("g",{class:"preview"});
    if(ok){ drawPiece(g,cells,colours[held.id]||"#8a9299"); g.setAttribute("opacity","0.86"); }
    else cells.forEach(([q,r])=>{const{x,y}=centre(q,r); g.appendChild(el("path",{d:path(corners(x,y,R*0.88)),class:"bad-cell"}));});
    svg.appendChild(g);
  }

  if(showCoords){
    const g=el("g",{});
    doc_.board.forEach(([q,r])=>{const{x,y}=centre(q,r); const t=el("text",{x:x.toFixed(1),y:(y+R*0.78).toFixed(1),class:"coord"}); t.textContent=`${q},${r}`; g.appendChild(t);});
    svg.appendChild(g);
  }
  updateStats();
}

/* ---------- chips ---------- */
function renderChips(){
  const box=$("chips"); box.textContent="";
  const placed=new Set(given.map(p=>p.piece));
  doc_.pieces.forEach(p=>{
    const b=document.createElement("button");
    const isPlaced=placed.has(p.id), isHeld=held&&held.id===p.id;
    b.className="chip"+(D&&D.locked.has(p.id)?" locked":"");
    b.dataset.placed=isPlaced;
    b.setAttribute("aria-pressed",!!isHeld);
    b.disabled = mode!=="play";
    const svg=el("svg",{}); const cs=norm(p.cells.map(c=>[c[0],c[1]]));
    let a=1e9,b2=-1e9,c2=1e9,d2=-1e9;
    cs.forEach(([q,r])=>{const{x,y}=centre(q,r);a=Math.min(a,x);b2=Math.max(b2,x);c2=Math.min(c2,y);d2=Math.max(d2,y);});
    svg.setAttribute("viewBox",`${a-R} ${c2-R} ${b2-a+2*R} ${d2-c2+2*R}`);
    drawPiece(svg,cs,p.color||"#8a9299"); b.appendChild(svg);
    const s=document.createElement("span"); s.textContent=labels[p.id]||p.id; b.appendChild(s);
    const badge=document.createElement("em");
    if(isPlaced) badge.textContent="placed";
    else if(!A||A.running) badge.textContent="…";
    else if(A.count===0) badge.textContent="0";
    else if(D&&D.locked.has(p.id)) badge.textContent="locked";
    else if(D) badge.textContent=(D.spots[p.id]||0)+(A.capped?"+":"")+" spots";
    b.appendChild(badge);
    b.title = isPlaced ? "On the board. Tap it on the board to pick it up."
      : D ? (D.locked.has(p.id) ? "Goes in the same spot in every completion." : (D.spots[p.id]||0)+" distinct spots appear across the completions.")
      : "Pick up";
    b.addEventListener("pointerdown",ev=>{
      if(mode!=="play") return;
      ev.preventDefault();
      if(isPlaced){ const pl=given.find(g=>g.piece===p.id); lift(pl,false); }
      else if(isHeld){ drop(); }
      else pickUp(p.id);
      dragging=true; downAt=[ev.clientX,ev.clientY]; liftedNow=true;
    });
    box.appendChild(b);
  });
  $("rail-note").textContent = mode!=="play" ? "Browsing completions. Switch to Play to move pieces."
    : held ? "Drag or tap on the board to drop it. Turn and Flip reshape it. Tap the chip again to put it away."
    : "The badge shows how many distinct spots each piece takes across all completions.";
}

/* ---------- moves ---------- */
function pickUp(id){
  const p=doc_.pieces.find(p=>p.id===id);
  held={id,cells:norm(p.cells.map(c=>[c[0],c[1]]))}; grab=[0,0];
  syncViable=null; computeSyncHint(); render(); renderChips();
}
function lift(pl,keepPos){
  given=given.filter(g=>g!==pl); dealt.delete(pl.idx);
  const cells=pl.cells.map(c=>[c[0],c[1]]);
  held={id:pl.piece,cells:norm(cells)};
  if(keepPos){ hoverQR=cells[anchorIndex(held.cells)]; }
  selCell=null; scheduleAnalyze(); render(); renderChips();
}
function drop(){ held=null; hoverQR=null; grab=[0,0]; render(); renderChips(); }
function turn(){ if(!held) return; held.cells=norm(rot60js(held.cells)); syncViable=null; computeSyncHint(); render(); }
function flipHeld(){ if(!held) return; held.cells=norm(reflectjs(held.cells)); syncViable=null; computeSyncHint(); render(); }
function tryPlace(){
  if(!held||!hoverQR) return false;
  const cells=previewCells(); if(!previewValid(cells)) return false;
  const pl=byKey.get(plKey(held.id,cells)); if(!pl) return false;
  given=given.concat([pl]); held=null; hoverQR=null; grab=[0,0]; selCell=null;
  scheduleAnalyze(); render(); renderChips(); return true;
}
function undo(){
  if(held){ drop(); return; }
  if(!given.length) return;
  const pl=given[given.length-1]; given=given.slice(0,-1); dealt.delete(pl.idx);
  scheduleAnalyze(); render(); renderChips();
}
function clearBoard(){ given=[]; dealt=new Set(); dealtList=[]; held=null; hoverQR=null; selCell=null; scheduleAnalyze(); setMode("play"); }
function backToClues(){ given=dealtList.slice(); dealt=new Set(dealtList.map(p=>p.idx)); held=null; hoverQR=null; selCell=null; scheduleAnalyze(); setMode("play"); }
function deal(){
  const n=+$("clues").value, btn=$("btn-new"), st=$("genstatus");
  btn.disabled=true; st.textContent="Dealing…";
  setTimeout(()=>{
    const ch=makeChallenge(PZ,n,Math.random,1);
    btn.disabled=false;
    if(!ch){ st.textContent="Could not find a solution to deal from."; return; }
    given=ch.given.slice(); dealtList=given.slice(); dealt=new Set(given.map(p=>p.idx));
    held=null; hoverQR=null; selCell=null; solIdx=0; prevSol=null;
    st.textContent="Dealt "+n+" clue"+(n===1?"":"s")+" from a random solution.";
    scheduleAnalyze(); setMode("play");
  },20);
}
function computeSyncHint(){
  // only needed while the full count is still running
  if(!hintOn||!held||(D&&A&&!A.capped)) return;
  const spots=currentSpots();
  if(spots.length>160) return;
  syncViable=new Set(spots.filter(sp=>countCompletions(PZ,given.concat([sp]),1).count>0).map(sp=>sp.idx));
}

/* ---------- browsing ---------- */
function step(d){
  if(mode!=="browse"||!A||!A.solutions.length) return;
  prevSol=shownPlacements(); solIdx=(solIdx+d+A.solutions.length)%A.solutions.length; render();
}
function setMode(m){
  mode=m;
  $("btn-play").setAttribute("aria-pressed",m==="play");
  $("btn-browse").setAttribute("aria-pressed",m==="browse");
  if(m==="browse"){ held=null; hoverQR=null; prevSol=null; solIdx=0; }
  render(); renderChips();
}

/* ---------- pointer ---------- */
function svgPoint(evt){
  const svg=$("board"), pt=svg.createSVGPoint(); pt.x=evt.clientX; pt.y=evt.clientY;
  const m=svg.getScreenCTM(); if(!m) return null; const p=pt.matrixTransform(m.inverse()); return [p.x,p.y];
}
function cellAt(evt){ const p=svgPoint(evt); return p ? pixelToAxial(p[0],p[1]) : null; }
function overBoard(evt){ const r=$("board").getBoundingClientRect(); return evt.clientX>=r.left&&evt.clientX<=r.right&&evt.clientY>=r.top&&evt.clientY<=r.bottom; }
function updateHover(evt){
  if(mode!=="play"||!held) return;
  const qr=cellAt(evt); if(!qr) return;
  if(!hoverQR||hoverQR[0]!==qr[0]||hoverQR[1]!==qr[1]){ hoverQR=qr; render(); }
}
const boardEl=$("board");
boardEl.addEventListener("pointerdown",e=>{
  if(mode!=="play") return;
  e.preventDefault();
  downAt=[e.clientX,e.clientY]; liftedNow=false;
  if(held){ updateHover(e); dragging=true; return; }
  const qr=cellAt(e); if(!qr) return;
  const k=cellKey(qr), occ=occupancy(given).get(k);
  if(occ){
    // pick the piece up where it lies, holding it by the cell that was touched
    lift(occ,true);
    const ai=anchorIndex(held.cells), anchor=hoverQR;
    grab=[qr[0]-anchor[0],qr[1]-anchor[1]]; hoverQR=qr;
    dragging=true; liftedNow=true; render();
  } else if(doc_.board.some(c=>cellKey(c)===k)){
    selCell = selCell===k ? null : k; render();
  }
});
boardEl.addEventListener("pointermove",updateHover);
boardEl.addEventListener("pointerleave",()=>{ if(hoverQR && !dragging){ hoverQR=null; render(); } });
document.addEventListener("pointermove",e=>{ if(dragging&&held) updateHover(e); });
document.addEventListener("pointerup",e=>{
  if(!dragging){ return; }
  dragging=false;
  if(!held) return;
  const moved = downAt ? Math.hypot(e.clientX-downAt[0], e.clientY-downAt[1]) : 99;
  if(liftedNow && moved<6) return;          // a tap only picks up; the next tap drops
  if(overBoard(e)){ updateHover(e); tryPlace(); }
});

/* ---------- controls ---------- */
$("btn-play").onclick=()=>setMode("play");
$("btn-browse").onclick=()=>setMode("browse");
$("btn-prev").onclick=()=>step(-1);
$("btn-next").onclick=()=>step(1);
$("btn-turn").onclick=turn;
$("btn-flip").onclick=flipHeld;
$("btn-undo").onclick=undo;
$("btn-empty").onclick=clearBoard;
$("btn-reset").onclick=backToClues;
$("btn-new").onclick=deal;
$("btn-hint").onclick=e=>{ hintOn=!hintOn; e.currentTarget.setAttribute("aria-pressed",hintOn); syncViable=null; computeSyncHint(); render(); };
$("btn-heat").onclick=e=>{ heatOn=!heatOn; e.currentTarget.setAttribute("aria-pressed",heatOn); render(); };
$("btn-coords").onclick=e=>{ showCoords=!showCoords; e.currentTarget.setAttribute("aria-pressed",showCoords); render(); };
$("clues").addEventListener("input",e=>{ $("clueval").textContent=e.target.value; });
$("btn-download").onclick=()=>{
  const sol = A&&A.solutions[solIdx] ? A.solutions[solIdx].map(i=>PZ.placements[i]) : given;
  const out=Object.assign({},doc_,{challenge:{given:given.map(p=>({piece:p.piece,cells:p.cells})),
    solution:sol.map(p=>({piece:p.piece,cells:p.cells})),completions:A&&!A.running?A.count:null}});
  const blob=new Blob([JSON.stringify(out,null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="hex-puzzle.json"; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
};
function flash(t,e){ const m=$("msg"); m.textContent=t; m.className="msg "+(e?"err":"ok"); }
$("btn-load").onclick=()=>{
  const raw=$("paste").value.trim();
  if(!raw){ flash("Paste a puzzle file's contents first.",true); return; }
  try{ setDoc(JSON.parse(raw)); }catch(e){ flash("That is not valid JSON: "+e.message,true); }
};
$("file").onchange=e=>{
  const f=e.target.files[0]; if(!f) return;
  f.text().then(t=>{ try{ setDoc(JSON.parse(t)); }catch(err){ flash("That is not valid JSON: "+err.message,true); } });
};
document.addEventListener("keydown",e=>{
  if(e.target.matches("input,textarea")) return;
  if(e.key==="r"||e.key==="R") turn();
  else if(e.key==="f"||e.key==="F") flipHeld();
  else if(e.key==="Escape"){ if(held) drop(); else if(selCell){ selCell=null; render(); } }
  else if(e.key==="ArrowRight") step(1);
  else if(e.key==="ArrowLeft") step(-1);
  else if(e.key==="z"&&(e.metaKey||e.ctrlKey)){ e.preventDefault(); undo(); }
});

/* ---------- loading ---------- */
function validate(d){
  const e=[];
  if(!d||typeof d!=="object") return ["the file is not a JSON object"];
  if(d.schema!=="polyhex/1") e.push(`schema is ${JSON.stringify(d.schema)}, expected "polyhex/1"`);
  if(!Array.isArray(d.board)||!d.board.length) e.push("the board is missing or empty");
  if(!Array.isArray(d.pieces)||!d.pieces.length) e.push("the piece list is missing or empty");
  if(e.length) return e;
  const area=d.pieces.reduce((s,p)=>s+(p.cells?p.cells.length:0),0);
  if(area!==d.board.length) e.push(`the pieces cover ${area} cells but the board has ${d.board.length}`);
  if(d.pieces.length>31) e.push("at most 31 pieces are supported");
  return e;
}
function setDoc(d){
  const errs=validate(d);
  if(errs.length){ flash("Not loaded: "+errs.join("; ")+".",true); return false; }
  let pz; try{ pz=buildPuzzle(d); }catch(err){ flash("Not loaded: "+err.message,true); return false; }
  doc_=d; PZ=pz; colours={}; labels={};
  d.pieces.forEach(p=>{ colours[p.id]=p.color||"#8a9299"; labels[p.id]=p.label||p.id; });
  byKey=new Map(PZ.placements.map(p=>[plKey(p.piece,p.cells),p]));
  const ch=d.challenge||{};
  given=(ch.given||[]).map(g=>byKey.get(plKey(g.piece,g.cells))).filter(Boolean);
  dealtList=given.slice(); dealt=new Set(given.map(p=>p.idx));
  held=null; hoverQR=null; selCell=null; solIdx=0; prevSol=null;
  const sl=$("clues"); sl.max=Math.max(1,d.pieces.length-1); if(+sl.value>+sl.max) sl.value=sl.max; $("clueval").textContent=sl.value;
  $("title").textContent=d.name||"Hex Puzzle Lab";
  if(worker){ worker.terminate(); worker=null; }
  scheduleAnalyze(); setMode("play");
  flash("Loaded "+(d.name||"the puzzle")+".",false);
  return true;
}

/* ---------- install + offline (installed build only) ---------- */
function setupInstall(){
  if(BUILD.preview){ $("btn-download").hidden=true; return; }
  const badge=$("pwa"), btxt=$("pwatext"), ibtn=$("btn-install");
  const show=(t,warn)=>{ badge.hidden=false; btxt.textContent=t; badge.classList.toggle("off",!!warn); };
  if("serviceWorker" in navigator && location.protocol!=="file:"){
    window.addEventListener("load",()=>{
      navigator.serviceWorker.register("./sw.js").then(reg=>{
        if(navigator.serviceWorker.controller) show("ready offline");
        reg.addEventListener("updatefound",()=>{ const w=reg.installing;
          if(w) w.addEventListener("statechange",()=>{ if(w.state==="activated") show("ready offline"); }); });
      }).catch(()=>show("offline copy unavailable",true));
    });
  }
  let deferred=null;
  window.addEventListener("beforeinstallprompt",e=>{ e.preventDefault(); deferred=e; ibtn.hidden=false; });
  ibtn.addEventListener("click",async()=>{ if(!deferred) return; deferred.prompt(); try{await deferred.userChoice;}catch(_){} deferred=null; ibtn.hidden=true; });
  window.addEventListener("appinstalled",()=>{ ibtn.hidden=true; show("installed"); });
}

setupInstall();
setDoc(DEFAULT_DOC);
$("msg").textContent="";
