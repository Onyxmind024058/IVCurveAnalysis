/* =============================================================================
   Service worker: keeps a copy of the app so it also works offline.

   Strategy: network first. When online, every file is loaded fresh (so a new
   version on GitHub Pages is used straight away) and the saved copy is
   refreshed; when offline or the network is too slow, the saved copy is used.
   The large, rarely changing Plotly bundle is served from the copy first.

   Measurement files are never involved: they are read by the page itself
   and are never requested over the network.
   ============================================================================= */
"use strict";

// Change only if the list of files below changes shape; contents refresh by themselves.
const CACHE = "ivcurve-app-v1";
const NETWORK_TIMEOUT_MS = 4000;

const APP_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/basel.css",
  "./js/numerics.js",
  "./js/ui.js",
  "./js/plot.js",
  "./js/lda.js",
  "./js/csv.js",
  "./js/manual-oml.js",
  "./js/eepf.js",
  "./js/epfl.js",
  "./js/app.js",
  "./js/pwa.js",
  "./vendor/plotly-basic.min.js",
  "./icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];
const CACHE_FIRST = /\/vendor\//;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(APP_FILES.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("ivcurve-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function fromNetwork(request) {
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
}

async function networkFirst(request) {
  const network = fromNetwork(request);
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  try {
    const response = await Promise.race([network, timeout]);
    if (response) return response;
  } catch (_) { /* offline: fall through to the saved copy */ }
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  return network;  // nothing saved yet: keep waiting for the network
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    fromNetwork(request).catch(() => {});  // refresh quietly for next time
    return cached;
  }
  return fromNetwork(request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(CACHE_FIRST.test(request.url) ? cacheFirst(request) : networkFirst(request));
});
