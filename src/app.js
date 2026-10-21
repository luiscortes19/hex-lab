/* Hex Puzzle Lab — phone-first UI.
   Injected by build.py before this file runs:
     DEFAULT_DOC      the polyhex/1 puzzle
     EMPTY_ANALYSIS   precomputed stats for the empty board (or null)
     BUILD            {preview:boolean}
   solver.js runs here for quick checks; its source is also handed to a
   background worker (worker.js) that does the full counts. */

const $ = id => document.getElementById(id);
const KEEP = 300;            // completions kept for browsing
const ANALYZE_DELAY = 220;   // ms after a move before recounting
const LIFT_PX = 64;          // touch drags float the piece this far above the finger

/* ---------- state ---------- */
let doc_=null, PZ=null, colours={}, labels={}, byKey=new Map();
let given=[], dealt=new Set(), dealtList=[];
let mode="play";             // "play" | "browse"
let held=null;               // {id, cells} the piece in hand, normalised
let hoverQR=null, grab=[0,0];
let gesture=null;            // the pointer gesture in progress
let hintOn=false, heatOn=false, showCoords=false, buzzOn=true;
let selCell=null, A=null, D=null, solIdx=0, prevSol=null, syncViable=null;
let clueN=4, openSheet=null;

/* ---------- geometry ----------
   Axial (q,r) on a pointy-top lattice. On a tall screen the whole board is
   turned 90° so it fills the height: ROT swaps the drawing axes, and
   pixelToAxial undoes it, so the rest of the code never knows. */
const R=20, SQ3=Math.sqrt(3);
let ROT=false;
const base=(q,r)=>({x:R*SQ3*(q+r/2), y:R*1.5*r});
const centre=(q,r)=>{ const p=base(q,r); return ROT?{x:-p.y,y:p.x}:p; };
function corners(cx,cy,rad){const off=ROT?0:-90,p=[];for(let i=0;i<6;i++){const a=Math.PI/180*(60*i+off);p.push([cx+rad*Math.cos(a),cy+rad*Math.sin(a)]);}return p;}
function pixelToAxial(X,Y){
  const x=ROT?Y:X, y=ROT?-X:Y;
  const rf=(2/3*y)/R, qf=(SQ3/3*x-y/3)/R;
  let cx=qf, cz=rf, cy=-cx-cz;
  let rx=Math.round(cx), ry=Math.round(cy), rz=Math.round(cz);
  const dx=Math.abs(rx-cx), dy=Math.abs(ry-cy), dz=Math.abs(rz-cz);
  if(dx>dy&&dx>dz) rx=-ry-rz; else if(dy>dz) ry=-rx-rz; else rz=-rx-ry;
  return [rx,rz];
}
const norm=cs=>{const a=Math.min(...cs.map(c=>c[0])),b=Math.min(...cs.map(c=>c[1]));return cs.map(c=>[c[0]-a,c[1]-b]);};
const rot60js=cs=>cs.map(([q,r])=>[-r,q+r]);
const reflectjs=cs=>cs.map(([q,r])=>[r,q]);
const shapeKey=cs=>norm(cs).map(c=>c[0]+","+c[1]).sort().join(";");
const cellKey=c=>c[0]+","+c[1];
const plKey=(piece,cells)=>piece+"|"+cells.map(cellKey).sort().join(";");
const path=p=>"M"+p.map(v=>v[0].toFixed(2)+","+v[1].toFixed(2)).join("L")+"Z";
const SVGNS="http://www.w3.org/2000/svg";
function el(t,a){const n=document.createElementNS(SVGNS,t);for(const k in a)n.setAttribute(k,a[k]);return n;}
function hexToRgb(h){const n=parseInt(h.slice(1),16);return[n>>16&255,n>>8&255,n&255];}
function shade(hex,amt){const[r,g,b]=hexToRgb(hex);const f=c=>Math.round(amt>0?c+(255-c)*amt:c*(1+amt));return`rgb(${f(r)},${f(g)},${f(b)})`;}
const fmt=n=>n.toLocaleString("en-US");
const compact=n=>n>=1e9?(n/1e9).toFixed(1)+"B":n>=1e6?(n/1e6).toFixed(1)+"M":n>=1e4?Math.round(n/1e3)+"k":fmt(n);
function anchorIndex(cells){
  const cx=cells.reduce((a,c)=>a+c[0],0)/cells.length, cy=cells.reduce((a,c)=>a+c[1],0)/cells.length;
  let best=0,bd=1e9; cells.forEach((c,i)=>{const d=(c[0]-cx)**2+(c[1]-cy)**2; if(d<bd){bd=d;best=i;}}); return best;
}
function buzz(p){ if(buzzOn && navigator.vibrate) try{ navigator.vibrate(p); }catch(_){} }

