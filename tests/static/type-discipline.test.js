/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Proof that the type discipline of the connector service takes effect
   technically and does not merely stand in the README (phase 0 of the connector
   migration).

   The occasion is the same experience as with the flow invariants: the ParkAPI
   incident of 24.08.2026 stayed undetected for a month, because nothing checked
   it. A rule nobody enforces is not a rule — and 29 connectors ported with the
   work split up are exactly the situation in which, under time pressure, an
   `any` ends up where the external data is at its most unwieldy.

   What is checked is therefore not the CONFIGURATION (that would again be just
   a regex over source text), but its EFFECT: tsc and eslint are let loose on
   files that MUST fail. Whoever switches off a hardening turns these files green
   and thereby brings this test down.

   Without installed dependencies it skips instead of failing: by project
   decision the static suite runs on a fresh clone without npm install (see
   .githooks/pre-commit). In CI it is installed. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const SERVICE = path.join(ROOT, "platform", "connectors");
const INSTALLED = fs.existsSync(path.join(SERVICE, "node_modules"));

function run(command, args) {
  const r = spawnSync(command, args, {
    cwd: SERVICE,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return { code: r.status, output: `${r.stdout || ""}${r.stderr || ""}` };
}

/* First check that the REAL source text is clean. Without that, a broken
   tsconfig.json could turn both proofs below red and the test would be green
   although nothing compiles any more. */
exports["Connector service compiles and lints cleanly"] = () => {
  if (!INSTALLED) return;
  const t = run("npx", ["tsc", "--noEmit"]);
  assert.strictEqual(t.code, 0, `tsc reports errors in the source text:
${t.output}`);
  const e = run("npx", ["eslint", "."]);
  assert.strictEqual(e.code, 0, `eslint reports errors in the source text:
${e.output}`);
};

exports["tsc hardening takes effect (erasableSyntaxOnly, indexed access, noImplicitAny)"] = () => {
  if (!INSTALLED) return;
  const { code, output } = run("npx", ["tsc", "-p", "tsconfig.hardening.json"]);
  assert.notStrictEqual(
    code,
    0,
    "test/hardening/tsc-must-fail.ts compiles without errors — a hardening in tsconfig.json was switched off"
  );
  for (const [option, message] of [
    ["erasableSyntaxOnly", "erasableSyntaxOnly"],
    ["noUncheckedIndexedAccess", "possibly 'undefined'"],
    ["strict/noImplicitAny", "implicitly has an 'any' type"],
  ]) {
    assert(
      output.includes(message),
      `${option} does not fire any more — expected message "${message}" missing in:
${output}`
    );
  }
};

exports["ESLint hardening takes effect (any, type assertion, !, floating promise)"] = () => {
  if (!INSTALLED) return;
  const { code, output } = run("npx", [
    "eslint",
    "--no-ignore",
    "test/hardening/eslint-must-fail.ts",
  ]);
  assert.notStrictEqual(
    code,
    0,
    "test/hardening/eslint-must-fail.ts is clean — a rule was defused"
  );
  for (const rule of [
    "@typescript-eslint/no-explicit-any",
    "@typescript-eslint/consistent-type-assertions",
    "@typescript-eslint/no-non-null-assertion",
    "@typescript-eslint/no-floating-promises",
  ]) {
    assert(output.includes(rule), `Rule ${rule} does not fire any more:
${output}`);
  }
};

exports["eslint-disable has no effect (noInlineConfig)"] = () => {
  if (!INSTALLED) return;
  // The proof file carries an `eslint-disable` for no-explicit-any. If it took
  // hold, the rule would no longer stand in the output — then the ban would only
  // be a request, and every porting agent could write itself an exception.
  const { output } = run("npx", [
    "eslint",
    "--no-ignore",
    "test/hardening/eslint-must-fail.ts",
  ]);
  assert(
    output.includes("@typescript-eslint/no-explicit-any"),
    `An eslint-disable comment switched the rule off — noInlineConfig is missing:
${output}`
  );
  assert(
    output.includes("noInlineConfig"),
    `ESLint no longer reports the ineffective disable comment:
${output}`
  );
};

exports["Registry and service share the same place of maintenance"] = () => {
  // The service reads connectors.json, the flow generator does too. As long as
  // both runtimes stand side by side, there must not be a second copy of it —
  // otherwise schedules and active connectors drift apart.
  const matches = fs
    .readdirSync(SERVICE, { recursive: true })
    .map(String)
    .filter((p) => p.endsWith("connectors.json") && !p.includes("node_modules"));
  assert.deepStrictEqual(
    matches,
    [],
    `Copy of the connector registry under platform/connectors/: ${matches.join(", ")} — platform/config/connectors.json applies`
  );
};
