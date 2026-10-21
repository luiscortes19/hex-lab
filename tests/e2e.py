"""End-to-end check of the built app in headless Chromium.  python3 tests/e2e.py"""
import threading, http.server, socketserver, pathlib, sys, time
from playwright.sync_api import sync_playwright
DOCS = str(pathlib.Path(__file__).resolve().parent.parent / "docs")
class Q(http.server.SimpleHTTPRequestHandler):
    def __init__(s,*a,**k): super().__init__(*a, directory=DOCS, **k)
    def log_message(s,*a): pass
srv = socketserver.TCPServer(("127.0.0.1",0), Q); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{port}/index.html"
fails = []
def check(label, cond, detail=""):
    print(("PASS " if cond else "FAIL ")+label+(f"  [{detail}]" if detail else ""))
    if not cond: fails.append(label)

def screen_xy(pg, q, r):
    return pg.evaluate(f"""(()=>{{const pt=centre({q},{r}); const svg=document.getElementById('board');
      const p=svg.createSVGPoint(); p.x=pt.x; p.y=pt.y; const s=p.matrixTransform(svg.getScreenCTM()); return [s.x,s.y];}})()""")
def wait_count(pg, timeout=120):
    pg.wait_for_function("A && !A.running", timeout=timeout*1000)
    return pg.evaluate("A.count")

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width":1200,"height":1000}, has_touch=True)
    pg = ctx.new_page(); errs=[]
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
    pg.goto(URL); pg.wait_for_timeout(800)

    # 1. empty board opens with exact stats straight away
    c = wait_count(pg, 5)
    check("empty board shows the exact total instantly", c==59494, f"{c}, header '{pg.inner_text('#f-count')}'")
    badges = pg.eval_on_selector_all(".chip em","e=>e.map(x=>x.textContent)")
    check("each chip shows its spot count", all("spots" in t for t in badges), ", ".join(badges[:4])+"…")

    # 2. place a piece by dragging it from its chip to a viable spot
    tgt = pg.evaluate("""(()=>{ pickUp('orange');
       const sp=currentSpots().find(s=>A.use[s.idx]>0); drop();
       return {cells:sp.cells, anchor:sp.cells[anchorIndex(norm(sp.cells))], idx:sp.idx};})()""")
    chip = pg.locator(".chip", has_text="Orange").bounding_box()
    pg.mouse.move(chip["x"]+20, chip["y"]+15); pg.mouse.down()
    x,y = screen_xy(pg, *tgt["anchor"]); pg.mouse.move(x, y, steps=8); pg.mouse.up()
    pg.wait_for_timeout(300)
    check("drag from chip places the piece", pg.inner_text("#f-placed").startswith("1 /"), pg.inner_text("#f-placed"))
    # the live count shows progress while the worker runs, then settles
    saw_running = pg.evaluate("A===null || A.running")
    c1 = wait_count(pg)
    expect = pg.evaluate(f"countCompletions(PZ,[PZ.placements[{tgt['idx']}]],1e9).count")
    check("worker count matches the direct solver", c1==expect, f"worker {c1}, direct {expect}")
    check("count was live while running", saw_running)

    # 3. tap an empty cell for its breakdown
    empty = pg.evaluate("emptyCells()[5]")
    x,y = screen_xy(pg, *empty); pg.mouse.click(x,y); pg.wait_for_timeout(200)
    rows = pg.eval_on_selector_all(".ci-row","e=>e.map(r=>r.innerText.replace(/\\s+/g,' '))")
    pct = sum(int(r.split()[-1].rstrip('%').replace('<1','0')) for r in rows)
    check("cell breakdown lists pieces with shares", len(rows)>=1 and 95<=pct<=105, f"{len(rows)} pieces, sums to ~{pct}%")

    # 4. heat map
    pg.click("#btn-heat"); pg.wait_for_timeout(200)
    nheat = pg.eval_on_selector_all(".heat path","e=>e.length")
    check("heat map tints the empty cells", nheat>=pg.evaluate("emptyCells().length"), f"{nheat} marks")

    # 5. tap a placed piece to pick it up, tap again to put it back
    x,y = screen_xy(pg, *tgt["anchor"])
    pg.mouse.click(x,y); pg.wait_for_timeout(200)
    check("tapping a placed piece picks it up", pg.evaluate("held && held.id")=="orange" and pg.inner_text("#f-placed").startswith("0 /"))
    pg.mouse.click(x,y); pg.wait_for_timeout(300)
    check("tapping again puts it back where it was", pg.evaluate("given.length===1 && given[0].idx")==tgt["idx"])

    # 6. browse the completions
    wait_count(pg)
    pg.click("#btn-browse"); pg.wait_for_timeout(300)
    pos1 = pg.inner_text("#solpos"); pg.click("#btn-next"); pg.wait_for_timeout(200); pos2 = pg.inner_text("#solpos")
    rings = pg.eval_on_selector_all(".changed","e=>e.length")
    full = pg.eval_on_selector_all("#board .gem","e=>e.length")
    check("completions can be stepped through", pos1.startswith("1 /") and pos2.startswith("2 /"), f"{pos1} -> {pos2}")
    check("each completion fills the board", full==12, f"{full} pieces drawn")
    check("cells that changed are ringed", rings>0, f"{rings} cells")
    pg.click("#btn-play")

    # 7. dead end gets called out
    pg.click("#btn-empty"); wait_count(pg,5)
    dead = pg.evaluate("""(()=>{ for(const sp of legalSpots(PZ,'sky',[])) if(countCompletions(PZ,[sp],1).count===0) return sp.idx; return null;})()""")
    pg.evaluate(f"given=[PZ.placements[{dead}]]; scheduleAnalyze(); render(); renderChips();")
    c0 = wait_count(pg)
    check("a dead end is flagged", c0==0 and not pg.locator("#banner").is_hidden(), pg.inner_text("#banner"))

    # 8. solving the whole board
    pg.click("#btn-empty"); wait_count(pg,5)
    pg.evaluate("given=EMPTY_ANALYSIS.solutions[0].slice(0,11).map(i=>PZ.placements[i]); scheduleAnalyze(); render(); renderChips();")
    c11 = wait_count(pg)
    last = pg.evaluate("PZ.placements[EMPTY_ANALYSIS.solutions[0][11]]")
    check("one piece left has exactly one completion", c11==1)
    pg.evaluate(f"pickUp('{last['piece']}'); held.cells=norm({last['cells']});")
    ax = pg.evaluate(f"(()=>{{const c={last['cells']}; return c[anchorIndex(norm(c))];}})()")
    x,y = screen_xy(pg, *ax); pg.mouse.click(x,y); pg.wait_for_timeout(500)
    check("placing the last piece shows Solved", pg.inner_text("#f-count")=="solved" and "Solved" in pg.inner_text("#banner"))

    # 9. deal
    pg.click("#btn-new"); pg.wait_for_function("given.length===4", timeout=30000)
    cd = wait_count(pg)
    check("dealing 4 clues gives a solvable position", cd>=1, f"{cd} completions")

    check("no page errors", not errs, "; ".join(errs[:3]))
    ctx.close()

    # 10. offline and phone width
    ctx = b.new_context(viewport={"width":390,"height":844}, has_touch=True, is_mobile=True)
    pg = ctx.new_page(); pg.goto(URL)
    pg.wait_for_function("navigator.serviceWorker.controller!==null", timeout=20000); pg.wait_for_timeout(800)
    check("no horizontal scroll at phone width", not pg.evaluate("document.documentElement.scrollWidth>document.documentElement.clientWidth+1"))
    ctx.set_offline(True)
    pg2 = ctx.new_page(); r = pg2.goto(URL, wait_until="domcontentloaded"); pg2.wait_for_timeout(1200)
    check("opens with no network", r.status==200 and pg2.evaluate("A && A.count")==59494)
    pg2.screenshot(path=str(pathlib.Path(DOCS).parent/"tests"/"phone.png"), full_page=True)
    ctx.close(); b.close()
srv.shutdown()
print(f"\n{'ALL PASSED' if not fails else str(len(fails))+' FAILED: '+', '.join(fails)}")
sys.exit(1 if fails else 0)