/* ---------- gem ---------- */
const LIFT=[0.26,0.10,-0.10,-0.26,-0.12,0.08];
function drawPiece(parent,cells,colour,cls){
  const g=el("g",{class:"gem"+(cls?" "+cls:"")});
  // keep the light coming from the upper left when the board is turned
  const lift = ROT ? LIFT.map((_,i)=>(LIFT[(i+1)%6]+LIFT[(i+2)%6])/2) : LIFT;
  cells.forEach(([q,r])=>{const{x,y}=centre(q,r); g.appendChild(el("path",{d:path(corners(x,y,R)),fill:shade(colour,-0.55)}));});
  cells.forEach(([q,r])=>{const{x,y}=centre(q,r);
    const o=corners(x,y,R*0.90), i2=corners(x,y,R*0.52);
    g.appendChild(el("path",{d:path(o),fill:shade(colour,-0.22)}));
    for(let i=0;i<6;i++){const j=(i+1)%6; g.appendChild(el("path",{d:path([o[i],o[j],i2[j],i2[i]]),fill:shade(colour,lift[i])}));}
    g.appendChild(el("path",{d:path(i2),fill:colour}));
    g.appendChild(el("path",{d:path(i2),fill:"none",stroke:shade(colour,0.34),"stroke-width":0.9}));
  });
  parent.appendChild(g); return g;
}
function fitViewBox(svg,cells,pad){
  let a=1e9,b=-1e9,c=1e9,d=-1e9;
  cells.forEach(([q,r])=>{const p=centre(q,r);a=Math.min(a,p.x);b=Math.max(b,p.x);c=Math.min(c,p.y);d=Math.max(d,p.y);});
  svg.setAttribute("viewBox",`${a-pad} ${c-pad} ${b-a+2*pad} ${d-c+2*pad}`);
}
function pieceIcon(cells,colour){ const s=el("svg",{}); fitViewBox(s,cells,R); drawPiece(s,cells,colour); return s; }

/* ---------- board queries ---------- */
function occupancy(list){const m=new Map(); list.forEach(p=>p.cells.forEach(c=>m.set(cellKey(c),p))); return m;}
function emptyCells(){const o=occupancy(given); return doc_.board.filter(c=>!o.has(cellKey(c)));}
function previewCells(){
  const cs=held.cells, ai=anchorIndex(cs), tq=hoverQR[0]-grab[0], tr=hoverQR[1]-grab[1];
  return cs.map(([q,r])=>[q+tq-cs[ai][0], r+tr-cs[ai][1]]);
}
function previewValid(cells){const on=new Set(doc_.board.map(cellKey)), o=occupancy(given); return cells.every(c=>on.has(cellKey(c))&&!o.has(cellKey(c)));}
function currentSpots(){ if(!held) return []; const k=shapeKey(held.cells); return legalSpots(PZ,held.id,given).filter(sp=>shapeKey(sp.cells)===k); }
const solved=()=>given.length===PZ.pieces.length;

