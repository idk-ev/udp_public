/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Operator web analytics and legal links (gui/public/site.js, Helm values
   cockpit.analytics / cockpit.legal).

   site.js is run in jsdom against hand-made configs: the snippet must be
   inserted exactly once, in order, with working scripts, only on public pages
   unless includeCockpit is set, and only harmless URLs may become links. The
   page checks make sure every public page actually loads it – from the BODY,
   because the city/district stubs (gui/public/g/) swap in the body of
   stadt.html/kreis.html and re-run only its body scripts.

   The jsdom part skips without gui/node_modules (the static suite runs on a
   fresh clone without npm install, see .githooks/pre-commit); CI installs it. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..", "..");
const PUB = path.join(ROOT, "gui", "public");
const SITE = fs.readFileSync(path.join(PUB, "site.js"), "utf8");
const PAGES = ["stadt.html", "kreis.html", "dashboard.html", "mitmachen.html", "404.html"];

let JSDOM = null;
try {
  ({ JSDOM } = createRequire(path.join(ROOT, "gui", "package.json"))("jsdom"));
} catch {
  // not installed – the behaviour tests below skip
}

const tick = () => new Promise(r => setImmediate(r));

/* A page with the given body and config; site.js is run `runs` times, as a
   real <script> element (so document.currentScript and data-udp-context
   work). Scripts run for real ("dangerously"), so inline snippet code proves
   it executes. External src scripts are never fetched (no resources option):
   the test fires their load event itself via loadScript(). */
async function page(config, { body = "<nav data-udp-legal hidden></nav>", runs = 1, context = null } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, {
    runScripts: "dangerously",
  });
  const w = dom.window;
  if (config !== undefined) w.UDP_CONFIG = config;
  for (let i = 0; i < runs; i++) {
    const s = w.document.createElement("script");
    if (context) s.setAttribute("data-udp-context", context);
    s.textContent = SITE;
    w.document.body.appendChild(s);
  }
  if (w.document.readyState === "loading")
    await new Promise(r => w.document.addEventListener("DOMContentLoaded", r, { once: true }));
  return w;
}

function loadScript(w, src, before) {
  const el = w.document.head.querySelector(`script[src="${src}"]`);
  assert(el, `${src} was not inserted`);
  if (before) before();
  el.dispatchEvent(new w.Event("load"));
}

// Everything inserted by site.js lives in <head> (the page has no own head content).
const headTags = w => [...w.document.head.children].map(n => n.localName);

exports["site.js: no config or empty config changes nothing"] = async () => {
  if (!JSDOM) return;
  for (const cfg of [undefined, {}, { legal: { impressumUrl: "", datenschutzUrl: "" }, analytics: { headHtml: "" } }]) {
    const w = await page(cfg);
    assert.strictEqual(await w.UDP_SITE.analyticsDone, 0);
    assert.strictEqual(w.document.head.children.length, 0, "head was modified");
    const nav = w.document.querySelector("[data-udp-legal]");
    assert(nav.hidden, "legal container visible without links");
    assert.strictEqual(nav.children.length, 0);
    w.close();
  }
};

exports["site.js: snippet nodes are recreated, noscript and text are skipped"] = async () => {
  if (!JSDOM) return;
  const headHtml = [
    '<link rel="preconnect" href="https://analytics.example.org">',
    '<script async src="https://analytics.example.org/a.js" data-site-id="42"></script>',
    "<script>window.ran = (window.ran || 0) + 1; window.lt = 1 < 2 && \"</x>\";</script>",
    '<noscript><img src="https://analytics.example.org/pixel.gif"></noscript>',
    "some stray text",
  ].join("\n");
  const w = await page({ analytics: { headHtml } });
  assert.strictEqual(await w.UDP_SITE.analyticsDone, 3);
  assert.deepStrictEqual(headTags(w), ["link", "script", "script"]);
  const [link, a] = w.document.head.children;
  assert.strictEqual(link.getAttribute("rel"), "preconnect");
  assert.strictEqual(a.getAttribute("data-site-id"), "42");
  assert(a.hasAttribute("async"), "attribute async was dropped");
  assert.strictEqual(w.ran, 1, "inline snippet code did not run exactly once");
  assert.strictEqual(w.lt, "</x>");
  assert.strictEqual(w.document.querySelector("noscript, img"), null, "noscript content was inserted");
  w.close();
};

