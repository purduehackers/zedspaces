/* Immutable editor assets only. Staging is driven by the shell after interactive boot;
 * worker installation never starts a competing download. APIs/documents stay on-network. */
const CACHE_PREFIX = "zs-editor-";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const response = await fetch("/editor/manifest.json", { cache: "no-store" });
        if (response.ok) {
          const manifest = await response.json();
          const keep = new Set(manifest.builds.map((build) => CACHE_PREFIX + build));
          const names = await caches.keys();
          await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && !keep.has(name))
            .map((name) => caches.delete(name)));
        }
      } catch {
        // Without a trustworthy retention list, leave cached builds intact.
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const match = url.pathname.match(/^\/editor\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(zed_web\.js|zed_web_bg\.wasm|zed-assets\.tar)$/);
  if (!match || url.search || match[1].startsWith("dev")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_PREFIX + match[1]);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) event.waitUntil(cache.put(request, response.clone()).catch(() => undefined));
      return response;
    })(),
  );
});
