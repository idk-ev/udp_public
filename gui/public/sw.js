/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Service-Worker der UDP-Dashboards (Audit Sprint C — PWA).
   Strategy: everything the worker handles goes network-first – pages, scripts,
   styles, config.js and data files are always the deployed ones, the cache is
   only the offline fallback. (Stale-while-revalidate served the old scripts
   once after every deploy, next to new HTML.) Live data (/gateway, departures,
   the warnings calendar) is never touched: no offline value, and storing every
   API answer let Cache Storage grow without bound. */

/* Cacheversion. Sie ist an die Chart-Version gekoppelt (helm/udp/Chart.yaml)
   und wird von tests/static/sw-cache.test.js darauf geprüft — jedes Release
   verwirft damit die Caches seines Vorgängers. A "-swN" suffix discards the
   caches between releases when the worker itself changes (here: dropping the
   stored /gateway answers); a release resets it to plain "udp-<version>". */
const V = "udp-1.4.0-sw2";
/* "/" is the public start page (nginx serves mitmachen.html there) and the
   offline fallback for pages. /dashboard.html is not part of the shell: it
   sits behind HTTP basic auth (or answers 404), and a single failing URL makes
   addAll() reject - the worker would never install. */
const SHELL = [
  "/", "/stadt.html", "/kreis.html", "/mitmachen.html",
  "/smartcity-lib.js", "/smartcity-theme.css", "/site.js", "/config.js",
  "/vendor/leaflet.js", "/vendor/leaflet.css",
  "/manifest.webmanifest", "/icon.svg", "/favicon",
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
/* Pages the worker never touches: login-protected, so neither a cached copy
   nor the network-first branch may stand between the browser and the
   server's 401 (the browser shows its login prompt only for its own request). */
const PRIVATE = ["/dashboard.html"];
/* Live data: neither answered nor stored by the worker. */
const LIVE = ["/gateway", "/abfahrten", "/warnungen.ics"];
const isLive = p => LIVE.some(x => p === x || p.startsWith(x + "/"));
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
    // A copy cached while the page was still public stays in a cache of the
    // same version otherwise.
    .then(() => caches.open(V)).then(c => Promise.all(PRIVATE.map(p => c.delete(p))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || PRIVATE.includes(u.pathname)) return;
  if (isLive(u.pathname)) return;
  // Network first; a good answer refreshes the offline copy. Only addresses
  // without a query are stored – the set of them is finite (the files and
  // the municipality pages), arbitrary query strings are not.
  let stored = null;
  const net = fetch(e.request).then(r => {
    if (r.ok && !u.search) {
      const cp = r.clone();
      stored = caches.open(V).then(c => c.put(e.request, cp));
    }
    return r;
  });
  e.waitUntil(net.then(() => stored, () => null).catch(() => {}));
  // Offline: the stored copy (ignoring the query, e.g. ?embed=1), for pages
  // the start page as the last resort.
  e.respondWith(net.catch(() => caches.match(e.request, { ignoreSearch: true })
    .then(c => c || (e.request.mode === "navigate" ? caches.match("/") : Response.error()))));
});
