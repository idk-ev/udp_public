#!/usr/bin/env node
/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Test-Runner (Sprint 2.8): node tests/run.js [--live]
   static/  — ohne laufenden Stack (CI-fähig): Parsen, Datenintegrität, Invarianten
   live/    — gegen den laufenden Stack (BASE_URL, Default http://localhost:3700) */
"use strict";
const fs = require("fs");
const path = require("path");

const live = process.argv.includes("--live");
const dirs = [path.join(__dirname, "static")].concat(live ? [path.join(__dirname, "live")] : []);
let pass = 0, fail = 0;

(async () => {
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".test.js")).sort()) {
      const mod = require(path.join(dir, f));
      for (const [name, fn] of Object.entries(mod)) {
        try {
          await fn();
          pass++;
          console.log(`  ✓ ${f} › ${name}`);
        } catch (e) {
          fail++;
          console.error(`  ✗ ${f} › ${name}\n    ${String(e.message || e).split("\n")[0]}`);
        }
      }
    }
  }
  console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen${live ? " (inkl. live)" : " (statisch)"}`);
  process.exit(fail ? 1 : 0);
})();