exports["site.js: an inline script waits for the external script before it"] = async () => {
  if (!JSDOM) return;
  const headHtml =
    '<script src="https://analytics.example.org/lib.js" defer></script>\n' +
    "<script>window.seen = typeof window.Lib;</script>";
  const w = await page({ analytics: { headHtml } });
  await tick();
  assert.deepStrictEqual(headTags(w), ["script"], "the inline script did not wait for lib.js");
  assert(w.document.head.firstChild.hasAttribute("defer"), "attribute defer was dropped");
  assert.strictEqual(w.seen, undefined);
  loadScript(w, "https://analytics.example.org/lib.js", () => { w.Lib = {}; });
  assert.strictEqual(await w.UDP_SITE.analyticsDone, 2);
  assert.strictEqual(w.seen, "object", "inline script ran before the library was loaded");

  // A failing library does not stop the rest of the snippet.
  const e = await page({ analytics: { headHtml } });
  await tick();
  e.document.head.querySelector("script[src]").dispatchEvent(new e.Event("error"));
  assert.strictEqual(await e.UDP_SITE.analyticsDone, 2);
  assert.strictEqual(e.seen, "undefined");
  w.close();
  e.close();
};

exports["site.js: async scripts do not hold up the chain"] = async () => {
  if (!JSDOM) return;
  const w = await page({
    analytics: { headHtml: '<script async src="https://analytics.example.org/a.js"></script><script>window.ran = 1;</script>' },
  });
  assert.strictEqual(await w.UDP_SITE.analyticsDone, 2);
  assert.strictEqual(w.ran, 1);
  w.close();
};

exports["site.js: a second execution does not insert the snippet again"] = async () => {
  if (!JSDOM) return;
  const w = await page({ analytics: { headHtml: "<script>window.ran = (window.ran || 0) + 1;</script>" } }, { runs: 2 });
  await w.UDP_SITE.analyticsDone;
  await tick();
  assert.strictEqual(w.document.head.querySelectorAll("script").length, 1);
  assert.strictEqual(w.ran, 1);
  w.close();
};

exports["site.js: cockpit runs the snippet only with includeCockpit, legal links always"] = async () => {
  if (!JSDOM) return;
  const legal = { impressumUrl: "/impressum" };
  const headHtml = "<script>window.ran = 1;</script>";
  for (const [analytics, context, expected] of [
    [{ headHtml }, "cockpit", 0],
    [{ headHtml, includeCockpit: false }, "cockpit", 0],
    [{ headHtml, includeCockpit: "true" }, "cockpit", 0],
    [{ headHtml, includeCockpit: true }, "cockpit", 1],
    [{ headHtml }, null, 1],
    [{ headHtml, includeCockpit: false }, null, 1],
  ]) {
    const w = await page({ legal, analytics }, { context });
    const label = `${JSON.stringify(analytics)} in ${context || "public"}`;
    assert.strictEqual(await w.UDP_SITE.analyticsDone, expected, label);
    assert.strictEqual(w.ran, expected ? 1 : undefined, label);
    assert.strictEqual(w.document.querySelectorAll("[data-udp-legal] a").length, 1, `legal link missing: ${label}`);
    w.close();
  }
};

