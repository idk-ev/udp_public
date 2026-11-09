/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Public pages and blocks from the admin panel: nginx answers a blocked address
   itself, the pages only tidy up (lists, search, open tabs). Whatever goes wrong with
   the list, the page must behave as if nothing was blocked. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM, ROOT, PUB, LIB, GEM, json, leafletStub } = require("./page-harness.js");

const BLOCKED = { version: 1, blocked: [{ slug: "pfullingen", ags: "08415059", kreisSlug: "kreis-reutlingen", kreisName: "Landkreis Reutlingen" }] };
const KREIS_RT = GEM.kreise.find(k => k[7] === "kreis-reutlingen");
const pause = ms => new Promise(r => setTimeout(r, ms));

async function until(what, check) {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > 10000) throw new Error(`timeout: ${what}`);
    await pause(20);
  }
}

/* A page with its scripts, against a backend with the given list of blocks. */
function open(file, url, blocks, globals = {}) {
  const html = fs.readFileSync(path.join(PUB, file), "utf8").replace(/<script src="[^"]*"><\/script>/g, "");
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(w, globals);
  const state = { blocks, calls: [] };
  w.fetch = async u => {
    const s = decodeURIComponent(String(u));
    state.calls.push(s);
    if (s === "/city-blocks.json") {
      const answer = state.blocks;
      if (answer instanceof Error) throw answer;
      return typeof answer === "number" ? json({}, answer) : new Response(typeof answer === "string" ? answer : JSON.stringify(answer));
    }
    if (s.startsWith("/gateway")) return s.includes("/entities/") ? json({ title: "Not Found" }, 404) : json([]);
    const f = path.join(PUB, s.split("?")[0]);
    return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : json({}, 404);
  };
  leafletStub(w);
  w.eval(LIB);
  return { w, d: w.document, state, run: () => { for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) w.eval(m[1]); } };
}

exports["SC.cityBlocks: finds by slug and key"] = async () => {
  const { w } = open("404.html", "https://udp.example/", BLOCKED);
  const blocks = await w.SC.cityBlocks();
  assert.strictEqual(blocks.isBlocked("pfullingen"), true);
  assert.strictEqual(blocks.isBlocked("x", "08415059"), true);
  assert.strictEqual(blocks.isBlocked("reutlingen", "08415061"), false);
  assert.strictEqual(blocks.isBlocked("reutlingen"), false);
};

exports["SC.cityBlocks: fails open on every kind of error"] = async () => {
  const cases = [new Error("offline"), 404, 503, "kein json", "null", "[]", '{"blocked":"x"}', '{"blocked":[null,1,{"slug":2}]}'];
  for (const answer of cases) {
    const { w } = open("404.html", "https://udp.example/", answer);
    const blocks = await w.SC.cityBlocks();
    assert.strictEqual(blocks.isBlocked("pfullingen", "08415059"), false, String(answer));
  }
};

exports["kreis.html: a blocked municipality leaves list and map, the totals stay"] = async () => {
  const page = open("kreis.html", "https://udp.example/kreis-reutlingen", BLOCKED, { KREIS: { krs: "08415", slug: "kreis-reutlingen" } });
  page.run();
  await until("rendered", () => /^Stand:/.test(page.d.getElementById("stand").textContent));
  const rows = page.d.querySelector("#gems tbody").textContent;
  assert(!rows.includes("Pfullingen"), "still in the list");
  assert(rows.includes("Reutlingen"), "the others stay");
  assert.strictEqual(page.d.querySelector("#gems tbody").querySelectorAll("tr").length, KREIS_RT[5] - 1);
  assert(page.d.getElementById("subtitle").textContent.startsWith(`${KREIS_RT[5]} Gemeinden`), "the totals stay");
  assert.strictEqual(page.d.getElementById("gem-title").textContent, `Gemeinden (${KREIS_RT[5] - 1})`);
};

