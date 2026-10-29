/* The pre-alpha moved to /web-beta/. This service worker replaces the old one,
   deletes the pre-alpha's offline caches and unregisters itself; the page then
   forwards to the beta. Training data (IndexedDB) is per origin and is kept. */
"use strict";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("ivcurve-alpha-")) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: "window" })) client.navigate("../web-beta/");
  })());
});