exports["site.js: legal links only for http(s) and single-slash paths"] = async () => {
  if (!JSDOM) return;
  const body = "<nav data-udp-legal hidden></nav><footer><span data-udp-legal hidden></span></footer>";
  const w = await page(
    { legal: { impressumUrl: "https://www.example.org/impressum", datenschutzUrl: "/datenschutz" } },
    { body },
  );
  for (const box of w.document.querySelectorAll("[data-udp-legal]")) {
    assert(!box.hidden, "container stays hidden although links exist");
    const links = [...box.querySelectorAll("a")].map(a => [a.textContent, a.getAttribute("href"), a.getAttribute("rel"), a.getAttribute("target")]);
    assert.deepStrictEqual(links, [
      ["Impressum", "https://www.example.org/impressum", null, null],
      ["Datenschutz", "/datenschutz", null, null],
    ]);
  }
  // Idempotent re-render
  w.UDP_SITE.renderLegal();
  assert.strictEqual(w.document.querySelectorAll("nav a").length, 2);
  w.close();

  // Only one of them configured
  const one = await page({ legal: { datenschutzUrl: "http://www.example.org/ds" } });
  assert.deepStrictEqual([...one.document.querySelectorAll("a")].map(a => a.textContent), ["Datenschutz"]);
  one.close();

  const bad = [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<b>x</b>",
    "//evil.example", "/\\evil.example", "https://", "https:///evil.example", "ftp://example.org",
    "/a b", "/a\nb", "impressum", 42, null,
    // invisible format characters (Cf): BOM, zero-width space, right-to-left override
    "﻿https://www.example.org/impressum", "https://www.example.org/impressum﻿",
    "/‮impressum", "https://www.example.org/‮gpj.exe", "/impres​sum",
  ];
  for (const url of bad) {
    const v = await page({ legal: { impressumUrl: url, datenschutzUrl: url } });
    const nav = v.document.querySelector("[data-udp-legal]");
    assert.strictEqual(nav.children.length, 0, `${JSON.stringify(url)} became a link`);
    assert(nav.hidden, `container visible for ${JSON.stringify(url)}`);
    v.close();
  }
};

exports["site.js: logo rendered only when configured, link only for a valid href"] = async () => {
  if (!JSDOM) return;
  const body = "<header><span data-udp-logo hidden></span></header><div data-udp-logo hidden></div>";
  const logo = { src: "/branding/logo.png", alt: "Musterstadt", href: "https://www.example.org/" };
  const w = await page({ branding: { logo } }, { body });
  for (const box of w.document.querySelectorAll("[data-udp-logo]")) {
    assert(!box.hidden, "logo placeholder stays hidden although a logo is configured");
    const a = box.firstElementChild;
    assert.strictEqual(a.localName, "a");
    assert.strictEqual(a.getAttribute("href"), "https://www.example.org/");
    assert.strictEqual(a.getAttribute("target"), null);
    const img = a.firstElementChild;
    assert.deepStrictEqual([img.localName, img.getAttribute("src"), img.getAttribute("alt")],
      ["img", "/branding/logo.png", "Musterstadt"]);
  }
  w.UDP_SITE.renderLogo();
  assert.strictEqual(w.document.querySelectorAll("[data-udp-logo] img").length, 2, "re-render is not idempotent");
  w.close();

  // No href, an invalid href, no alt: a bare <img> with the default alt text.
  for (const href of [undefined, "", "javascript:alert(1)", "//evil.example"]) {
    const v = await page({ branding: { logo: { src: "/branding/logo.svg", href } } }, { body });
    const box = v.document.querySelector("[data-udp-logo]");
    assert(!box.hidden);
    assert.strictEqual(box.children.length, 1);
    assert.strictEqual(box.firstElementChild.localName, "img", `href ${JSON.stringify(href)} became a link`);
    assert.strictEqual(box.firstElementChild.getAttribute("alt"), "Logo");
    v.close();
  }

  // No logo or an unusable src: placeholders stay hidden and empty.
  for (const branding of [undefined, {}, { logo: null }, { logo: { src: "javascript:alert(1)" } }, { logo: { src: "" } },
    { logo: { src: "//evil.example/logo.png" } }]) {
    const v = await page(branding === undefined ? {} : { branding }, { body });
    for (const box of v.document.querySelectorAll("[data-udp-logo]")) {
      assert(box.hidden, `placeholder visible for ${JSON.stringify(branding)}`);
      assert.strictEqual(box.children.length, 0);
    }
    v.close();
  }
};

exports["Public pages and the cockpit use /favicon and offer a logo placeholder"] = () => {
  for (const f of PAGES.concat("../index.html")) {
    const html = fs.readFileSync(path.join(PUB, f), "utf8");
    assert(/<link rel="icon" href="\/favicon" ?\/?>/.test(html), `${f}: <link rel="icon" href="/favicon"> missing`);
    assert(!html.includes('href="/icon.svg"'), `${f}: still links /icon.svg as icon`);
  }
  for (const f of PAGES.filter(p => p !== "404.html")) {
    const html = fs.readFileSync(path.join(PUB, f), "utf8");
    const header = /<header>([\s\S]*?)<\/header>/.exec(html);
    assert(header, `${f}: <header> not found`);
    assert(/^\s*<span class="udp-logo" data-udp-logo hidden><\/span>/.test(header[1]),
      `${f}: hidden logo placeholder must open the header`);
  }
};

