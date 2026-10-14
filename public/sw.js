// Keeps the app opening when the connection drops. The calendar data always comes fresh from /api.
const CACHE = "household-v3";
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/apple-touch-icon.png"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Android: an invite shared to the installed app arrives here; hand it to the page to review.
  if (e.request.method === "POST" && url.pathname === "/share-target") {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const file = form.get("file");
      const body = file && typeof file !== "string" ? await file.text() : String(form.get("text") || "");
      const cache = await caches.open("household-share");
      await cache.put("/shared-file", new Response(body));
      return Response.redirect("/?shared=1", 303);
    })());
    return;
  }
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Network first so updates show up straight away; fall back to the cached copy offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match("/"))),
  );
});
