/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* The cutover mechanism of the connector migration (docs/migration-konnektoren.md,
   phase 4): a registry entry with "runtime": "app" runs in the connector
   service, and scripts/generate-nodered-flows.py drops it from flows.json — a
   connector must never run in Node-RED and the service at the same time.

   The generator runs on a COPY (registry, flows.json, status export in a temp
   directory); the checkout stays untouched. Its baseline is a registry copy
   with EVERY connector reset to "nodered" — the full node set — so the test
   means the same at every stage of the cutover, whatever the live registry has
   switched over already. Needs Python 3: without one the generator tests skip
   locally, in CI (CI set) they fail instead of passing silently.

   The checked-in flows.json is held to the cutover invariant as well: no node
   of a connector on "app", every node of each connector on "nodered". */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const GENERATOR = path.join(ROOT, "scripts", "generate-nodered-flows.py");
const REGISTRY = path.join(ROOT, "platform", "config", "connectors.json");
const FLOWS = path.join(ROOT, "platform", "config", "nodered", "flows.json");

/* The first cutover group (geo context) plus the /abfahrten endpoint, so the
   run also proves that an HTTP route leaves the flows with its connector. */
const SWITCHED = ["stammdaten-bw", "grenzen-bw", "wetter-bw", "abfahrten-on-demand"];

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

function runGenerator(python, registry, flows, statusExport) {
  const [command, ...args] = python;
  const r = spawnSync(
    command,
    [...args, GENERATOR, "--registry", registry, "--flows", flows, "--status-export", statusExport],
    { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
  );
  return { code: r.status, output: `${r.stdout || ""}${r.stderr || ""}` };
}

const prefixed = (flows, prefixes) =>
  flows.filter(n => prefixes.some(p => String(n.id || "").startsWith(p)));

const runtimeOf = c => c.runtime ?? "nodered";

/* The live registry with every connector back on Node-RED. */
function allOnNodeRed() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  for (const c of registry.connectors) c.runtime = "nodered";
  return registry;
}

/* Runs the generator on copies in `dir` (the registry object as
   connectors.json, the flow file `flowsFrom` as flows.json) and returns the
   generated flows and status export. */
function generate(python, dir, registry, flowsFrom) {
  const regCopy = path.join(dir, "connectors.json");
  const flowsCopy = path.join(dir, "flows.json");
  const statusCopy = path.join(dir, "connectors-status.json");
  fs.writeFileSync(regCopy, JSON.stringify(registry, null, 2));
  if (path.resolve(flowsFrom) !== path.resolve(flowsCopy)) fs.copyFileSync(flowsFrom, flowsCopy);
  const { code, output } = runGenerator(python, regCopy, flowsCopy, statusCopy);
  assert.strictEqual(code, 0, `generator failed:\n${output}`);
  return {
    flowsFile: flowsCopy,
    flows: JSON.parse(fs.readFileSync(flowsCopy, "utf8")),
    status: JSON.parse(fs.readFileSync(statusCopy, "utf8")).connectors,
  };
}

