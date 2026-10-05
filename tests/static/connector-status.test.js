/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* The status exports of the connectors, written by
   scripts/export-connector-status.py from the registry
   (platform/config/connectors.json) and checked in:
     gui/ops/connectors-status.json     complete – the main dashboard (served
                                        as /ops/connectors-status.json behind
                                        its login) and scripts/healthcheck.sh
     gui/public/connectors-status.json  public – the city pages; no
                                        operations connectors, no secret
                                        names, health URLs or schedules

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
const STATUS = path.join(ROOT, "gui", "ops", "connectors-status.json");
const PUBLIC = path.join(ROOT, "gui", "public", "connectors-status.json");

/* Read by gui/public/dashboard.html and scripts/healthcheck.sh. */
const FIELDS = ["id", "name", "scope", "enabledFor", "sollMinutes", "sampleEntity", "provides",
  "attribution", "attributionLinks", "license", "licenseUrl", "requiresSecret", "active", "supersededBy",
  "pending", "refireOnRestart", "healthUrl"];
/* Read by gui/public/stadt.html, plus the licence of every source – nothing
   more is published. */
const PUBLIC_FIELDS = ["id", "name", "enabledFor", "provides", "attribution", "attributionLinks",
  "license", "licenseUrl", "active", "sampleEntity"];

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

exports["public status export: only the fields of the city pages, no operations connectors"] = () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8")).connectors;
  const status = JSON.parse(fs.readFileSync(PUBLIC, "utf8"));
  const expected = registry.filter(c => c.scope !== "betrieb");
  assert(expected.length < registry.length, "fixture: the registry has operations connectors");
  assert.deepStrictEqual(status.connectors.map(c => c.id), expected.map(c => c.id), "public connector ids differ");
  for (const [i, c] of expected.entries()) {
    const exported = status.connectors[i];
    assert.deepStrictEqual(Object.keys(exported), PUBLIC_FIELDS, `${c.id}: public fields changed`);
    for (const k of PUBLIC_FIELDS) assert.deepStrictEqual(exported[k], c[k] ?? null, `${c.id}.${k}`);
  }
  const text = fs.readFileSync(PUBLIC, "utf8");
  for (const secret of registry.map(c => c.requiresSecret).filter(Boolean))
    assert(!text.includes(secret), `secret name ${secret} in the public status export`);
  assert(!/healthUrl|requiresSecret|PlatformStatus/.test(text), "operations details in the public status export");
  // The city page reads no connector field that is no longer published.
  const stadt = fs.readFileSync(path.join(ROOT, "gui", "public", "stadt.html"), "utf8");
  for (const k of FIELDS.filter(f => !PUBLIC_FIELDS.includes(f)))
    assert(!new RegExp(`C?\\.${k}\\b`).test(stadt), `stadt.html reads ${k}, which is no longer public`);
};

exports["status export: the script reproduces the checked-in files"] = () => {
  const python = findPython();
  if (python === null) {
    assert(!process.env.CI, "no Python 3 found (python3, python, py -3) — CI must have one");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udp-status-"));
  try {
    const out = path.join(dir, "connectors-status.json");
    const ops = path.join(dir, "ops", "connectors-status.json");
    const [command, ...args] = python;
    const r = spawnSync(command, [...args, SCRIPT, "--registry", REGISTRY, "--status-export", out, "--ops-export", ops],
      { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    assert.strictEqual(r.status, 0, `export failed:\n${r.stdout || ""}${r.stderr || ""}`);
    assert.strictEqual(withoutStand(fs.readFileSync(out, "utf8")), withoutStand(fs.readFileSync(PUBLIC, "utf8")),
      "gui/public/connectors-status.json is stale — run scripts/export-connector-status.py and commit");
    assert.strictEqual(withoutStand(fs.readFileSync(ops, "utf8")), withoutStand(fs.readFileSync(STATUS, "utf8")),
      "gui/ops/connectors-status.json is stale — run scripts/export-connector-status.py and commit");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/* Licences (docs/api.md, "Lizenzen der Datenquellen"): every active source
   of the public pages names its licence with a link; every link of a credit
   text points at a part of that text. */
exports["registry: every active public source has a credit, a licence and https links"] = () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8")).connectors;
  const https = u => typeof u === "string" && /^https:\/\/[^\s"'<>]+$/.test(u);
  for (const c of registry) {
    if (c.scope === "betrieb") {
      assert.strictEqual(c.attribution ?? null, null, `${c.id}: an operations connector credits no source`);
      continue;
    }
    if (c.active === false || c.attribution === null) continue; // switched off, or derived data (puls-bw)
    assert(typeof c.license === "string" && c.license.trim(), `${c.id}: license missing`);
    assert(https(c.licenseUrl), `${c.id}: licenseUrl missing or not https`);
    assert(c.attribution.split(" · ").every(p => p.trim()), `${c.id}: empty part in the credit text`);
    for (const [text, url] of Object.entries(c.attributionLinks || {})) {
      assert(c.attribution.includes(text), `${c.id}: attributionLinks "${text}" is not part of the credit text`);
      assert(https(url), `${c.id}: attributionLinks "${text}" is not an https link`);
    }
  }
};

/* Licence decisions (docs/api.md): sources whose terms do not allow
   republishing stay switched off; excluded GBFS systems carry their reason,
   and both GBFS connectors exclude the same systems. */
exports["registry: licence decisions — HVZ and hystreet off, Lime and Bird excluded in both GBFS connectors"] = () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8")).connectors;
  const byId = Object.fromEntries(registry.map(c => [c.id, c]));
  assert.strictEqual(byId["pegel-lubw"].active, false, "pegel-lubw must stay off (HVZ: no republication)");
  assert.strictEqual(byId["hystreet"].active, false, "hystreet must stay off until written consent");
  const rules = byId["sharing-bw"].excludeSystems;
  assert.deepStrictEqual(byId["carsharing-bw"].excludeSystems, rules, "the GBFS connectors exclude different systems");
  assert.deepStrictEqual(rules.map(r => r.pattern), ["lime_*", "bird-*"]);
  for (const r of rules) assert(/Lizenz/.test(r.reason), `exclusion ${r.pattern} without its licence reason`);
};
