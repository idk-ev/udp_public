/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* The status export gui/public/connectors-status.json: what the main
   dashboard, the city pages and scripts/healthcheck.sh read about the
   connectors. It is written by scripts/export-connector-status.py from the
   registry (platform/config/connectors.json) and checked in.

   The field set is a contract with those readers; the checked-in file must
   match the registry, and the script must reproduce it byte for byte (up to
   the "stand" timestamp, which is the registry's mtime). Needs Python 3 for
   the last part: without one it skips locally, in CI (CI set) it fails
   instead of passing silently. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "export-connector-status.py");
const REGISTRY = path.join(ROOT, "platform", "config", "connectors.json");
const STATUS = path.join(ROOT, "gui", "public", "connectors-status.json");

/* Read by gui/public/dashboard.html, stadt.html and scripts/healthcheck.sh. */
const FIELDS = ["id", "name", "scope", "enabledFor", "sollMinutes", "sampleEntity", "provides",
  "attribution", "requiresSecret", "active", "supersededBy", "pending", "refireOnRestart", "healthUrl"];

/* python3 on Linux/CI, the py launcher on Windows (python/python3 there are
   often store aliases that start nothing). PYTHON overrides, e.g. "py -3". */
function findPython() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push(process.env.PYTHON.split(" ").filter(Boolean));
  candidates.push(["python3"], ["python"], ["py", "-3"]);
  for (const [command, ...args] of candidates) {
    const r = spawnSync(command, [...args, "--version"], { encoding: "utf8" });
    if (r.status === 0 && /Python 3\./.test(`${r.stdout}${r.stderr}`)) return [command, ...args];
  }
  return null;
}

const withoutStand = text => text.replace(/\r\n/g, "\n").replace(/^ "stand": "[^"]*",\n/m, "");

exports["status export: field set and values match the registry"] = () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8")).connectors;
  const status = JSON.parse(fs.readFileSync(STATUS, "utf8"));
  assert(typeof status.stand === "string" && !Number.isNaN(Date.parse(status.stand)), "stand is not a timestamp");
  assert.deepStrictEqual(status.connectors.map(c => c.id), registry.map(c => c.id), "connector ids differ");
  for (const [i, c] of registry.entries()) {
    const exported = status.connectors[i];
    assert.deepStrictEqual(Object.keys(exported), FIELDS, `${c.id}: exported fields changed`);
    for (const k of FIELDS)
      assert.deepStrictEqual(exported[k], c[k] ?? null, `${c.id}.${k} not exported as in the registry — run scripts/export-connector-status.py`);
  }
};

exports["status export: the script reproduces the checked-in file"] = () => {
  const python = findPython();
  if (python === null) {
    assert(!process.env.CI, "no Python 3 found (python3, python, py -3) — CI must have one");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udp-status-"));
  try {
    const out = path.join(dir, "connectors-status.json");
    const [command, ...args] = python;
    const r = spawnSync(command, [...args, SCRIPT, "--registry", REGISTRY, "--status-export", out],
      { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    assert.strictEqual(r.status, 0, `export failed:\n${r.stdout || ""}${r.stderr || ""}`);
    assert.strictEqual(withoutStand(fs.readFileSync(out, "utf8")), withoutStand(fs.readFileSync(STATUS, "utf8")),
      "connectors-status.json is stale — run scripts/export-connector-status.py and commit");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
