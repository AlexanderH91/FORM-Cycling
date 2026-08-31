/* Network-first service worker.
 *
 * The app has no build step, so nothing rewrites module URLs and the browser
 * is free to keep serving yesterday's js/*.js indefinitely — which has made
 * "is this a live bug or cached code?" the hardest question in this project.
 * This asks the network first for same-origin files and only falls back to the
 * cache when offline, so a deploy is live on the next load. */

/* Bumped with the app version: activate() deletes every cache that is not this
   one, so a rename is also a purge of whatever the previous version stored. */
const CACHE = "form-cycling-v34";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  // Video scrubbing issues ranged requests; a 206 cannot be stored and the
  // fallback copy would be the wrong bytes anyway. Leave those to the browser.
  if (req.headers.has("range")) return;

  e.respondWith((async () => {
    try {
      // no-store on the way out: the whole point is to defeat the HTTP cache,
      // which is what serves stale modules in the first place.
      const fresh = await fetch(req, { cache: "no-store" });
      if (fresh.ok && fresh.status === 200 && fresh.type === "basic") {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      throw err;   // genuinely offline and never seen: let the browser say so
    }
  })());
});