exports["a rollout's older library without cityBlocks: pages work as if nothing was blocked"] = async () => {
  for (const [file, ready] of [["mitmachen.html", d => /Gemeinden und/.test(d.getElementById("count").textContent)]]) {
    const page = open(file, "https://udp.example/", BLOCKED);
    delete page.w.SC.cityBlocks;
    page.run();
    await until(file, () => ready(page.d));
    assert.match(page.d.getElementById("count").textContent, /1\.103 Gemeinden/);
  }
  const kreis = open("kreis.html", "https://udp.example/kreis-reutlingen", BLOCKED, { KREIS: { krs: "08415", slug: "kreis-reutlingen" } });
  delete kreis.w.SC.cityBlocks;
  kreis.run();
  await until("rendered", () => /^Stand:/.test(kreis.d.getElementById("stand").textContent));
  assert.strictEqual(kreis.d.querySelector("#gems tbody").querySelectorAll("tr").length, KREIS_RT[5]);
  for (const file of ["stadt.html", "kreis.html", "mitmachen.html", "dashboard.html"]) {
    const source = fs.readFileSync(path.join(PUB, file), "utf8");
    assert(!/(?<![.\w])SC\.cityBlocks\(\)\)|await SC\.cityBlocks\(\)/.test(source), `${file} calls the library unguarded`);
    assert.match(source, /SC\.cityBlocks \? SC\.cityBlocks\(\)/, file);
  }
};

exports["kreis.html: nothing changes when the list cannot be read"] = async () => {
  const page = open("kreis.html", "https://udp.example/kreis-reutlingen", new Error("offline"), { KREIS: { krs: "08415", slug: "kreis-reutlingen" } });
  page.run();
  await until("rendered", () => /^Stand:/.test(page.d.getElementById("stand").textContent));
  assert.strictEqual(page.d.querySelector("#gems tbody").querySelectorAll("tr").length, KREIS_RT[5]);
};

exports["mitmachen.html: blocked pages are not offered, examples lose their link"] = async () => {
  const blocks = { version: 1, blocked: [{ slug: "tuebingen", ags: "08416041" }, { slug: "kreis-reutlingen" }, { slug: "stuttgart", ags: "08111000" }] };
  const page = open("mitmachen.html", "https://udp.example/", blocks);
  page.run();
  await until("loaded", () => /Gemeinden und/.test(page.d.getElementById("count").textContent));
  const search = term => {
    const q = page.d.getElementById("q");
    q.value = term;
    q.dispatchEvent(new page.w.Event("input"));
    return [...page.d.querySelectorAll("#sug li[data-slug]")].map(li => li.dataset.slug);
  };
  const tuebingen = search("Tübingen");
  assert(tuebingen.includes("kreis-tuebingen"), "the district stays");
  assert(!tuebingen.includes("tuebingen"), "tuebingen offered");
  const reutlingen = search("Reutlingen");
  assert(reutlingen.includes("reutlingen"), "reutlingen must stay");
  assert(!reutlingen.includes("kreis-reutlingen"), "district offered");
  assert.deepStrictEqual(search("Stuttgart"), [], "a Stadtkreis goes with its town");
  assert.strictEqual(page.d.querySelector("a[href='/tuebingen']"), null, "example still links");
  assert(page.d.querySelector("a[href='/boellen']"), "other examples stay");
  assert(!page.d.querySelector("#embed").value.includes("/tuebingen?"), "embed example shows a blocked page");
  assert.match(page.d.getElementById("count").textContent, /1\.101 Gemeinden und 34 Landkreise/);
};

/* jsdom cannot navigate, so this one is about the source; the browser run covers it. */
exports["stadt.html: /stadt.html?ags= of a blocked page goes to its real address"] = () => {
  const source = fs.readFileSync(path.join(PUB, "stadt.html"), "utf8");
  assert.match(source, /isBlocked\(row\[8\], row\[0\]\)\) \{ location\.replace\("\/" \+ row\[8\]\); return; \}/);
  assert(source.indexOf("!inlineRow && (await SC.cityBlocks())") < source.indexOf("SC.themeSelector(\"#thememount\", cfg0"), "before rendering");
};

exports["open tabs: a refresh checks the list and reloads; the first load does not"] = () => {
  for (const file of ["stadt.html", "kreis.html"]) {
    const source = fs.readFileSync(path.join(PUB, file), "utf8");
    const refresh = source.slice(source.lastIndexOf("SC.autoRefresh") - 400, source.lastIndexOf("SC.autoRefresh") + 300);
    assert.match(refresh, /isBlocked\([^)]*\)\) \{ location\.reload\(\); return; \}/, `${file}: no reload on a block`);
    assert.strictEqual(source.split("location.reload()").length - 1, 2, `${file}: one reload for the build guard, one here`);
  }
};

