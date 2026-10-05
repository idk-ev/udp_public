/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Shared jsdom harness for the page tests (not a test file itself): renders
   stadt.html / kreis.html / dashboard.html against a scripted backend with
   Leaflet stubbed. JSDOM is null without gui/node_modules; callers skip then. */
"use strict";
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..", "..");
const PUB = path.join(ROOT, "gui", "public");
const LIB = fs.readFileSync(path.join(PUB, "smartcity-lib.js"), "utf8");
const STADT_HTML = fs.readFileSync(path.join(PUB, "stadt.html"), "utf8");
const CONN = JSON.parse(fs.readFileSync(path.join(PUB, "connectors-status.json"), "utf8"));
const GEM = JSON.parse(fs.readFileSync(path.join(PUB, "bw-gemeinden.json"), "utf8"));

let JSDOM = null;
try {
  ({ JSDOM } = createRequire(path.join(ROOT, "gui", "package.json"))("jsdom"));
} catch {
  // not installed – the tests skip
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/* Leaflet stub: every property and call yields the stub again. `calls`, if
   given, collects the arguments of every call (popup markup among them). */
const leafletStub = (w, calls) => {
  const chain = new Proxy(function () {}, { get: () => chain, apply: (t, self, args) => { if (calls) calls.push(args); return chain; } });
  w.L = new Proxy({}, { get: () => chain });
};

/* Makes localStorage throw on any access, as in an iframe with blocked
   third-party storage. */
const blockStorage = w => Object.defineProperty(w, "localStorage", {
  configurable: true,
  get() { throw new w.DOMException("The operation is insecure.", "SecurityError"); },
});

async function settled(w, what) {
  const t0 = Date.now();
  while (!/^Stand:/.test(w.document.getElementById("stand").textContent)) {
    if (w.document.getElementById("err").textContent) throw new Error(w.document.getElementById("err").textContent);
    if (Date.now() - t0 > 10000) throw new Error(`${what} did not finish rendering`);
    await new Promise(r => setTimeout(r, 20));
  }
}

const REUTLINGEN = GEM.gemeinden.find(g => g[0] === "08415061");

/* Renders stadt.html, for Reutlingen unless `opts.row` is another
   bw-gemeinden.json row. `opts.entities` maps entity ids to bodies,
   `opts.types` NGSI-LD types to lists, `opts.fail` is a predicate for URLs
   answered with 503, `opts.abfahrten` the /abfahrten Response, `opts.query`
   a query string for the page URL, `opts.noStorage` blocks localStorage.
   Returns the window, document, fetched URLs and Leaflet call arguments. */
async function renderStadt(opts = {}) {
  const html = STADT_HTML.replace(/<script src="[^"]*"><\/script>/g, "");
  const row = opts.row || REUTLINGEN;
  const dom = new JSDOM(html, { url: "https://udp.example/" + row[8] + (opts.query || ""), runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  const leaflet = [];
  for (const [k, v] of Object.entries(opts.storage || {})) w.localStorage.setItem(k, v);
  if (opts.noStorage) blockStorage(w);
  w.STADT = { row, website: "https://www.reutlingen.de" };
  w.fetch = async url => {
    const u = decodeURIComponent(String(url));
    calls.push(u);
    if (opts.delay) await new Promise(r => setTimeout(r, opts.delay));
    if (opts.fail && opts.fail(u)) return json({ title: "Service Unavailable" }, 503, { "Retry-After": "0" });
    if (u === "/connectors-status.json") return json(opts.conn || CONN);
    if (u === "/dashboards.json") return json({ kommunen: opts.kommunen || {} });
    if (u.startsWith("/abfahrten")) return opts.abfahrten ? opts.abfahrten() : json({ fehler: "kein Halt" }, 404);
    if (u.startsWith("/gateway/temporal/")) return json({});
    const byId = u.match(/\/ngsi-ld\/v1\/entities\/([^?]+)/);
    if (byId) {
      const e = (opts.entities || {})[byId[1]];
      return e ? json(e) : json({ title: "Entity Not Found" }, 404);
    }
    const type = (u.match(/[?&]type=([^&]+)/) || [])[1];
    return json((opts.types || {})[type] || []);
  };
  leafletStub(w, leaflet);
  w.eval(LIB);
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  for (const src of inline) w.eval(src);
  await settled(w, "stadt.html");
  return { w, d: w.document, calls, leaflet };
}

/* Renders another page; static files come from gui/public. The gateway
   answers 503 for URLs matching `failRe`, entity ids with 404, listings with
   `types[type]` (default: empty). */
async function renderPage(file, url, failRe, globals = {}, types = {}) {
  const html = fs.readFileSync(path.join(PUB, file), "utf8").replace(/<script src="[^"]*"><\/script>/g, "");
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(w, globals);
  w.fetch = async u => {
    const s = decodeURIComponent(String(u));
    if (failRe && failRe.test(s)) return json({}, 503, { "Retry-After": "0" });
    if (!s.startsWith("/gateway")) {
      const f = path.join(PUB, s.split("?")[0]);
      return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : json({}, 404);
    }
    if (s.includes("/entities/")) return json({ title: "Not Found" }, 404);
    if (s.includes("/temporal/")) return json({});
    const type = (s.match(/[?&]type=([^&]+)/) || [])[1];
    return json(types[type] || []);
  };
  leafletStub(w);
  w.open = () => {};
  w.eval(LIB);
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) w.eval(m[1]);
  await settled(w, file);
  return w;
}

const labels = d => [...d.querySelectorAll("#tiles .tile .label")].map(l => l.textContent.trim());
const errorLabels = d => [...d.querySelectorAll("#tiles .tile-error .label")].map(l => l.textContent.trim());
/* The tile with this label: { value, hint, el } (text content, trimmed). */
const tileOf = (d, label) => {
  const el = [...d.querySelectorAll("#tiles .tile")].find(t => t.querySelector(".label").textContent.trim() === label);
  if (!el) return null;
  const text = sel => { const x = el.querySelector(sel); return x ? x.textContent.replace(/\s+/g, " ").trim() : null; };
  return { el, value: text(".value"), hint: text(".hint") };
};

module.exports = { JSDOM, ROOT, PUB, LIB, CONN, GEM, json, leafletStub, blockStorage, renderStadt, renderPage, labels, errorLabels, tileOf };
