/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Municipality permalinks in the cockpit nginx (cockpit.conf.template): the
   /<slug> stubs are revalidated like every other page, renamed slugs keep
   their former address as a 301, and no redirect points at another redirect
   or shadows a live page. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const PUB = path.join(ROOT, "gui", "public");
const NGINX = fs.readFileSync(path.join(ROOT, "platform", "config", "nginx", "cockpit.conf.template"), "utf8");
const GEN = fs.readFileSync(path.join(ROOT, "scripts", "generate-bw-municipalities.py"), "utf8");
const DATA = JSON.parse(fs.readFileSync(path.join(PUB, "bw-gemeinden.json"), "utf8"));

const SLUGS = new Set(DATA.gemeinden.map(g => g[8]));
const KREIS_SLUGS = new Set(DATA.kreise.map(k => k[7]));
// Exact-match redirects: source -> target.
const REDIRECTS = new Map([...NGINX.matchAll(/location = (\/\S*) \{ return 301 (\S+); \}/g)].map(m => [m[1], m[2]]));

exports["cockpit nginx: /<slug> stubs are revalidated (Cache-Control: no-cache)"] = () => {
  // try_files serves the stub from "location /" itself; the .html location
  // never sees /stuttgart or /kreis-esslingen.
  // (The loopback hop server has a "location /" of its own: find the public
  // one by its try_files.)
  const stubs = [...NGINX.matchAll(/\n    location ([^{\n]*)\{((?:[^}]|\{[^}]*\})*?try_files [^;]*\/g\$uri\/index\.html[^}]*)\n    \}/g)];
  assert.strictEqual(stubs.length, 1, "exactly one location serves the slug stubs");
  assert.strictEqual(stubs[0][1].trim(), "/");
  assert.match(stubs[0][2], /try_files \$uri \$uri\/ \/g\$uri\/index\.html =404;/);
  assert.match(stubs[0][2], /expires -1;/, "slug stubs without expires -1");
  // The other page locations keep theirs.
  assert.match(NGINX, /location = \/ \{\n\s+expires -1;/);
  assert.match(NGINX, /location ~\* \\\.\(css\|js\|html\|json\)\$ \{\n\s+expires -1;/);
};

exports["renamed slugs: generator overrides, data and stubs agree"] = () => {
  const block = GEN.match(/SLUG_OVERRIDES = \{([\s\S]*?)\n\}/);
  assert(block, "SLUG_OVERRIDES missing in generate-bw-municipalities.py");
  const overrides = Object.fromEntries([...block[1].matchAll(/"(\d{8})": "([a-z0-9-]+)"/g)].map(m => [m[1], m[2]]));
  assert.deepStrictEqual(overrides, { "08118081": "remseck", "08215046": "malsch-baden", "08226046": "malsch" });
  for (const [ags, slug] of Object.entries(overrides)) {
    const row = DATA.gemeinden.find(g => g[0] === ags);
    assert(row, `${ags} missing in bw-gemeinden.json`);
    assert.strictEqual(row[8], slug, `${ags}: slug in bw-gemeinden.json`);
    const stub = fs.readFileSync(path.join(PUB, "g", slug, "index.html"), "utf8");
    assert(stub.includes(`<link rel="canonical" href="/${slug}">`), `${slug}: stub canonical`);
    assert(stub.includes(`"ags": "${ags}"`), `${slug}: stub for the wrong municipality`);
  }
  for (const old of ["remseck-am-neckar", "malsch-08215", "malsch-08226"]) {
    assert(!SLUGS.has(old), `${old} still a slug`);
    assert(!fs.existsSync(path.join(PUB, "g", old)), `stale stub g/${old}`);
  }
};

exports["redirects: no live page shadowed, no chains or loops, targets exist"] = () => {
  assert(REDIRECTS.size >= 10, `only ${REDIRECTS.size} redirects found – pattern out of date?`);
  for (const [from, to] of REDIRECTS) {
    const slug = from.slice(1).replace(/\/$/, "");
    assert(!SLUGS.has(slug) && !fs.existsSync(path.join(PUB, "g", slug)), `${from} shadows a live page`);
    assert(!REDIRECTS.has(to), `${from} -> ${to} redirects again`);
    const target = to.slice(1);
    assert(to === "/" || SLUGS.has(target) || KREIS_SLUGS.has(target), `${from} -> ${to}: no such page`);
  }
};

/* Blocked pages (admin panel): the gate of each location that can serve a page. */
const GATE_DIR = "/etc/nginx/udp-city-blocks";
function location(name) {
  // The last one: the loopback hop server has a "location /" of its own.
  const start = NGINX.lastIndexOf(`\n    location ${name} {`);
  assert(start >= 0, `location ${name} missing`);
  const end = NGINX.indexOf("\n    }", start);
  return NGINX.slice(start, end);
}

exports["blocked pages: every location that serves a page checks its marker first"] = () => {
  for (const name of ["/", "~ ^/g/[^/]+/index\\.html$"]) {
    const body = location(name);
    const gate = body.indexOf(`if (-f ${GATE_DIR}/slug-$udp_city_slug) { return 410; }`);
    assert(gate >= 0, `${name}: no gate`);
    assert(gate < body.indexOf("try_files"), `${name}: gate after try_files`);
  }
  const template = location("= /stadt.html");
  assert(template.indexOf(`if (-f ${GATE_DIR}/ags-$udp_city_ags) { return 410; }`) >= 0, "/stadt.html: no gate");
};

exports["blocked pages: the gate is not in the server block, and its error page has none"] = () => {
  const server = NGINX.slice(NGINX.lastIndexOf("\nserver {"));
  const outside = server.replace(/\n    location [^\n]*\{[\s\S]*?\n    \}/g, "");
  assert(!outside.includes("udp-city-blocks"), "a gate in the server block runs again on the error page");
  assert(/error_page 410 \/nicht-verfuegbar\.html;/.test(NGINX));
  const page = location("= /nicht-verfuegbar.html");
  assert(/\binternal;/.test(page), "the page must not have an address of its own");
  assert(!page.includes("udp_city"), "the error page must not check again");
  assert(/X-Robots-Tag "noindex" always/.test(page));
  assert(/Cache-Control "no-store" always/.test(page));
  assert(/frame-ancestors \$\{UDP_FRAME_ANCESTORS\}/.test(page), "embeds must be able to show it");
  assert(!/X-Frame-Options/.test(page), "X-Frame-Options would forbid the embed again");
  assert(fs.existsSync(path.join(PUB, "nicht-verfuegbar.html")));
};

exports["blocked pages: the page says nothing about who or why"] = () => {
  const text = fs.readFileSync(path.join(PUB, "nicht-verfuegbar.html"), "utf8").toLowerCase();
  assert(text.includes("diese seite ist nicht verfügbar"));
  for (const word of ["gesperrt", "abgeschaltet", "deaktiviert", "widerspr", "wunsch", "auf anfrage"]) {
    assert(!text.includes(word), `neutral text must not say: ${word}`);
  }
};

exports["blocked pages: the slug pattern of the gate fits every slug, and only makes a file name"] = () => {
  const pattern = /map \$uri \$udp_city_slug \{\n\s+"~([^"]+)"/.exec(NGINX);
  assert(pattern, "map $udp_city_slug missing");
  const regex = new RegExp(pattern[1]);
  for (const slug of [...SLUGS, ...KREIS_SLUGS]) {
    for (const form of [`/${slug}`, `/${slug}/`, `/g/${slug}`, `/g/${slug}/`, `/g/${slug}/index.html`]) {
      assert.strictEqual(regex.exec(form)?.[1], slug, form);
    }
  }
  for (const uri of ["/a/b", "/../etc", "/a.b", "/a%2fb", "/A", "/g/a/b", "/g/a/x.html"]) {
    assert.strictEqual(regex.exec(uri), null, uri);
  }
};

/* Addresses with a meaning of their own in the cockpit nginx: a slug of that name
   would never be reached. */
exports["no slug equals a reserved path"] = () => {
  const reserved = new Set(["g", "gateway", "ops", "branding", "vendor", "ngsi-ld", "favicon", "abfahrten",
    "cockpit", "daten", "karte", "zeitreihen", "module", "verwaltung", "admin", "assets"]);
  for (const match of NGINX.matchAll(/\n    location (?:= |\^~ )?\/([a-z0-9-]+)[/ ]/g)) reserved.add(match[1]);
  for (const slug of [...SLUGS, ...KREIS_SLUGS]) assert(!reserved.has(slug), `${slug} is a reserved path`);
};
