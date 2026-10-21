/* Service worker for Hex Puzzle Lab.
   Strategy:
     - app shell (html, icons, manifest): precached, served cache-first so the
       app opens instantly and works with no network at all.
     - nothing else is needed: fonts are embedded in the HTML as data URIs,
       so the app issues no cross-origin requests at any point.
   Bump CACHE_VERSION whenever a shell file changes, or phones will keep
   serving the old copy forever. */

const CACHE_VERSION = "hexlab-v2";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png"
];


self.addEventListener("install", e=>{
  e.waitUntil((async()=>{
    const c = await caches.open(CACHE_VERSION);
    // addAll fails the whole install if any single file 404s, so add leniently
    await Promise.all(SHELL.map(u=>c.add(new Request(u,{cache:"reload"})).catch(()=>{})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", e=>{
  e.waitUntil((async()=>{
    const keys = await caches.keys();
    await Promise.all(keys.filter(k=>k!==CACHE_VERSION).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e=>{
  const req = e.request;
  if(req.method!=="GET") return;
  const url = new URL(req.url);

  // Navigations: serve the cached shell, fall back to network, so a cold
  // offline launch still opens the app.
  if(req.mode==="navigate"){
    e.respondWith((async()=>{
      const c = await caches.open(CACHE_VERSION);
      const hit = await c.match("./index.html") || await c.match("./");
      if(hit) {
        // refresh in the background for next launch
        fetch(req).then(r=>{ if(r && r.ok) c.put("./index.html", r.clone()); }).catch(()=>{});
        return hit;
      }
      try { return await fetch(req); }
      catch { return new Response("Offline and nothing cached yet.", {status:503, headers:{"Content-Type":"text/plain"}}); }
    })());
    return;
  }


  // Same-origin assets: cache-first.
  if(url.origin===self.location.origin){
    e.respondWith((async()=>{
      const c = await caches.open(CACHE_VERSION);
      const hit = await c.match(req);
      if(hit) return hit;
      try {
        const r = await fetch(req);
        if(r && r.ok) c.put(req, r.clone());
        return r;
      } catch {
        return new Response("", {status:504});
      }
    })());
  }
});

// Lets the page trigger an immediate update without a second launch.
self.addEventListener("message", e=>{ if(e.data==="skip-waiting") self.skipWaiting(); });