exports["Generated city/district stubs use /favicon"] = () => {
  const dir = path.join(PUB, "g");
  const stubs = fs.readdirSync(dir);
  assert(stubs.length > 1000, `only ${stubs.length} stubs`);
  const stale = stubs.filter(s => !fs.readFileSync(path.join(dir, s, "index.html"), "utf8").includes('<link rel="icon" href="/favicon">'));
  assert.deepStrictEqual(stale.slice(0, 5), [], `${stale.length} stubs without /favicon – run scripts/generate-city-pages.py`);
};

exports["URL rule is identical in site.js, config.ts and the Helm chart"] = () => {
  const jsBody = src => {
    const m = /const SAFE_URL =\s*\/(.+)\/iu;/.exec(src);
    assert(m, "SAFE_URL not found");
    return m[1].replace(/\\\//g, "/");
  };
  const site = jsBody(SITE);
  const ts = jsBody(fs.readFileSync(path.join(ROOT, "gui/src/config.ts"), "utf8"));
  const tpl = fs.readFileSync(path.join(ROOT, "helm/udp/templates/_helpers.tpl"), "utf8");
  const m = /define "udp\.safeUrlRegex" -\}\}\s*\(\?i\)(\S+)\s*\{\{- end/.exec(tpl);
  assert(m, "udp.safeUrlRegex not found in _helpers.tpl");
  assert(site.includes("\\p{Cf}"), "site.js no longer rejects format characters");
  assert.strictEqual(ts, site, "gui/src/config.ts and gui/public/site.js disagree");
  assert.strictEqual(m[1], site, "helm/udp/templates/_helpers.tpl and gui/public/site.js disagree");
};

exports["Public pages load config.js and site.js in the body and offer a legal container"] = () => {
  for (const f of PAGES) {
    const html = fs.readFileSync(path.join(PUB, f), "utf8");
    const head = html.slice(0, html.indexOf("<body"));
    const body = html.slice(html.indexOf("<body"));
    assert(!/src="\/(config|site)\.js"/.test(head),
      `${f}: config.js/site.js in <head> – the city/district stubs never run head scripts`);
    assert(!body.includes("data-udp-context"), `${f}: public pages must not set data-udp-context`);
    const at = s => body.indexOf(`<script src="${s}"></script>`);
    assert(at("/config.js") >= 0, `${f}: /config.js missing in body`);
    assert(at("/site.js") > at("/config.js"), `${f}: /site.js missing or before /config.js`);
    if (at("/smartcity-lib.js") >= 0)
      assert(at("/site.js") < at("/smartcity-lib.js"), `${f}: /site.js must come before /smartcity-lib.js`);
    assert(/<nav class="legal-links" data-udp-legal aria-label="Rechtliches" hidden><\/nav>/.test(body),
      `${f}: hidden legal container (data-udp-legal) missing`);
  }
};

exports["City/district stubs re-run the body scripts of their template"] = () => {
  // The reason site.js lives in the body: nothing under gui/public/g/ has to
  // be regenerated. Should the loader change, this assumption must be revisited.
  for (const stub of ["g/reutlingen/index.html", "g/kreis-reutlingen/index.html"]) {
    const html = fs.readFileSync(path.join(PUB, stub), "utf8");
    assert(html.includes('doc.querySelectorAll("body script")'), `${stub}: loader no longer re-runs body scripts`);
    assert(!html.includes("site.js"), `${stub}: stub loads site.js itself – it would run twice`);
  }
};

exports["Cockpit SPA loads site.js as cockpit right after config.js"] = () => {
  const html = fs.readFileSync(path.join(ROOT, "gui", "index.html"), "utf8");
  const c = html.indexOf('<script src="/config.js"></script>');
  const s = html.indexOf('<script src="/site.js" data-udp-context="cockpit"></script>');
  assert(c >= 0 && s > c, 'gui/index.html: /site.js (data-udp-context="cockpit") missing or before /config.js');
};
