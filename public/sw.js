/* Idle Civ service worker — offline play for the installed PWA.
 *
 * Strategy:
 * - Navigations are network-first so a redeployed index.html (and its new
 *   hashed asset URLs) is picked up as soon as it is reachable; offline they
 *   fall back to the cached shell.
 * - Same-origin subresources use stale-while-revalidate. Vite hashes asset
 *   filenames, so a cached entry is always the build it was fetched from; the
 *   background revalidation only matters for mutable files (favicon, manifest).
 * - Cross-origin requests (Google Fonts) are left to the network: an opaque
 *   cache of font CSS buys little and breaks offline silently anyway.
 * - Old cache versions are dropped on activate; bump VERSION below when the
 *   shell list changes.
 */
const VERSION = "idle-civ-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./favicon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;
  // Let the media stack handle byte-range requests itself.
  if (request.headers.has("range")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstShell(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});

/** Network-first for the app shell; the cached shell keeps offline play alive. */
const networkFirstShell = async (request) => {
  const cache = await caches.open(VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put("./index.html", response.clone());
    return response;
  } catch {
    return (await cache.match(request)) ?? (await cache.match("./index.html"));
  }
};

/** Serve the cached copy immediately and refresh it in the background. */
const staleWhileRevalidate = async (request) => {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok) void cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached ?? refresh;
};
