#!/usr/bin/env node
/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Test runner (Sprint 2.8): node tests/run.js [--live]
   static/  — without a running stack (CI-capable): parsing, data integrity, invariants
   parity/  — old against new per connector (compiled from platform/connectors/test)
   live/    — against the running stack (BASE_URL, default http://localhost:3700)

   One runner for everything: the parity tests of the connector migration hang
   in here instead of in a second suite, otherwise the pre-commit hook checks one
   half and CI the other. They exist as COMPILED TypeScript and are therefore
   loaded differently — see below. If the directory is missing (before the first
   `npm --prefix platform/connectors run build`), it is skipped — unless
   REQUIRE_PARITY=1 is set (CI's connectors job): then a missing directory, or
   one with fewer than MIN_PARITY_FILES test files, fails the run instead of
   letting a broken build pass as "0 parity tests". */
"use strict";
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const live = process.argv.includes("--live");
const PARITY = path.join(__dirname, "..", "platform", "connectors", "dist", "test", "parity");
// 44 parity test files today; the slack allows merging a few, not losing the suite.
const MIN_PARITY_FILES = 40;
if (process.env.REQUIRE_PARITY === "1") {
  const found = fs.existsSync(PARITY) ? fs.readdirSync(PARITY).filter(x => x.endsWith(".test.js")).length : 0;
  if (found < MIN_PARITY_FILES) {
    console.error(`✗ REQUIRE_PARITY: ${found} parity test files in ${PARITY}, expected at least ${MIN_PARITY_FILES} — build platform/connectors first`);
    console.log("\n0 bestanden, 1 fehlgeschlagen (Paritätstests fehlen)");
    process.exit(1);
  }
}
const dirs = [path.join(__dirname, "static")]
  .concat(fs.existsSync(PARITY) ? [PARITY] : [])
  .concat(live ? [path.join(__dirname, "live")] : []);
let pass = 0, fail = 0, finished = false;

// Node's fetch goes through one process-wide undici dispatcher, created by the
// first fetch call. A test dependency with an undici of its own (jsdom) swaps
// it for its own when loaded; the connector tests then reached their local
// servers through that one, and reused keep-alive connections stalled for
// ~2 s (the pacing test in orion.test.js failed). So Node's own is created
// here, before any test file loads (a data: URL, no network), and put back
// after every test file and every test.
const DISPATCHER = Symbol.for("undici.globalDispatcher.1");
if (typeof fetch === "function") fetch("data:,").catch(() => {});
const nodeDispatcher = globalThis[DISPATCHER];
const restoreDispatcher = () => {
  if (nodeDispatcher !== undefined && globalThis[DISPATCHER] !== nodeDispatcher) globalThis[DISPATCHER] = nodeDispatcher;
};

// A test that awaits nothing but an unref'd timer lets the event loop run dry:
// Node then exits with code 0 in the middle of the suite and prints no
// failure. That is a silent pass, so an exit before the summary is a failure.
process.on("exit", () => {
  if (!finished) {
    console.error(`\n✗ runner exited before finishing (${pass} passed, ${fail} failed so far) — a test left no pending work`);
    process.exitCode = 1;
  }
});

(async () => {
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".test.js")).sort()) {
      // The connector service is an ESM package ("type": "module"); require()
      // would not get past its compiled output code.
      const file = path.join(dir, f);
      const mod = dir === PARITY ? await import(pathToFileURL(file).href) : require(file);
      restoreDispatcher();
      for (const [name, fn] of Object.entries(mod)) {
        try {
          await fn();
          pass++;
          console.log(`  ✓ ${f} › ${name}`);
        } catch (e) {
          fail++;
          // The full message, indented: a parity failure carries its diff
          // listing below the summary line, and that listing is the point.
          const message = String((e && e.message) || e).split("\n").map(line => `    ${line}`).join("\n");
          console.error(`  ✗ ${f} › ${name}\n${message}`);
        }
        restoreDispatcher();
      }
    }
  }
  finished = true;
  console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen${live ? " (inkl. live)" : " (statisch)"}`);
  process.exit(fail ? 1 : 0);
})();