/* ---------- analysis (background worker) ---------- */
let worker=null, workerURL=null, jobId=0, pending=null;
function fingerprint(d){return JSON.stringify([d.board,d.pieces.map(p=>[p.id,p.cells,p.allowFlip])]);}
function scheduleAnalyze(){ clearTimeout(pending); A=null; D=null; syncViable=null; refresh(); pending=setTimeout(analyze,ANALYZE_DELAY); }
function analyze(){
  const id=++jobId;
  if(worker){worker.terminate();worker=null;}
  if(given.length===0 && EMPTY_ANALYSIS && EMPTY_ANALYSIS.fingerprint===fingerprint(doc_)){
    A={id,running:false,cached:true,count:EMPTY_ANALYSIS.count,nodes:EMPTY_ANALYSIS.nodes,ms:EMPTY_ANALYSIS.ms,
       use:Uint32Array.from(EMPTY_ANALYSIS.use),solutions:EMPTY_ANALYSIS.solutions};
    finish(); return;
  }
  A={id,running:true,count:0,nodes:0,use:null,solutions:[],t0:performance.now()};
  refresh();
  try{
    if(!workerURL) workerURL=URL.createObjectURL(new Blob([$("solver-src").textContent+"\n"+$("worker-src").textContent],{type:"text/javascript"}));
    worker=new Worker(workerURL);
  }catch(e){worker=null;}
  if(!worker){analyzeInline(id);return;}
  worker.onmessage=e=>{
    const m=e.data; if(m.id!==jobId) return;
    if(m.type==="progress"){A.count=m.count;A.nodes=m.nodes;refreshCount();}
    else if(m.type==="sols"){A.solutions=m.solutions; if(mode==="browse") render(); refreshCount();}
    else if(m.type==="done"){Object.assign(A,{running:false,count:m.count,nodes:m.nodes,ms:m.ms,use:m.use,solutions:m.solutions});worker.terminate();worker=null;finish();}
  };
  worker.onerror=()=>{ if(worker){worker.terminate();worker=null;} analyzeInline(id); };
  worker.postMessage({type:"init",doc:doc_});
  worker.postMessage({type:"analyze",id,given:given.map(p=>p.idx),keep:KEEP});
}
function analyzeInline(id){
  setTimeout(()=>{
    if(id!==jobId) return;
    const t=performance.now(), sols=allCompletions(PZ,given,KEEP), use=new Uint32Array(PZ.placements.length), on=new Set(given.map(p=>p.idx));
    sols.forEach(s=>s.forEach(p=>{ if(!on.has(p.idx)) use[p.idx]++; }));
    Object.assign(A,{running:false,capped:sols.length>=KEEP,count:sols.length,nodes:0,ms:Math.round(performance.now()-t),use,solutions:sols.map(s=>s.map(p=>p.idx))});
    finish();
  },10);
}
function finish(){
  D=derive();
  if(solIdx>=((A&&A.solutions.length)||1)) solIdx=0;
  if(A && !A.running && A.count===0 && given.length) buzz([25,40,25]);
  render(); renderTray(); refresh();
}
function derive(){
  if(!A||A.running||!A.use) return null;
  const placed=new Set(given.map(p=>p.piece)), spots={}, locked=new Set(), perCell=new Map();
  PZ.pieces.forEach(p=>{ if(!placed.has(p.id)) spots[p.id]=0; });
  for(const pl of PZ.placements){
    const u=A.use[pl.idx]; if(!u) continue;
    spots[pl.piece]=(spots[pl.piece]||0)+1;
    if(u===A.count&&!A.capped) locked.add(pl.piece);
    for(const c of pl.cells){const k=cellKey(c); let m=perCell.get(k); if(!m){m=new Map();perCell.set(k,m);} m.set(pl.piece,(m.get(pl.piece)||0)+u);}
  }
  const empties=emptyCells(); let settled=0;
  for(const c of empties){const m=perCell.get(cellKey(c)); if(m&&m.size===1&&!A.capped) settled++;}
  return {spots,locked,perCell,settled,empties:empties.length,unplaced:Object.keys(spots).length};
}

/* ---------- readouts ---------- */
function refreshCount(){
  const btn=$("count"), num=$("count-num"), sub=$("count-sub");
  btn.className="count";
  if(solved()){ num.textContent="Solved"; sub.textContent="every cell is filled"; btn.classList.add("ok"); }
  else if(!A){ num.textContent="…"; sub.textContent="settling"; }
  else if(A.running){ num.textContent=fmt(A.count)+"…"; sub.textContent="counting ways to finish"; }
  else if(A.count===0){ num.textContent="0"; sub.textContent="no way to finish"; btn.classList.add("bad"); }
  else if(A.count===1){ num.textContent="1"; sub.textContent="exactly one way to finish"; btn.classList.add("ok"); }
  else { num.textContent=fmt(A.count)+(A.capped?"+":""); sub.textContent="ways to finish"; btn.classList.add("warn"); }
  const n=PZ.pieces.length;
  $("placed-txt").textContent=given.length+" / "+n;
  $("placed-bar").style.width=(100*given.length/n)+"%";
  if(mode==="browse"){
    const k=(A&&A.solutions.length)||0;
    const tail=A&&!A.running&&A.count>k?" of "+fmt(A.count):A&&A.running?" so far":"";
    $("solpos").textContent=k?(solIdx+1)+" / "+k+tail:"no completions";
  }
  if(openSheet==="stats") renderStats();
}
function refresh(){
  refreshCount();
  $("act-idle").hidden = !(mode==="play" && !held);
  $("act-held").hidden = !(mode==="play" && held);
  $("act-browse").hidden = mode!=="browse";
  $("tray").hidden = mode!=="play";
  $("browse-note").hidden = mode!=="browse";
  $("btn-undo").disabled = !given.length;
  $("btn-reset").disabled = !dealtList.length;
  $("btn-hint").setAttribute("aria-pressed",hintOn); $("opt-hint").checked=hintOn;
  $("btn-heat").setAttribute("aria-pressed",heatOn); $("opt-heat").checked=heatOn;
  $("tab-play").toggleAttribute("aria-current",mode==="play"&&!openSheet);
  $("tab-browse").toggleAttribute("aria-current",mode==="browse"&&!openSheet);
  $("tab-stats").toggleAttribute("aria-current",openSheet==="stats");
  $("tab-menu").toggleAttribute("aria-current",openSheet==="menu");
  ["tab-play","tab-browse","tab-stats","tab-menu"].forEach(t=>{ if($(t).hasAttribute("aria-current")) $(t).setAttribute("aria-current","page"); });
  const t=$("toast");
  if(mode==="play" && A && !A.running && A.count===0 && given.length){ t.hidden=false; t.className="toast bad"; t.textContent="No solution from here. Undo, or tap a piece on the board to pick it up."; }
  else t.hidden=true;
  renderCellCard();
}
function renderCellCard(){
  const card=$("cellcard"), body=$("cellcard-body");
  if(!selCell||mode!=="play"||held){ card.hidden=true; return; }
  card.hidden=false; body.textContent="";
  const head=document.createElement("div"); head.className="ci-head";
  const occ=occupancy(given).get(selCell);
  if(occ){ head.textContent=(labels[occ.piece]||occ.piece)+" is here."; body.appendChild(head); return; }
  if(!A||A.running||!D){ head.textContent="Counting… the breakdown appears when it finishes."; body.appendChild(head); return; }
  const m=D.perCell.get(selCell);
  if(A.count===0||!m){ head.textContent="No completion can fill this cell."; body.appendChild(head); return; }
  const rows=[...m.entries()].sort((a,b)=>b[1]-a[1]);
  head.textContent = rows.length===1 ? "Always "+(labels[rows[0][0]]||rows[0][0])+" here." : rows.length+" pieces can fill this cell:";
  body.appendChild(head);
  const list=document.createElement("div"); list.className="ci-rows";
  rows.slice(0,5).forEach(([id,u])=>{
    const share=u/A.count, r=document.createElement("div"); r.className="ci-row";
    const sw=document.createElement("i"); sw.style.background=colours[id];
    const nm=document.createElement("span"); nm.textContent=labels[id]||id;
    const bar=document.createElement("b"), fill=document.createElement("u"); fill.style.width=(share*100).toFixed(1)+"%"; fill.style.background=colours[id]; bar.appendChild(fill);
    const pc=document.createElement("em"); pc.textContent=share>0&&share<.01?"<1%":Math.round(share*100)+"%";
    r.append(sw,nm,bar,pc); list.appendChild(r);
  });
  if(rows.length>5){ const more=document.createElement("div"); more.className="ci-row"; more.innerHTML="<i></i>"; const s=document.createElement("span"); s.textContent="+"+(rows.length-5)+" more"; more.appendChild(s); list.appendChild(more); }
  body.appendChild(list);
}

