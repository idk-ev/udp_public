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
  const stubs = [...NGINX.matchAll(/\n    location ([^{\n]*)\{([^}]*?try_files [^;]*\/g\$uri\/index\.html[^}]*)\n    \}/g)];
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

exports["renamed slugs: former addresses redirect with 301"] = () => {
  assert.strictEqual(REDIRECTS.get("/remseck-am-neckar"), "/remseck");
  assert.strictEqual(REDIRECTS.get("/malsch-08215"), "/malsch-baden");
  assert.strictEqual(REDIRECTS.get("/malsch-08226"), "/malsch");
  assert(!REDIRECTS.has("/malsch"), "/malsch is a page now, not a redirect");
};

exports["redirects: no live page shadowed, no chains or loops, targets exist"] = () => {
  assert(REDIRECTS.size >= 13, `only ${REDIRECTS.size} redirects found – pattern out of date?`);
  for (const [from, to] of REDIRECTS) {
    const slug = from.slice(1);
    assert(!SLUGS.has(slug) && !fs.existsSync(path.join(PUB, "g", slug)), `${from} shadows a live page`);
    assert(!REDIRECTS.has(to), `${from} -> ${to} redirects again`);
    const target = to.slice(1);
    assert(to === "/" || SLUGS.has(target) || KREIS_SLUGS.has(target), `${from} -> ${to}: no such page`);
  }
};
