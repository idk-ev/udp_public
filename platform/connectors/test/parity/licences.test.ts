/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Licence decisions carried by the connector service (docs/api.md, "Lizenzen
 * der Datenquellen"):
 *
 *  * GBFS systems whose terms do not allow storing the data are excluded by
 *    the registry (`excludeSystems`, pattern plus reason) and never requested;
 *  * the corrected credit labels the ports write into `dataProvider` replace
 *    exactly the old ones the parity harness swaps in the legacy bodies
 *    (test/harness/vm-runner.ts, CREDIT_CORRECTIONS) — a correction that
 *    matches nothing in the frozen flows would hide a real difference.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { exclusionOf, SYSTEMS_URL, withoutExcluded } from "../../src/connectors/gbfs.js";
import { run as runSharing } from "../../src/connectors/sharing-bw.js";
import { run as runCarsharing } from "../../src/connectors/carsharing-bw.js";
import { parseRegistry } from "../../src/kernel/registry.js";
import { legacyFlowsPath, repositoryRoot } from "../harness/fixtures.js";
import { jsonAnswer, mobilityCtx, registryEntry } from "../harness/mobility.js";
import { CREDIT_CORRECTIONS } from "../harness/vm-runner.js";

const RULES = [
  { pattern: "lime_*", reason: "Lizenz: Lime" },
  { pattern: "bird-*", reason: "Lizenz: Bird" },
];

function patternsMatchWholeIds(): void {
  assert.equal(exclusionOf("lime_bw", RULES)?.pattern, "lime_*");
  assert.equal(exclusionOf("lime_zurich", RULES)?.pattern, "lime_*");
  assert.equal(exclusionOf("bird-basel", RULES)?.pattern, "bird-*");
  // Anchored: no match inside another id, no match of a look-alike.
  for (const id of ["sublime_x", "lime", "limebike", "bird_basel", "zeus_tuttlingen", "bolt_stuttgart"]) {
    assert.equal(exclusionOf(id, RULES), null, id);
  }
  // Regex characters in a pattern are literal (the registry allows none, but the matcher must not care).
  assert.equal(exclusionOf("a.b", [{ pattern: "a.b", reason: "r" }])?.pattern, "a.b");
  assert.equal(exclusionOf("axb", [{ pattern: "a.b", reason: "r" }]), null);

  const systems = [
    { id: "lime_bw", url: "https://x/lime_bw/gbfs" },
    { id: "hopp_konstanz", url: "https://x/hopp_konstanz/gbfs" },
    { id: "bird-zurich", url: "https://x/bird-zurich/gbfs" },
  ];
  const split = withoutExcluded(systems, RULES);
  assert.deepEqual(
    split.kept.map((s) => s.id),
    ["hopp_konstanz"],
  );
  assert.deepEqual(
    split.excluded.map((s) => s.id),
    ["lime_bw", "bird-zurich"],
  );
  assert.equal(withoutExcluded(systems, []).kept, systems, "no rules, the list as it is");
}

function registryNarrowsExclusions(): void {
  const entry = (excludeSystems: unknown): unknown => ({
    connectors: [{ id: "x", name: "X", scope: "land", excludeSystems }],
  });
  assert.deepEqual(parseRegistry(entry(undefined))[0]?.excludeSystems, []);
  assert.deepEqual(parseRegistry(entry(RULES))[0]?.excludeSystems, RULES);
  for (const [bad, message] of [
    ["lime_*", /expected a list/],
    [[{ pattern: "lime_*" }], /reason/],
    [[{ pattern: "lime_*", reason: "  " }], /needs its reason/],
    [[{ pattern: "*", reason: "r" }], /not \* alone/],
    [[{ pattern: "lime_(.*)", reason: "r" }], /system id/],
    [["lime_*"], /expected an object/],
  ] as const) {
    assert.throws(() => parseRegistry(entry(bad)), message, JSON.stringify(bad));
  }
}

function bothGbfsConnectorsExcludeLimeAndBird(): void {
  for (const id of ["sharing-bw", "carsharing-bw"]) {
    const rules = registryEntry(id).excludeSystems;
    for (const system of ["lime_bw", "lime_basel", "bird-basel", "bird-zurich"]) {
      assert.ok(exclusionOf(system, rules) !== null, `${id} does not exclude ${system}`);
    }
    for (const system of ["zeus_tuttlingen", "stadtmobil_stuttgart", "bolt_stuttgart", "nextbike_ds"]) {
      assert.equal(exclusionOf(system, rules), null, `${id} excludes ${system}`);
    }
  }
}

const LIST = {
  systems: [
    { id: "lime_bw", url: "https://api.mobidata-bw.de/sharing/gbfs/v2/lime_bw/gbfs" },
    { id: "zeus_tuttlingen", url: "https://api.mobidata-bw.de/sharing/gbfs/v2/zeus_tuttlingen/gbfs" },
    { id: "bird-basel", url: "https://api.mobidata-bw.de/sharing/gbfs/v2/bird-basel/gbfs" },
  ],
};

function feedRequests(requests: readonly { readonly url: URL }[]): string[] {
  return requests
    .map((request) => request.url.href)
    .filter((href) => href.startsWith("https://api.mobidata-bw.de/sharing/gbfs/v2/"));
}

async function excludedSystemsAreNeverRequested(): Promise<void> {
  for (const [id, run] of [
    ["sharing-bw", runSharing],
    ["carsharing-bw", runCarsharing],
  ] as const) {
    const world = mobilityCtx({ id, start: Date.now() });
    world.broker.sources.set(SYSTEMS_URL, jsonAnswer(LIST));
    await run(world.ctx);
    const requested = feedRequests(world.broker.requests);
    assert.ok(requested.length > 0, `${id}: the kept system was not requested`);
    assert.ok(
      requested.every((href) => href.includes("/zeus_tuttlingen/")),
      `${id} requested an excluded system: ${requested.join(", ")}`,
    );
  }
}

function creditCorrectionsMatchTheFrozenFlowsAndThePorts(): void {
  const flows = readFileSync(legacyFlowsPath(), "utf8");
  const sources = join(repositoryRoot(), "platform", "connectors", "src", "connectors");
  const ported = readdirSync(sources)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => readFileSync(join(sources, file), "utf8"))
    .join("\n");
  for (const [old, corrected] of CREDIT_CORRECTIONS) {
    // The flows file is JSON: the single-quoted literal appears verbatim in a func string.
    assert.ok(flows.includes(old), `${old}: not in the frozen flows — a stale correction`);
    const label = corrected.slice(1, -1);
    assert.ok(ported.includes(`"${label}"`), `${label}: no port writes this label`);
    assert.ok(!ported.includes(`"${old.slice(1, -1)}"`), `${old}: still written by a port`);
  }
  // The wrong licence labels are gone from every port.
  for (const wrong of ["GeoNutzV", "naldo/bwegt", "PEGELONLINE (dl-de/by-2-0)"]) {
    assert.ok(!ported.includes(wrong), `a port still writes "${wrong}"`);
  }
}

export {
  patternsMatchWholeIds as "licences: exclusion patterns match whole system ids, * as the only wildcard",
  registryNarrowsExclusions as "licences: the registry narrows excludeSystems and refuses rules without a reason",
  bothGbfsConnectorsExcludeLimeAndBird as "licences: sharing-bw and carsharing-bw exclude Lime and Bird, nothing else",
  excludedSystemsAreNeverRequested as "licences: excluded GBFS systems are never requested by either connector",
  creditCorrectionsMatchTheFrozenFlowsAndThePorts as "licences: corrected credit labels replace exactly the old ones (harness and ports)",
};