/* ---------- board ---------- */
function shownPlacements(){
  if(mode==="browse"){ const s=A&&A.solutions[solIdx]; return s?s.map(i=>PZ.placements[i]):given; }
  return given;
}
function render(){
  const stage=$("stage"), svg=$("board");
  const w=stage.clientWidth, h=stage.clientHeight;
  ROT = h > w*1.08;
  svg.textContent="";
  fitViewBox(svg,doc_.board,R*1.15);

  const g0=el("g",{});
  doc_.board.forEach(([q,r])=>{const{x,y}=centre(q,r), c=corners(x,y,R*0.93);
    g0.appendChild(el("path",{d:path(c),class:"cell-empty"}));
    g0.appendChild(el("path",{d:`M${c[3][0].toFixed(2)},${c[3][1].toFixed(2)}L${c[4][0].toFixed(2)},${c[4][1].toFixed(2)}L${c[5][0].toFixed(2)},${c[5][1].toFixed(2)}L${c[0][0].toFixed(2)},${c[0][1].toFixed(2)}`,class:"cell-lip"}));});
  svg.appendChild(g0);

  if(mode==="play" && heatOn && D && A && A.count>0){
    const g=el("g",{class:"heat"}), occ=occupancy(given);
    doc_.board.forEach(c=>{ const k=cellKey(c); if(occ.has(k)) return; const m=D.perCell.get(k); if(!m) return;
      let best=null,bu=0; for(const [id,u] of m) if(u>bu){bu=u;best=id;}
      const share=bu/A.count, {x,y}=centre(c[0],c[1]);
      g.appendChild(el("path",{d:path(corners(x,y,R*0.8)),fill:colours[best],"fill-opacity":(0.14+0.6*share).toFixed(3)}));
      if(m.size===1) g.appendChild(el("path",{d:path(corners(x,y,R*0.8)),fill:"none",stroke:colours[best],"stroke-width":1.6}));
    });
    svg.appendChild(g);
  }

  const shown=shownPlacements(), layer=el("g",{class:mode==="browse"?"reveal":""});
  shown.forEach(pl=>{
    drawPiece(layer,pl.cells,colours[pl.piece]);
    if(mode==="play"&&dealt.has(pl.idx)){ const c=pl.cells[anchorIndex(pl.cells)], p=centre(c[0],c[1]); layer.appendChild(el("circle",{cx:p.x,cy:p.y,r:2.6,class:"pin"})); }
  });
  svg.appendChild(layer);

  if(mode==="browse" && prevSol){
    const now=occupancy(shown), was=occupancy(prevSol), g=el("g",{});
    for(const [k,p] of now){ const w2=was.get(k); if(!w2||w2.piece!==p.piece){ const[q,r]=k.split(",").map(Number), c=centre(q,r); g.appendChild(el("path",{d:path(corners(c.x,c.y,R*0.95)),class:"changed"})); } }
    svg.appendChild(g);
  }
  if(selCell && mode==="play" && !held){ const[q,r]=selCell.split(",").map(Number), c=centre(q,r); svg.appendChild(el("path",{d:path(corners(c.x,c.y,R*0.97)),class:"selcell"})); }

  if(mode==="play" && held && hintOn){
    const g=el("g",{}), exact=D&&A&&!A.capped;
    currentSpots().forEach(sp=>{ const v=exact?A.use[sp.idx]>0:(syncViable?syncViable.has(sp.idx):null);
      sp.cells.forEach(([q,r])=>{const c=centre(q,r); g.appendChild(el("path",{d:path(corners(c.x,c.y,R*0.6)),fill:"none",
        stroke:v?"var(--ok)":"var(--dim)","stroke-width":v?1.8:1,"stroke-dasharray":v?"":"2 3","stroke-opacity":v?0.9:0.45}));});});
    svg.appendChild(g);
  }
  if(mode==="play" && held && hoverQR){
    const cells=previewCells(), ok=previewValid(cells), g=el("g",{class:"preview"});
    if(ok){ drawPiece(g,cells,colours[held.id]); g.setAttribute("opacity","0.88"); }
    else cells.forEach(([q,r])=>{const c=centre(q,r); g.appendChild(el("path",{d:path(corners(c.x,c.y,R*0.88)),class:"bad-cell"}));});
    svg.appendChild(g);
  }
  if(showCoords){
    const g=el("g",{});
    doc_.board.forEach(([q,r])=>{const c=centre(q,r), t=el("text",{x:c.x.toFixed(1),y:c.y.toFixed(1),class:"coord"}); t.textContent=`${q},${r}`; g.appendChild(t);});
    svg.appendChild(g);
  }
  refresh();
}

