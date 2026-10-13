/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Rollout guard of stadt.html / kreis.html: during a cockpit rollout a page
   can get its template from a new pod and smartcity-lib.js from an old one.
   Both carry a build marker (stamped by gui/Dockerfile); on a mismatch the
   page reloads exactly once per marker and session, never in a loop. The
   guard runs here against stand-ins for window, sessionStorage and location. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const PUB = path.join(ROOT, "gui", "public");
const LIB = fs.readFileSync(path.join(PUB, "smartcity-lib.js"), "utf8");
const DOCKERFILE = fs.readFileSync(path.join(ROOT, "gui", "Dockerfile"), "utf8");
const MARKER = "__UDP_BUILD__";
const PAGES = ["stadt.html", "kreis.html"];

const guardOf = file => {
  const html = fs.readFileSync(path.join(PUB, file), "utf8").replace(/\r\n/g, "\n");
  const m = html.match(/\n(\/\/ Rollout guard \(start\)[\s\S]*?\/\/ Rollout guard \(end\))\n/);
  assert(m, `${file}: rollout guard missing`);
  return { html, guard: m[1] };
};

/* Runs the guard as the page would after loading a library with `libBuild`
   (undefined: the library did not load). `store` is the tab's
   sessionStorage contents, null for blocked storage. */
const run = (guard, libBuild, store) => {
  const reloads = [];
  const sessionStorage = store === null ? {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("SecurityError"); },
  } : {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const ctx = { sessionStorage, location: { reload: () => reloads.push(1) } };
  ctx.window = ctx;
  if (libBuild !== undefined) ctx.SC = { BUILD: libBuild };
  let threw = false;
  try { vm.runInNewContext(`"use strict";\n${guard}`, ctx); } catch { threw = true; }
  return { reloads: reloads.length, threw };
};

exports["rollout guard: library and both templates carry the same build marker"] = () => {
  assert.match(LIB, /const BUILD = "__UDP_BUILD__";/);
  assert.match(LIB, /w\.SC = \{ BUILD,/, "SC.BUILD not exported");
  for (const file of PAGES) {
    const { html, guard } = guardOf(file);
    assert(guard.includes(`(window.SC || {}).BUILD !== "${MARKER}"`), `${file}: guard compares another marker`);
    // Before the page touches SC at all, right after the library is loaded.
    const at = html.indexOf("// Rollout guard (start)");
    assert(at > html.indexOf('<script src="/smartcity-lib.js"></script>'), `${file}: guard before the library`);
    assert(at < html.indexOf("= SC;"), `${file}: guard after the first use of SC`);
  }
};

exports["rollout guard: matching marker renders, no reload"] = () => {
  for (const file of PAGES) {
    const store = {};
    assert.deepStrictEqual(run(guardOf(file).guard, MARKER, store), { reloads: 0, threw: false }, file);
    assert.deepStrictEqual(store, {}, `${file}: storage written without a mismatch`);
  }
};

exports["rollout guard: a mismatch reloads exactly once, then renders"] = () => {
  for (const file of PAGES) {
    const { guard } = guardOf(file);
    const store = {};
    // Old library (no marker, or another build): one reload, the rest of the
    // script is stopped.
    assert.deepStrictEqual(run(guard, undefined, store), { reloads: 1, threw: true }, `${file}: first load`);
    // The reload hits the old pod again: no second reload, the page renders.
    assert.deepStrictEqual(run(guard, "0123456789ab", store), { reloads: 0, threw: false }, `${file}: after the reload`);
    assert.deepStrictEqual(run(guard, "0123456789ab", store), { reloads: 0, threw: false }, `${file}: no loop`);
    // A later rollout (another template marker) may reload once again.
    const next = guard.split(MARKER).join("feedfacecafe");
    assert.deepStrictEqual(run(next, MARKER, store), { reloads: 1, threw: true }, `${file}: next build`);
    assert.deepStrictEqual(run(next, MARKER, store), { reloads: 0, threw: false }, `${file}: next build, no loop`);
  }
};

exports["rollout guard: without sessionStorage it never reloads"] = () => {
  for (const file of PAGES) {
    assert.deepStrictEqual(run(guardOf(file).guard, "0123456789ab", null), { reloads: 0, threw: false }, file);
  }
};

exports["cockpit image: build marker stamped from content into all three files, before gzip"] = () => {
  const step = DOCKERFILE.match(/RUN files="([^"]+)";([\s\S]*?)\n(?!\s)/);
  assert(step, "stamping step missing in gui/Dockerfile");
  assert.deepStrictEqual(step[1].split(" ").sort(), ["dist/kreis.html", "dist/smartcity-lib.js", "dist/stadt.html"]);
  // One value for all files, from their content (no commit SHA: unchanged
  // inputs must keep the image digest), and a failed stamp fails the build.
  assert.match(step[2], /build=\$\(cat \$files \| sha256sum \| cut -c1-12\)/);
  assert.match(step[2], /sed -i "s\/__UDP_BUILD__\/\$build\/g" \$files/);
  assert.match(step[2], /grep -q '__UDP_BUILD__' "\$f" \|\| \{[^}]*exit 1; \}/, "a missing placeholder must fail the build");
  assert.match(step[2], /if grep -q '__UDP_BUILD__' \$files; then [^;]*; exit 1; fi/, "a leftover placeholder must fail the build");
  assert(DOCKERFILE.indexOf("RUN npm run build") < step.index, "stamped before the build");
  assert(step.index < DOCKERFILE.indexOf("gzip -9 -k"), "the .gz copies would keep the placeholder");
};
