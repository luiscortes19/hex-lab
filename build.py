#!/usr/bin/env python3
"""Build Hex Puzzle Lab into a single self-contained page.

    python3 build.py                 -> docs/   (installable app, served by GitHub Pages)
    python3 build.py --preview OUT   -> one HTML fragment for previewing inside Claude

Everything the app needs (solver, worker, fonts, puzzle, precomputed stats) is
inlined into index.html, so the page makes no network requests at all.
"""
import argparse, hashlib, json, pathlib, shutil

ROOT = pathlib.Path(__file__).parent
SRC, ASSETS, OUT = ROOT / "src", ROOT / "assets", ROOT / "docs"

def read(name): return (SRC / name).read_text(encoding="utf-8")
def js_json(obj): return json.dumps(obj, separators=(",", ":")).replace("</", "<\\/")

def page(preview: bool) -> str:
    solver, worker = read("solver.js"), read("worker.js")
    doc = json.loads(read("puzzle.json"))
    cache_path = SRC / "empty-analysis.json"
    empty = json.loads(cache_path.read_text()) if cache_path.exists() else None
    style = read("fonts.css") + "\n" + read("style.css")
    body = read("body.html")
    consts = (f"const DEFAULT_DOC = {js_json(doc)};\n"
              f"const EMPTY_ANALYSIS = {js_json(empty)};\n"
              f"const BUILD = {js_json({'preview': preview})};\n")
    scripts = (
        f'<script type="text/plain" id="solver-src">\n{solver}</script>\n'
        f'<script type="text/plain" id="worker-src">\n{worker}</script>\n'
        f'<script>\n"use strict";\n{consts}\n{solver}\n{read("app.js")}\n</script>\n')

    if preview:
        # Claude's preview supplies the document skeleton and has no service workers
        return ('<title>Hex Puzzle Lab</title>\n'
                '<meta name="claude:viewport-fit-sides" content="cover">\n'
                f'<style>\n{style}\n</style>\n{body}\n{scripts}')

    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Hex Puzzle Lab</title>
<meta name="description" content="Place pieces on the 56-cell hex puzzle and see exactly how many ways it can still be finished.">
<link rel="manifest" href="./manifest.webmanifest">
<meta name="theme-color" content="#1b1d1f">
<meta name="color-scheme" content="dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Hex Lab">
<link rel="apple-touch-icon" href="./apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="192x192" href="./icon-192.png">
<style>
{style}
</style>
</head>
<body>
{body}
{scripts}</body>
</html>
'''

def build_app():
    OUT.mkdir(exist_ok=True)
    html = page(preview=False)
    (OUT / "index.html").write_text(html, encoding="utf-8")
    for f in ["manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]:
        shutil.copy(ASSETS / f, OUT / f)
    # The cache name is derived from the content, so every change ships a new
    # version and installed copies update on their next launch.
    digest = hashlib.sha256(html.encode()).hexdigest()[:10]
    sw = (ASSETS / "sw.js").read_text().replace('const CACHE_VERSION = "hexlab-v2";', f'const CACHE_VERSION = "hexlab-{digest}";')
    assert f"hexlab-{digest}" in sw, "sw.js cache line not found"
    (OUT / "sw.js").write_text(sw)
    (OUT / ".nojekyll").write_text("")
    print(f"docs/index.html  {len(html)//1024} KB   cache hexlab-{digest}")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", metavar="OUT")
    a = ap.parse_args()
    if a.preview:
        pathlib.Path(a.preview).write_text(page(preview=True), encoding="utf-8")
        print("preview written to", a.preview)
    else:
        build_app()