/* ---------- piece tray ---------- */
function renderTray(){
  const tray=$("tray"), keep=tray.scrollLeft; tray.textContent="";
  const placed=new Set(given.map(p=>p.piece));
  doc_.pieces.forEach(p=>{
    const isPlaced=placed.has(p.id), isHeld=held&&held.id===p.id;
    const b=document.createElement("button");
    b.className="card"+(D&&D.locked.has(p.id)?" locked":"");
    b.dataset.piece=p.id; b.dataset.placed=isPlaced; b.setAttribute("aria-pressed",!!isHeld);
    const shape = isHeld ? held.cells : norm(p.cells.map(c=>[c[0],c[1]]));
    b.appendChild(pieceIcon(shape,colours[p.id]));
    const em=document.createElement("em");
    em.textContent = isHeld ? "in hand" : isPlaced ? "placed" : !A||A.running ? "…" : A.count===0 ? "—" : D&&D.locked.has(p.id) ? "locked" : D ? (D.spots[p.id]||0)+(A.capped?"+":"")+" spots" : "";
    b.appendChild(em);
    b.setAttribute("aria-label",(labels[p.id]||p.id)+", "+em.textContent);
    tray.appendChild(b);
  });
  tray.scrollLeft=keep;
}

/* ---------- moves ---------- */
function pickUp(id){
  const p=doc_.pieces.find(p=>p.id===id);
  held={id,cells:norm(p.cells.map(c=>[c[0],c[1]]))}; grab=[0,0]; hoverQR=null; selCell=null;
  syncViable=null; computeSyncHint(); render(); renderTray();
}
function lift(pl,at){
  given=given.filter(g=>g!==pl); dealt.delete(pl.idx);
  const cells=pl.cells.map(c=>[c[0],c[1]]);
  held={id:pl.piece,cells:norm(cells)};
  const anchor=cells[anchorIndex(held.cells)];
  if(at){ grab=[at[0]-anchor[0],at[1]-anchor[1]]; hoverQR=at; } else { grab=[0,0]; hoverQR=null; }
  selCell=null; scheduleAnalyze(); render(); renderTray();
}
function putBack(){ held=null; hoverQR=null; grab=[0,0]; render(); renderTray(); }
function turn(){ if(!held) return; held.cells=norm(rot60js(held.cells)); grab=[0,0]; syncViable=null; computeSyncHint(); render(); renderTray(); }
function flipHeld(){ if(!held) return; held.cells=norm(reflectjs(held.cells)); grab=[0,0]; syncViable=null; computeSyncHint(); render(); renderTray(); }
function tryPlace(){
  if(!held||!hoverQR) return false;
  const cells=previewCells();
  if(!previewValid(cells)){ buzz([30,40,30]); return false; }
  const pl=byKey.get(plKey(held.id,cells)); if(!pl) return false;
  given=given.concat([pl]); held=null; hoverQR=null; grab=[0,0]; selCell=null;
  buzz(12); scheduleAnalyze(); render(); renderTray(); return true;
}
function undo(){
  if(held){ putBack(); return; }
  if(!given.length) return;
  const pl=given[given.length-1]; given=given.slice(0,-1); dealt.delete(pl.idx);
  scheduleAnalyze(); render(); renderTray();
}
function newGame(list){
  given=list.slice(); dealtList=list.slice(); dealt=new Set(list.map(p=>p.idx));
  held=null; hoverQR=null; selCell=null; solIdx=0; prevSol=null;
  closeSheet(); setMode("play"); scheduleAnalyze(); renderTray();
}
function deal(){
  const st=$("genstatus"); st.textContent="Dealing…";
  setTimeout(()=>{
    const ch=makeChallenge(PZ,clueN,Math.random,1);
    if(!ch){ st.textContent="Could not find a solution to deal from."; return; }
    st.textContent="Dealt "+clueN+" clue"+(clueN===1?"":"s")+" from a random solution.";
    newGame(ch.given);
  },20);
}
function computeSyncHint(){
  if(!hintOn||!held||(D&&A&&!A.capped)) return;
  const spots=currentSpots(); if(spots.length>160) return;
  syncViable=new Set(spots.filter(sp=>countCompletions(PZ,given.concat([sp]),1).count>0).map(sp=>sp.idx));
}

