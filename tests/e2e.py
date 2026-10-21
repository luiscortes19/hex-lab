"""End-to-end check of the built app in headless Chromium.  python3 tests/e2e.py"""
import threading, http.server, socketserver, pathlib, sys
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = str(ROOT / "docs")
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
def xy(pg, q, r):
    return pg.evaluate(f"""(()=>{{const c=centre({q},{r}),svg=document.getElementById('board'),p=svg.createSVGPoint();
      p.x=c.x;p.y=c.y;const s=p.matrixTransform(svg.getScreenCTM());return [s.x,s.y];}})()""")
def settle(pg, timeout=120):
    pg.wait_for_function("A && !A.running", timeout=timeout*1000); return pg.evaluate("A.count")
def viable(pg, piece):
    return pg.evaluate(f"""(()=>{{pickUp('{piece}'); const sp=currentSpots().find(s=>A.use[s.idx]>0); putBack();
      return {{idx:sp.idx, cells:sp.cells, anchor:sp.cells[anchorIndex(norm(sp.cells))]}};}})()""")

with sync_playwright() as p:
    b = p.chromium.launch()

    # ---------------- phone, portrait ----------------
    ctx = b.new_context(viewport={"width":390,"height":844}, device_scale_factor=3, has_touch=True, is_mobile=True)
    pg = ctx.new_page(); errs=[]
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
    pg.goto(URL); pg.wait_for_timeout(900)

    c = settle(pg, 5)
    check("opens on an empty board with the exact total", c==59494, pg.inner_text("#count-num"))
    check("everything fits on one screen (no page scroll)",
          pg.evaluate("document.scrollingElement.scrollHeight<=innerHeight+1 && document.scrollingElement.scrollWidth<=innerWidth+1"))
    check("board is turned to fill the tall screen", pg.evaluate("ROT")==True)
    a,bq = xy(pg,0,2), xy(pg,1,2)
    cell = ((a[0]-bq[0])**2+(a[1]-bq[1])**2)**.5
    check("cells are finger-sized (>= 44px)", cell>=44, f"{cell:.0f}px between neighbouring cells")
    check("piece tray shows all 12 pieces with spot counts",
          pg.eval_on_selector_all(".card em","e=>e.filter(x=>/spots/.test(x.textContent)).length")==12)

    # tap a tray card, then tap the board: the touch flow
    t = viable(pg, "orange")
    pg.locator(".card[data-piece=orange]").tap(); pg.wait_for_timeout(150)
    check("tapping a card picks the piece up", pg.evaluate("held&&held.id")=="orange")
    check("Turn / Flip / Put back appear only while holding", not pg.locator("#act-held").is_hidden() and pg.locator("#act-idle").is_hidden())
    pg.click("#btn-turn"); pg.wait_for_timeout(100)
    rotated = pg.evaluate("shapeKey(held.cells)")
    pg.click("#btn-flip"); pg.wait_for_timeout(100)
    check("Turn and Flip change the held shape", pg.evaluate("shapeKey(held.cells)")!=rotated)
    pg.evaluate(f"held.cells=norm({t['cells']})")      # line it up with a known good spot
    x,y = xy(pg,*t["anchor"]); pg.touchscreen.tap(x,y); pg.wait_for_timeout(300)
    check("tapping the board drops it", pg.inner_text("#placed-txt").startswith("1 /"), pg.inner_text("#placed-txt"))
    c1 = settle(pg)
    direct = pg.evaluate(f"countCompletions(PZ,[PZ.placements[{t['idx']}]],1e9).count")
    check("background count matches the solver", c1==direct, f"{c1} vs {direct}")

    # tap an empty cell -> breakdown card
    e = pg.evaluate("emptyCells()[7]"); x,y = xy(pg,*e); pg.touchscreen.tap(x,y); pg.wait_for_timeout(250)
    rows = pg.eval_on_selector_all("#cellcard .ci-row em","e=>e.map(x=>x.textContent)")
    check("tapping an empty cell shows which pieces fill it", not pg.locator("#cellcard").is_hidden() and len(rows)>=1, ", ".join(rows))
    pg.click("#cellcard-x")

    # tap a placed piece to pick it up, tap again to put it down
    x,y = xy(pg,*t["anchor"]); pg.touchscreen.tap(x,y); pg.wait_for_timeout(200)
    check("tapping a placed piece picks it up", pg.evaluate("held&&held.id")=="orange")
    pg.touchscreen.tap(x,y); pg.wait_for_timeout(300)
    check("tapping again puts it back", pg.evaluate("given.length===1&&given[0].idx")==t["idx"])
    settle(pg)

    # stats sheet
    pg.click("#count"); pg.wait_for_timeout(250)
    spots = pg.eval_on_selector_all("#spots .spot","e=>e.length")
    check("tapping the count opens the stats sheet", not pg.locator("#sheet-stats").is_hidden() and spots==12, f"{spots} piece rows")
    pg.click("#scrim", position={"x":30,"y":30})
    check("tapping outside the sheet closes it", pg.locator("#sheet-stats").is_hidden())

    # solutions tab: swipe
    pg.click("#tab-browse"); pg.wait_for_timeout(250)
    s1 = pg.inner_text("#solpos")
    st = pg.locator("#stage").bounding_box()
    pg.evaluate(f"""(()=>{{const s=document.getElementById('stage');
      const ev=(t,x)=>s.dispatchEvent(new PointerEvent(t,{{bubbles:true,clientX:x,clientY:{st['y']+st['height']/2},pointerType:'touch'}}));
      ev('pointerdown',{st['x']+300}); document.dispatchEvent(new PointerEvent('pointerup',{{clientX:{st['x']+60},clientY:{st['y']+st['height']/2}}}));}})()""")
    pg.wait_for_timeout(250)
    s2 = pg.inner_text("#solpos")
    check("swiping steps through completions", s1.startswith("1 /") and s2.startswith("2 /"), f"{s1} -> {s2}")
    check("ringed cells mark what changed", pg.eval_on_selector_all(".changed","e=>e.length")>0)
    check("tray is replaced in the Solutions tab", pg.locator("#tray").is_hidden())
    pg.click("#tab-play")

    # menu: deal
    pg.click("#tab-menu"); pg.wait_for_timeout(200)
    pg.click("#clue-plus"); pg.click("#btn-new")
    pg.wait_for_function("given.length===5", timeout=30000)
    cd = settle(pg)
    check("Menu > Deal places the chosen number of clues", cd>=1 and pg.locator("#sheet-menu").is_hidden(), f"5 clues, {cd} completions")

    # dead end + solved
    pg.evaluate("newGame([])"); settle(pg,5)
    dead = pg.evaluate("(()=>{for(const sp of legalSpots(PZ,'sky',[])) if(countCompletions(PZ,[sp],1).count===0) return sp.idx;})()")
    pg.evaluate(f"newGame([]); given=[PZ.placements[{dead}]]; scheduleAnalyze(); render(); renderTray();")
    check("a dead end is called out", settle(pg)==0 and "No solution" in pg.inner_text("#toast"))
    pg.evaluate("newGame(EMPTY_ANALYSIS.solutions[0].slice(0,11).map(i=>PZ.placements[i]))")
    settle(pg)
    last = pg.evaluate("PZ.placements[EMPTY_ANALYSIS.solutions[0][11]]")
    pg.evaluate(f"pickUp('{last['piece']}'); held.cells=norm({last['cells']});")
    ax = pg.evaluate(f"(()=>{{const c={last['cells']};return c[anchorIndex(norm(c))];}})()")
    x,y = xy(pg,*ax); pg.touchscreen.tap(x,y); pg.wait_for_timeout(400)
    check("the last piece shows Solved", pg.inner_text("#count-num")=="Solved" and pg.locator("#toast").is_hidden())
    pg.screenshot(path=str(ROOT/"tests"/"phone-solved.png"))
    pg.evaluate("newGame([])"); pg.wait_for_timeout(300)
    pg.screenshot(path=str(ROOT/"tests"/"phone.png"))
    check("no page errors on the phone", not errs, "; ".join(errs[:3]))

    # offline cold start
    pg.wait_for_function("navigator.serviceWorker.controller!==null", timeout=20000)
    ctx.set_offline(True)
    pg2 = ctx.new_page(); r = pg2.goto(URL, wait_until="domcontentloaded"); pg2.wait_for_timeout(1000)
    check("opens with no network", r.status==200 and pg2.evaluate("A&&A.count")==59494)
    ctx.close()

    # ---------------- desktop / landscape ----------------
    ctx = b.new_context(viewport={"width":1280,"height":800})
    pg = ctx.new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL); pg.wait_for_timeout(800); settle(pg,5)
    check("wide screen keeps the board unrotated", pg.evaluate("ROT")==False)
    # mouse drag straight up from a card onto the board
    t = viable(pg, "lime")
    pg.evaluate(f"held=null")
    card = pg.locator(".card[data-piece=lime]").bounding_box()
    pg.mouse.move(card["x"]+card["width"]/2, card["y"]+card["height"]/2); pg.mouse.down()
    pg.mouse.move(card["x"]+card["width"]/2, card["y"]-40, steps=4)
    pg.evaluate(f"held.cells=norm({t['cells']})")
    x,y = xy(pg,*t["anchor"]); pg.mouse.move(x,y,steps=6); pg.mouse.up(); pg.wait_for_timeout(300)
    check("dragging a card up onto the board places it", pg.evaluate("given.length===1&&given[0].piece")=="lime")
    check("no page errors on desktop", not errs, "; ".join(errs[:3]))
    pg.screenshot(path=str(ROOT/"tests"/"desktop.png"))
    ctx.close(); b.close()
srv.shutdown()
print(f"\n{'ALL PASSED' if not fails else str(len(fails))+' FAILED: '+', '.join(fails)}")
sys.exit(1 if fails else 0)
