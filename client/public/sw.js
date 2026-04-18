// Minimal service worker — required for PWA install prompt on Chrome.
// No caching strategy: Concord is a live-data app, all requests go through.
const CACHE_NAME = "concord-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // Pass-through: no offline caching for a chat app.
});