/* ---------- modes + sheets ---------- */
function setMode(m){
  mode=m;
  if(m==="browse"){ held=null; hoverQR=null; prevSol=null; selCell=null; }
  render(); renderTray();
}
function step(d){
  if(mode!=="browse"||!A||!A.solutions.length) return;
  prevSol=shownPlacements(); solIdx=(solIdx+d+A.solutions.length)%A.solutions.length; render();
}
function showSheet(name){
  openSheet=name;
  $("scrim").hidden=false;
  $("sheet-stats").hidden=name!=="stats"; $("sheet-menu").hidden=name!=="menu";
  if(name==="stats") renderStats();
  refresh();
}
function closeSheet(){ openSheet=null; $("scrim").hidden=true; $("sheet-stats").hidden=true; $("sheet-menu").hidden=true; refresh(); }
function renderStats(){
  const sc=$("s-count"), sn=$("s-count-note"), sl=$("s-locked"), ss=$("s-settled"), sx=$("s-search"), sxn=$("s-search-note");
  sc.className="";
  if(solved()){ sc.textContent="Solved"; sc.className="ok"; sn.textContent="every cell is filled"; sl.textContent=ss.textContent=sx.textContent="—"; sxn.textContent=""; }
  else if(!A||A.running){ sc.textContent=A?fmt(A.count)+"…":"…"; sn.textContent="counting"; sl.textContent=ss.textContent="…";
    sx.textContent=A?compact(A.nodes)+" nodes":"…"; sxn.textContent=A?((performance.now()-A.t0)/1000).toFixed(1)+" s so far":""; }
  else {
    const c=A.count; sc.textContent=fmt(c)+(A.capped?"+":""); sc.className=c===0?"bad":c===1?"ok":"warn";
    sn.textContent=c===0?"no way to finish":c===1?"unique":A.capped?"at least (quick count)":"exact";
    sl.textContent=D&&c>0?D.locked.size+" of "+D.unplaced:"—";
    ss.textContent=D&&c>0?D.settled+" of "+D.empties:"—";
    sx.textContent=A.nodes?compact(A.nodes)+" nodes":"quick count";
    sxn.textContent=A.cached?"computed ahead of time":(A.ms/1000).toFixed(A.ms<10000?2:0)+" s";
  }
  const box=$("spots"); box.textContent="";
  const placed=new Set(given.map(p=>p.piece));
  const max=D?Math.max(1,...Object.values(D.spots)):1;
  doc_.pieces.slice().sort((a,b)=>{
    const sa=placed.has(a.id)?1e9:(D?D.spots[a.id]||0:0), sb=placed.has(b.id)?1e9:(D?D.spots[b.id]||0:0); return sa-sb;
  }).forEach(p=>{
    const row=document.createElement("div"); const isPl=placed.has(p.id), n=D?D.spots[p.id]||0:0;
    row.className="spot"+(isPl?" placed":"")+(D&&D.locked.has(p.id)?" locked":"");
    row.appendChild(pieceIcon(norm(p.cells.map(c=>[c[0],c[1]])),colours[p.id]));
    const nm=document.createElement("span"); nm.textContent=labels[p.id]||p.id;
    const bar=document.createElement("b"), fill=document.createElement("u");
    fill.style.width=isPl||!D?"0":(100*n/max).toFixed(1)+"%"; fill.style.background=colours[p.id]; bar.appendChild(fill);
    const em=document.createElement("em");
    em.textContent=isPl?"placed":!D?"…":D.locked.has(p.id)?"locked":fmt(n);
    row.append(nm,bar,em); box.appendChild(row);
  });
}

