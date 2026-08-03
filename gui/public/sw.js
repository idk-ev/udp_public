/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Service-Worker der UDP-Dashboards (Audit Sprint C — PWA).
   Strategie: Navigationsseiten und Live-Daten netz-zuerst (immer aktuell,
   Cache nur als Offline-Rückfall); statische Shell cache-zuerst. */
const V = "udp-v2";
const SHELL = [
  "/stadt.html", "/kreis.html", "/dashboard.html", "/mitmachen.html",
  "/smartcity-lib.js", "/smartcity-theme.css",
  "/vendor/leaflet.js", "/vendor/leaflet.css",
  "/manifest.webmanifest", "/icon.svg",
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  const netFirst = () => fetch(e.request)
    .then(r => { if (r.ok) { const cp = r.clone(); caches.open(V).then(c => c.put(e.request, cp)); } return r; })
    .catch(() => caches.match(e.request).then(c => c || (e.request.mode === "navigate" ? caches.match("/dashboard.html") : undefined)));
  // Seiten + Live-Daten immer frisch, offline aus dem Cache
  if (e.request.mode === "navigate" || u.pathname.startsWith("/gateway") || u.pathname.startsWith("/abfahrten")) {
    e.respondWith(netFirst()); return;
  }
  // Statische Shell: cache-zuerst, im Hintergrund auffrischen
  e.respondWith(caches.match(e.request).then(c => c || fetch(e.request).then(r => {
    if (r.ok) { const cp = r.clone(); caches.open(V).then(cc => cc.put(e.request, cp)); }
    return r;
  })));
});