exports['runtime "app" drops exactly that connector from flows.json'] = () => {
  const python = findPython();
  if (python === null) {
    assert(!process.env.CI, "no Python 3 found (python3, python, py -3) — CI must have one");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udp-runtime-"));
  try {
    // Baseline: every connector on Node-RED — the full node set, independent
    // of what the live registry has switched over already.
    const baseline = generate(python, dir, allOnNodeRed(), FLOWS);
    for (const c of baseline.status) assert.strictEqual(c.runtime, "nodered", `${c.id}: runtime in baseline export`);

    const registry = allOnNodeRed();
    for (const id of SWITCHED) {
      const entry = registry.connectors.find(c => c.id === id);
      assert(entry, `test fixture: ${id} is no longer in the registry`);
      entry.runtime = "app";
    }
    const switched = generate(python, dir, registry, baseline.flowsFile);

    const before = baseline.flows;
    const after = switched.flows;
    const byId = new Map(registry.connectors.map(c => [c.id, c]));

    // 1. Not a single node of a switched connector is left.
    for (const id of SWITCHED) {
      const left = prefixed(after, byId.get(id).nodePrefixes).map(n => n.id);
      assert.deepStrictEqual(left, [], `${id}: nodes left in flows.json`);
    }

    // 2. Every other active connector keeps exactly its nodes.
    for (const c of registry.connectors.filter(c => c.active !== false && !SWITCHED.includes(c.id))) {
      const ids = nodes => prefixed(nodes, c.nodePrefixes).map(n => n.id).sort();
      const kept = ids(after);
      assert(kept.length > 0, `${c.id}: no nodes left`);
      assert.deepStrictEqual(kept, ids(before), `${c.id}: nodes changed`);
    }

    // 3. Nothing else changed: the new file is the old one minus the dropped nodes.
    const dropped = new Set(SWITCHED.flatMap(id => prefixed(before, byId.get(id).nodePrefixes).map(n => n.id)));
    assert(dropped.size > 0, "test fixture: the switched connectors had no nodes in the baseline");
    assert.deepStrictEqual(
      after.map(n => n.id),
      before.map(n => n.id).filter(id => !dropped.has(id)),
      "flows.json differs beyond the dropped connectors",
    );

    // 4. No remaining node is wired to a dropped one.
    const present = new Set(after.map(n => n.id));
    for (const n of after)
      for (const target of (n.wires || []).flat())
        assert(present.has(target), `${n.id} is wired to missing node ${target}`);

    // 5. The HTTP endpoint went with its connector; the other one stayed.
    const urls = after.filter(n => n.type === "http in").map(n => n.url);
    assert.deepStrictEqual(urls, ["/warnungen.ics"]);

    // 6. The status export carries the runtime of every connector.
    for (const c of switched.status)
      assert.strictEqual(c.runtime, SWITCHED.includes(c.id) ? "app" : "nodered", `${c.id}: runtime in export`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

exports["checked-in flows.json: no node of an app connector, every node of a Node-RED one"] = () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8")).connectors;
  const live = JSON.parse(fs.readFileSync(FLOWS, "utf8"));
  const onNodeRed = registry.filter(c => c.active !== false && runtimeOf(c) === "nodered");

  // The cutover invariant itself: a connector never runs in Node-RED and the
  // service at the same time. Holds without Python, too.
  for (const c of registry.filter(c => runtimeOf(c) === "app")) {
    const left = prefixed(live, c.nodePrefixes).map(n => n.id);
    assert.deepStrictEqual(left, [], `${c.id} runs in the connector service but still has nodes in flows.json — run the generator`);
  }
  for (const c of onNodeRed)
    assert(prefixed(live, c.nodePrefixes).length > 0, `${c.id} runs in Node-RED but has no nodes in flows.json`);

  // Not just "some" nodes: each Node-RED connector keeps exactly the node set
  // the generator produces for it with nothing switched over.
  const python = findPython();
  if (python === null) {
    assert(!process.env.CI, "no Python 3 found (python3, python, py -3) — CI must have one");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udp-runtime-"));
  try {
    const full = generate(python, dir, allOnNodeRed(), FLOWS).flows;
    for (const c of onNodeRed) {
      const ids = nodes => prefixed(nodes, c.nodePrefixes).map(n => n.id).sort();
      assert.deepStrictEqual(ids(live), ids(full), `${c.id}: its nodes in flows.json differ from its full node set`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

exports["an unknown runtime value stops the generator"] = () => {
  const python = findPython();
  if (python === null) {
    assert(!process.env.CI, "no Python 3 found (python3, python, py -3) — CI must have one");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udp-runtime-"));
  try {
    const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
    registry.connectors[0].runtime = "service";
    const regCopy = path.join(dir, "connectors.json");
    const flowsCopy = path.join(dir, "flows.json");
    fs.writeFileSync(regCopy, JSON.stringify(registry, null, 2));
    fs.copyFileSync(FLOWS, flowsCopy);
    const { code, output } = runGenerator(python, regCopy, flowsCopy, path.join(dir, "status.json"));
    assert.notStrictEqual(code, 0, "generator accepted runtime \"service\"");
    assert(/runtime must be one of/.test(output), `unexpected message:\n${output}`);
    assert.strictEqual(fs.readFileSync(flowsCopy, "utf8"), fs.readFileSync(FLOWS, "utf8"), "flows.json was written");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

exports["overlapping or empty nodePrefixes stop the generator"] = () => {
  const python = findPython();
  if (python === null) {
    assert(!process.env.CI, "no Python 3 found (python3, python, py -3) — CI must have one");
    return;
  }
  const base = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  const cases = {
    // A prefix of another connector's prefix: first-come matching would hand
    // that connector's nodes to whichever entry comes first.
    overlap: reg => reg.connectors[1].nodePrefixes.push(reg.connectors[0].nodePrefixes[0].slice(0, -1)),
    // An empty prefix matches every node.
    empty: reg => reg.connectors[0].nodePrefixes.push(""),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udp-runtime-"));
    try {
      const registry = structuredClone(base);
      mutate(registry);
      const regCopy = path.join(dir, "connectors.json");
      const flowsCopy = path.join(dir, "flows.json");
      const statusCopy = path.join(dir, "status.json");
      fs.writeFileSync(regCopy, JSON.stringify(registry, null, 2));
      fs.copyFileSync(FLOWS, flowsCopy);
      const { code, output } = runGenerator(python, regCopy, flowsCopy, statusCopy);
      assert.notStrictEqual(code, 0, `${name}: generator accepted the registry`);
      assert(/nodePrefixes/.test(output), `${name}: unexpected message:\n${output}`);
      assert.strictEqual(fs.readFileSync(flowsCopy, "utf8"), fs.readFileSync(FLOWS, "utf8"), `${name}: flows.json was written`);
      assert(!fs.existsSync(statusCopy), `${name}: status export was written`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
};

exports["checked-in status export matches the registry runtime"] = () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8")).connectors;
  const status = JSON.parse(fs.readFileSync(path.join(ROOT, "gui", "public", "connectors-status.json"), "utf8"))
    .connectors;
  for (const c of registry) {
    const exported = status.find(s => s.id === c.id);
    assert(exported, `${c.id}: missing in connectors-status.json`);
    assert.strictEqual(exported.runtime, c.runtime ?? "nodered", `${c.id}: runtime not exported — run the generator`);
  }
};