/* ---------- pointer gestures ----------
   One handler set covers four gestures:
     tray card, drag upward     -> pick the piece up and drag it onto the board
     tray card, tap             -> pick up (or put back / lift if on the board)
     board, with a piece held   -> drag or tap to drop it
     board, nothing held        -> tap a piece to pick it up, tap an empty cell for its breakdown
     board, Solutions tab       -> swipe sideways to step through completions        */
function svgPoint(x,y){ const svg=$("board"), pt=svg.createSVGPoint(); pt.x=x; pt.y=y; const m=svg.getScreenCTM(); if(!m) return null; const p=pt.matrixTransform(m.inverse()); return [p.x,p.y]; }
function cellAtClient(x,y){ const p=svgPoint(x,y); return p?pixelToAxial(p[0],p[1]):null; }
function overStage(x,y){ const r=$("stage").getBoundingClientRect(); return x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom; }
function hoverAt(x,y,touchLift){
  if(!held) return;
  if(!overStage(x,y)){ if(hoverQR){ hoverQR=null; render(); } return; }
  const qr=cellAtClient(x, y-(touchLift?LIFT_PX:0)); if(!qr) return;
  if(!hoverQR||hoverQR[0]!==qr[0]||hoverQR[1]!==qr[1]){ hoverQR=qr; render(); }
}
$("tray").addEventListener("pointerdown",e=>{
  const card=e.target.closest(".card"); if(!card||mode!=="play") return;
  gesture={kind:"card", id:card.dataset.piece, placed:card.dataset.placed==="true", x0:e.clientX, y0:e.clientY, touch:e.pointerType!=="mouse", dragging:false};
});
$("stage").addEventListener("pointerdown",e=>{
  if(openSheet) return;
  e.preventDefault();
  const touch=e.pointerType!=="mouse";
  if(mode==="browse"){ gesture={kind:"swipe",x0:e.clientX,y0:e.clientY}; return; }
  if(held){ gesture={kind:"drop",x0:e.clientX,y0:e.clientY,touch,moved:false}; hoverAt(e.clientX,e.clientY,false); return; }
  const qr=cellAtClient(e.clientX,e.clientY); if(!qr) return;
  const k=cellKey(qr), occ=occupancy(given).get(k);
  if(occ){ lift(occ,qr); gesture={kind:"drop",x0:e.clientX,y0:e.clientY,touch,moved:false,lifted:true}; }
  else if(doc_.board.some(c=>cellKey(c)===k)){ selCell=selCell===k?null:k; render(); }
  else if(selCell){ selCell=null; render(); }
});
document.addEventListener("pointermove",e=>{
  if(!gesture) return;
  const dx=e.clientX-gesture.x0, dy=e.clientY-gesture.y0, dist=Math.hypot(dx,dy);
  if(gesture.kind==="card"){
    if(!gesture.dragging && dy<-10 && Math.abs(dy)>Math.abs(dx)*1.2){
      gesture.dragging=true;
      if(gesture.placed){ const pl=given.find(g=>g.piece===gesture.id); if(pl) lift(pl,null); } else if(!held||held.id!==gesture.id) pickUp(gesture.id);
    }
    if(gesture.dragging){ e.preventDefault(); hoverAt(e.clientX,e.clientY,gesture.touch); }
  } else if(gesture.kind==="drop"){
    if(dist>6) gesture.moved=true;
    if(gesture.moved) hoverAt(e.clientX,e.clientY,gesture.touch);
  }
},{passive:false});
document.addEventListener("pointerup",e=>{
  const g=gesture; gesture=null; if(!g) return;
  const dx=e.clientX-g.x0, dy=e.clientY-g.y0, dist=Math.hypot(dx,dy);
  if(g.kind==="card"){
    if(g.dragging){ if(overStage(e.clientX,e.clientY)){ hoverAt(e.clientX,e.clientY,g.touch); tryPlace(); } return; }
    if(dist<10){
      if(held&&held.id===g.id) putBack();
      else if(g.placed){ const pl=given.find(x=>x.piece===g.id); if(pl) lift(pl,null); }
      else pickUp(g.id);
    }
  } else if(g.kind==="drop"){
    if(g.lifted && !g.moved) return;          // a tap only picks the piece up
    if(overStage(e.clientX,e.clientY)){ hoverAt(e.clientX,e.clientY,g.touch&&g.moved); tryPlace(); }
  } else if(g.kind==="swipe"){
    if(Math.abs(dx)>45 && Math.abs(dx)>Math.abs(dy)) step(dx<0?1:-1);
  }
});
document.addEventListener("pointercancel",()=>{ gesture=null; });
$("stage").addEventListener("pointermove",e=>{ if(!gesture && held && e.pointerType==="mouse") hoverAt(e.clientX,e.clientY,false); });
$("stage").addEventListener("pointerleave",e=>{ if(!gesture && hoverQR && e.pointerType==="mouse"){ hoverQR=null; render(); } });

