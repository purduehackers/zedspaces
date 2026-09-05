/* Editor bundle service worker (b9 §3.31).
 *
 * Registered by the shell as `/sw.js?build=<id>` with scope `/w/` (the
 * `Service-Worker-Allowed: /w/` header in next.config.ts permits the wider
 * scope). It precaches the three runtime files of that build so a reload
 * during a network blip still boots, answers only `GET /editor/*` from the
 * cache, and never touches `/api/*`, `/w/*` documents or cross-origin
 * requests. There is no offline editing: everything else falls through to the
 * network untouched.
 */

const BUILD = new URL(self.location.href).searchParams.get("build") || "";
const CACHE_PREFIX = "zs-editor-";
const CACHE_NAME = CACHE_PREFIX + BUILD;
const RUNTIME_FILES = ["zed_web.js", "zed_web_bg.wasm", "zed-assets.tar"];

function bundleUrl(build, file) {
  return "/editor/" + encodeURIComponent(build) + "/" + file;
}

self.addEventListener("install", (event) => {
  if (!BUILD) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        RUNTIME_FILES.map(async (file) => {
          const url = bundleUrl(BUILD, file);
          try {
            const response = await fetch(url, { cache: "reload" });
            if (response.ok) await cache.put(url, response);
          } catch {
            // A missing file only means the next boot fetches it from the network.
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Keep the current build plus every build still listed in the deployment's manifest.
      const keep = new Set([CACHE_NAME]);
      try {
        const response = await fetch("/editor/manifest.json", { cache: "no-store" });
        if (response.ok) {
          const manifest = await response.json();
          for (const build of manifest.builds || []) keep.add(CACHE_PREFIX + build);
        }
      } catch {
        // No manifest: keep only the current build's cache.
      }
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith(CACHE_PREFIX) && !keep.has(name)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/editor/")) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(request, { ignoreSearch: false });
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && BUILD && url.pathname.startsWith("/editor/" + encodeURIComponent(BUILD) + "/")) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
