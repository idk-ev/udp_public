/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Registry and modules agree: every active entry of
 * platform/config/connectors.json has a module in src/connectors/index.ts, and
 * every module has an entry. An active entry without a module would run
 * nowhere (the service only logs a warning), a module without an entry never
 * runs — both leave dashboard tiles and the health check quietly stale.
 */

import assert from "node:assert/strict";
import { join } from "node:path";

import { CONNECTORS } from "../../src/connectors/index.js";
import { createRegistry, loadRegistry, parseRegistry } from "../../src/kernel/registry.js";
import { repositoryRoot } from "../harness/fixtures.js";

function liveRegistry(): ReturnType<typeof loadRegistry> {
  return loadRegistry(join(repositoryRoot(), "platform", "config", "connectors.json"));
}

function everyActiveEntryHasAModule(): void {
  const missing = liveRegistry()
    .activeEntries()
    .map((entry) => entry.id)
    .filter((id) => !CONNECTORS.has(id));
  assert.deepEqual(missing, [], `active registry entries without a module: ${missing.join(", ")}`);
}

function everyModuleHasAnEntry(): void {
  const registry = liveRegistry();
  const orphans = [...CONNECTORS.keys()].filter((id) => registry.byId(id) === undefined);
  assert.deepEqual(orphans, [], `modules without a registry entry: ${orphans.join(", ")}`);
}

function activeEntriesAreWhatRuns(): void {
  const registry = createRegistry(
    parseRegistry({
      connectors: [
        { id: "on", name: "On", scope: "land", intervalSeconds: 60 },
        { id: "off", name: "Off", scope: "land", intervalSeconds: 60, active: false },
        // Fields of the Node-RED era: ignored, not rejected, and they no
        // longer decide where a connector runs.
        {
          id: "legacy",
          name: "Legacy",
          scope: "land",
          intervalSeconds: 60,
          runtime: "nodered",
          nodePrefixes: ["x-"],
        },
      ],
    }),
  );
  assert.deepEqual(
    registry.activeEntries().map((entry) => entry.id),
    ["on", "legacy"],
  );
}

export {
  everyActiveEntryHasAModule as "registry: every active entry has a module",
  everyModuleHasAnEntry as "registry: every module has a registry entry",
  activeEntriesAreWhatRuns as "registry: active entries are what runs, runtime/nodePrefixes are ignored",
};