/* ---------- controls ---------- */
$("count").onclick=()=>showSheet("stats");
$("tab-play").onclick=()=>{ closeSheet(); setMode("play"); };
$("tab-browse").onclick=()=>{ closeSheet(); setMode("browse"); };
$("tab-stats").onclick=()=>openSheet==="stats"?closeSheet():showSheet("stats");
$("tab-menu").onclick=()=>openSheet==="menu"?closeSheet():showSheet("menu");
$("scrim").onclick=closeSheet;
document.querySelectorAll("[data-close]").forEach(b=>b.onclick=closeSheet);
$("cellcard-x").onclick=()=>{ selCell=null; render(); };
$("btn-turn").onclick=turn; $("btn-flip").onclick=flipHeld; $("btn-putback").onclick=putBack;
$("btn-undo").onclick=undo;
$("btn-prev").onclick=()=>step(-1); $("btn-next").onclick=()=>step(1);
function setHint(v){ hintOn=v; syncViable=null; computeSyncHint(); render(); }
function setHeat(v){ heatOn=v; render(); }
$("btn-hint").onclick=()=>setHint(!hintOn); $("opt-hint").onchange=e=>setHint(e.target.checked);
$("btn-heat").onclick=()=>setHeat(!heatOn); $("opt-heat").onchange=e=>setHeat(e.target.checked);
$("opt-coords").onchange=e=>{ showCoords=e.target.checked; render(); };
$("opt-buzz").onchange=e=>{ buzzOn=e.target.checked; if(buzzOn) buzz(12); };
$("btn-empty").onclick=()=>newGame([]);
$("btn-reset").onclick=()=>newGame(dealtList);
$("btn-new").onclick=deal;
function setClues(n){ clueN=Math.max(1,Math.min(PZ.pieces.length-1,n)); $("clueval").textContent=clueN; }
$("clue-minus").onclick=()=>setClues(clueN-1); $("clue-plus").onclick=()=>setClues(clueN+1);
$("btn-download").onclick=()=>{
  const sol=A&&A.solutions[solIdx]?A.solutions[solIdx].map(i=>PZ.placements[i]):given;
  const out=Object.assign({},doc_,{challenge:{given:given.map(p=>({piece:p.piece,cells:p.cells})),solution:sol.map(p=>({piece:p.piece,cells:p.cells})),completions:A&&!A.running?A.count:null}});
  const blob=new Blob([JSON.stringify(out,null,2)],{type:"application/json"}), a=document.createElement("a");
  a.href=URL.createObjectURL(blob); a.download="hex-puzzle.json"; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
};
function flash(t,e){ const m=$("msg"); m.textContent=t; m.className="msg "+(e?"err":"ok"); }
$("btn-load").onclick=()=>{ const raw=$("paste").value.trim(); if(!raw){ flash("Paste a puzzle file's contents first.",true); return; }
  try{ setDoc(JSON.parse(raw)); }catch(e){ flash("That is not valid JSON: "+e.message,true); } };
$("file").onchange=e=>{ const f=e.target.files[0]; if(!f) return;
  f.text().then(t=>{ try{ setDoc(JSON.parse(t)); }catch(err){ flash("That is not valid JSON: "+err.message,true); } }); };
document.addEventListener("keydown",e=>{
  if(e.target.matches("input,textarea")) return;
  if(e.key==="r"||e.key==="R") turn();
  else if(e.key==="f"||e.key==="F") flipHeld();
  else if(e.key==="Escape"){ if(openSheet) closeSheet(); else if(held) putBack(); else if(selCell){ selCell=null; render(); } }
  else if(e.key==="ArrowRight") step(1);
  else if(e.key==="ArrowLeft") step(-1);
  else if(e.key==="z"&&(e.metaKey||e.ctrlKey)){ e.preventDefault(); undo(); }
});
new ResizeObserver(()=>{ if(doc_) render(); }).observe($("stage"));

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
  setClues(clueN);
  if(worker){ worker.terminate(); worker=null; }
  newGame((ch.given||[]).map(g=>byKey.get(plKey(g.piece,g.cells))).filter(Boolean));
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
        reg.addEventListener("updatefound",()=>{ const w=reg.installing; if(w) w.addEventListener("statechange",()=>{ if(w.state==="activated") show("ready offline"); }); });
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
