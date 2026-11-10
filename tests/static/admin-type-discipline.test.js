/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Proof that the type discipline of the admin panel takes effect, in the manner
   of type-discipline.test.js: tsc and eslint are let loose on files that MUST
   fail, and the expected rule has to fire. Whoever defuses a rule brings this
   test down. Without installed dependencies it skips: the static suite runs on a
   fresh clone without npm install. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const SERVICE = path.join(ROOT, "platform", "admin");
const INSTALLED = fs.existsSync(path.join(SERVICE, "node_modules"));
const SYNCED = fs.existsSync(path.join(SERVICE, ".svelte-kit"));

function run(command, args) {
  const r = spawnSync(command, args, {
    cwd: SERVICE,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return { code: r.status, output: `${r.stdout || ""}${r.stderr || ""}` };
}

exports["admin panel: tsc hardening takes effect"] = () => {
  if (!INSTALLED || !SYNCED) return;
  const { code, output } = run("npx", ["tsc", "-p", "tsconfig.hardening.json"]);
  assert.notStrictEqual(code, 0, "test/hardening/tsc-must-fail.ts compiles — a hardening was switched off");
  for (const message of ["possibly 'undefined'", "implicitly has an 'any' type"]) {
    assert(output.includes(message), `expected "${message}" in:\n${output}`);
  }
};

exports["admin panel: ESLint rules fire in .ts and .svelte, eslint-disable has no effect"] = () => {
  if (!INSTALLED || !SYNCED) return;
  for (const file of ["test/hardening/eslint-must-fail.ts", "test/hardening/EslintMustFail.svelte"]) {
    const { code, output } = run("npx", ["eslint", "--config", "eslint.hardening.config.js", file]);
    assert.notStrictEqual(code, 0, `${file} is clean — a rule was defused`);
    for (const rule of [
      "@typescript-eslint/no-explicit-any",
      "@typescript-eslint/consistent-type-assertions",
      "@typescript-eslint/no-non-null-assertion",
    ]) {
      assert(output.includes(rule), `${rule} does not fire in ${file}:\n${output}`);
    }
  }
};