exports["dashboard.html: shows blocked pages, marked"] = () => {
  const source = fs.readFileSync(path.join(PUB, "dashboard.html"), "utf8");
  assert.match(source, /cityBlocks\(\)/);
  assert.match(source, /blockedMark = slug => BLOCKS\.isBlocked\(slug\) \? " \(gesperrt\)" : ""/);
  assert.strictEqual(source.split("blockedMark(").length - 1, 4, "search and pulldown, municipality and district");
};

exports["the published sitemap keeps the origin placeholder handling"] = () => {
  const nginx = fs.readFileSync(path.join(ROOT, "platform", "config", "nginx", "cockpit.conf.template"), "utf8");
  for (const name of ["= /sitemap.xml", "@udp_sitemap_image"]) {
    const start = nginx.indexOf(`location ${name} {`);
    assert(start >= 0, name);
    const body = nginx.slice(start, nginx.indexOf("\n    }", start));
    assert.match(body, /sub_filter '__PUBLIC_ORIGIN__' \$udp_public_origin;/, name);
    assert.match(body, /sub_filter_once off;/, name);
    assert.match(body, /default_type application\/xml;/, name);
  }
};

exports["sitemap and list of blocks cannot run anything when opened directly"] = () => {
  const nginx = fs.readFileSync(path.join(ROOT, "platform", "config", "nginx", "cockpit.conf.template"), "utf8");
  for (const name of ["= /sitemap.xml", "@udp_sitemap_image", "= /city-blocks.json", "@udp_city_blocks_empty"]) {
    const start = nginx.indexOf(`location ${name} {`);
    const body = nginx.slice(start, nginx.indexOf("\n    }", start));
    assert.match(body, /Content-Security-Policy "default-src 'none'; frame-ancestors 'self'; sandbox" always/, name);
  }
};

/* The location for other spellings on a case-insensitive disk (Compose on Windows, macOS). */
const nginxText = fs.readFileSync(path.join(ROOT, "platform", "config", "nginx", "cockpit.conf.template"), "utf8");
const SPELLINGS = new RegExp(/location ~ "(\^\/\(\?:\[a-zA-Z0-9-\][^"]+)" \{\n\s+return 404;/.exec(nginxText)[1]);

exports["other spellings of a page address: caught, in all forms"] = () => {
  for (const uri of ["/Reutlingen", "/REUTLINGEN", "/reutlingeN/", "/G/reutlingen", "/G/reutlingen/", "/g/Reutlingen",
    "/g/REUTLINGEN/", "/g/Reutlingen/index.html", "/G/reutlingen/index.html", "/g/reutlingen/INDEX.HTML", "/G/"]) {
    assert(SPELLINGS.test(uri), uri);
  }
  assert.match(nginxText, /location ~\* \^\/stadt\\\.html\$ \{\n\s+return 404;/);
};

exports["other spellings: no real file and no lower-case address is caught"] = () => {
  for (const uri of ["/reutlingen", "/reutlingen/", "/kreis-reutlingen", "/g/reutlingen/", "/g/reutlingen/index.html", "/", "/stadt.html"]) {
    assert(!SPELLINGS.test(uri), uri);
  }
  // What the build produces: hashed names with capitals, under /assets/.
  for (const uri of ["/assets/index-BYpVL0tF.css", "/assets/index-DhrFy2B-.js", "/vendor/leaflet.js", "/ngsi-ld/v1/Context.jsonld", "/branding/Logo.png"]) {
    assert(!SPELLINGS.test(uri), uri);
  }
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name === "g" && dir === PUB) return [];
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
  for (const file of walk(PUB)) {
    const uri = "/" + path.relative(PUB, file).replace(/\\/g, "/");
    assert(!SPELLINGS.test(uri), `real file caught: ${uri}`);
  }
};

exports["the defaults of the gate can never name a file"] = () => {
  for (const name of ["$uri $udp_city_slug", "$arg_ags $udp_city_ags"]) {
    const block = nginxText.slice(nginxText.indexOf(`map ${name} {`));
    assert.match(block.slice(0, block.indexOf("}\n")), /default\s+"\/";/, name);
  }
};

exports["robots.txt does not list pages: crawlers must see the 410"] = () => {
  const robots = fs.readFileSync(path.join(PUB, "robots.txt"), "utf8");
  assert(!/nicht-verfuegbar|city-blocks/.test(robots));
};
