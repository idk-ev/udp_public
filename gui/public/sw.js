/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Service-Worker der UDP-Dashboards (Audit Sprint C — PWA).
   Strategie: Navigationsseiten und Live-Daten netz-zuerst (immer aktuell,
   Cache nur als Offline-Rückfall); statische Shell cache-zuerst mit
   Hintergrund-Auffrischung (stale-while-revalidate). */

/* Cacheversion. Sie ist an die Chart-Version gekoppelt (helm/udp/Chart.yaml)
   und wird von tests/static/sw-cache.test.js darauf geprüft — jedes Release
   verwirft damit die Caches seines Vorgängers. Bis Sprint 2.9 stand hier ein
   handgepflegtes "udp-v2", das seit dem ersten Release nie erhöht wurde. */
const V = "udp-1.0.1";
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
  const ablegen = r => { if (r.ok) { const cp = r.clone(); caches.open(V).then(c => c.put(e.request, cp)); } return r; };
  const netFirst = () => fetch(e.request).then(ablegen)
    .catch(() => caches.match(e.request).then(c => c || (e.request.mode === "navigate" ? caches.match("/dashboard.html") : undefined)));
  // Seiten + Live-Daten immer frisch, offline aus dem Cache
  if (e.request.mode === "navigate" || u.pathname.startsWith("/gateway") || u.pathname.startsWith("/abfahrten")) {
    e.respondWith(netFirst()); return;
  }
  // Statische Shell: sofort aus dem Cache antworten UND parallel auffrischen.
  // Der frühere Zweig griff nur bei einem Cache-MISS ins Netz; ein Treffer wurde
  // nie wieder erneuert. Eine geänderte Datei blieb damit bis zur nächsten
  // Cacheversion unsichtbar — und die stand seit dem ersten Release still.
  const auffrischen = fetch(e.request).then(ablegen);
  e.waitUntil(auffrischen.catch(() => {}));
  e.respondWith(caches.match(e.request).then(c => c || auffrischen));
});
