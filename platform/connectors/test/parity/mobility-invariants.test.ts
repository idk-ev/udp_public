/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The flow invariants of tests/static/flow-invarianten.test.js, asserted
 * against the PORTED sources of group E (mobility).
 *
 * The static test checks the generator and flows.json; once those are gone,
 * the same regressions must still be impossible to sneak into the TypeScript
 * modules. So the source text of the modules is read and checked, plus the
 * few behaviours that a regex cannot see (the URL the pager actually builds).
 * The ParkAPI incident of 24.08.2026 — offset pagination silently ignored, ids
 * from slugged free text — is the reason for every check in here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_PAGES, PAGE_SIZE, pageUrl, siteId } from "../../src/connectors/parken-bw.js";
import type { ParkRecord } from "../../src/connectors/parken-bw.js";
import { repositoryRoot } from "../harness/fixtures.js";
import { registryEntry } from "../harness/mobility.js";

const MODULES = ["parken-bw", "sharing-bw", "carsharing-bw", "ladesaeulen-bw", "gbfs"] as const;

function source(module: (typeof MODULES)[number]): string {
  return readFileSync(
    join(repositoryRoot(), "platform", "connectors", "src", "connectors", `${module}.ts`),
    "utf8",
  );
}

/**
 * Code only: block and line comments removed. The comments describe the
 * fixed error on purpose ("offset=<n*500>") and must not trip the checks.
 */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/**
 * Every entity id expression: from `urn:ngsi-ld:` inside a template literal
 * to the end of that literal.
 */
function idExpressions(text: string): string[] {
  const found: string[] = [];
  const pattern = /`urn:ngsi-ld:[^`]*`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) found.push(match[0]);
  return found;
}

function noIdFromSluggedText(): void {
  // Forbidden: a slug FUNCTION called inside an id (radSlug(bez) &c.).
  // Allowed: the official municipality slug of bw-gemeinden.json, which comes
  // in as a field (`g[8]`, `info.slug`, `slug`), and the GBFS system key.
  let checked = 0;
  for (const module of MODULES) {
    for (const expression of idExpressions(codeOnly(source(module)))) {
      checked += 1;
      assert.ok(
        !/[A-Za-z]*[Ss]lug\s*\(/.test(expression),
        `${module}: entity id built from slugged free text: ${expression}`,
      );
    }
  }
  assert.ok(checked >= 8, `only ${String(checked)} id expressions found — did the id construction move?`);
}

function parkApiIdsFromTheParkApiKey(): void {
  const code = codeOnly(source("parken-bw"));
  assert.match(
    code,
    /`urn:ngsi-ld:\$\{type\}:parkapi-\$\{String\(record\[0\]\)\}`/,
    "site ids not from the ParkAPI id",
  );
  // The AGS does not belong in a site id: derived, a relocation would orphan
  // the entity and its time series. Only the ParkingSummary carries it.
  for (const expression of idExpressions(code)) {
    assert.ok(
      !/ags/i.test(expression) || expression.includes("ParkingSummary"),
      `site id with AGS: ${expression}`,
    );
  }
  // No other module writes parking site ids.
  for (const module of MODULES) {
    if (module === "parken-bw") continue;
    for (const expression of idExpressions(codeOnly(source(module)))) {
      assert.ok(!/ParkingSite|BikeParking/.test(expression), `${module} writes parking ids: ${expression}`);
    }
  }
  const record: ParkRecord = [384, 48.7, 9.3, 10, "CAR", "Parkhaus", "081160019019", 7, "8", "", false, -1];
  assert.equal(siteId("ParkingSite", record), "urn:ngsi-ld:ParkingSite:parkapi-384");
  assert.equal(siteId("BikeParking", record), "urn:ngsi-ld:BikeParking:parkapi-384");
}

function parkApiPaginatesByCursor(): void {
  const code = codeOnly(source("parken-bw"));
  assert.ok(code.includes("park-api"), "parken-bw no longer talks to the ParkAPI?");
  assert.ok(!code.includes("offset="), "ParkAPI request with offset= again — the v3 API ignores it");
  assert.ok(code.includes("start="), "ParkAPI request without the cursor parameter start=");
  // What the pager actually requests.
  assert.equal(
    pageUrl(null),
    `https://api.mobidata-bw.de/park-api/api/public/v3/parking-sites?limit=${String(PAGE_SIZE)}`,
  );
  assert.equal(
    pageUrl(1436),
    `https://api.mobidata-bw.de/park-api/api/public/v3/parking-sites?limit=500&start=1436`,
  );
  // No other module talks to the ParkAPI.
  for (const module of MODULES) {
    if (module !== "parken-bw")
      assert.ok(!source(module).includes("park-api"), `${module} talks to the ParkAPI`);
  }
}

function parkApiChecksOverlapAndCapsTheLoop(): void {
  const code = codeOnly(source("parken-bw"));
  assert.match(code, /this\.#seen\.has\(/, "no overlap check across pages");
  assert.match(code, /overlaps the previous pages/, "overlap does not abort");
  assert.match(code, /cursor stalled/, "a stalled cursor does not abort");
  assert.match(code, /while \(pager\.pages < MAX_PAGES\)/, "page loop without cap");
  assert.match(code, /page cap \$\{String\(MAX_PAGES\)\} reached/, "reaching the cap is silent");
  assert.match(code, /log\.error\(/, "aborts are not logged as errors");
  assert.equal(MAX_PAGES, 120, "page cap changed from the old node's MAX_SEITEN");
}

function gateModes(): void {
  // Whole-stock connectors replace, per-system ones merge.
  const parken = codeOnly(source("parken-bw"));
  assert.match(
    parken,
    /check\(SUMMARY_GATE, built\.summaries, summarySignature, \{ replace: true \}\)/,
    "parken-bw sums not in replace mode",
  );
  assert.match(parken, /gate\.retain\(STATIC_TABLE, /, "parkStatik not reduced to the current stock");
  assert.match(parken, /gate\.retain\(OCCUPANCY_TABLE, /, "parkFrei not reduced to the current stock");
  const carsharing = codeOnly(source("carsharing-bw"));
  assert.match(
    carsharing,
    /check\(GATE_KEY, built\.stations, stationSignature, \{ freshEvery: 3, periodMs: HOUR_MS \}\)/,
    "carsharing status no longer merges (runs per system, must not replace)",
  );
  const charging = codeOnly(source("ladesaeulen-bw"));
  assert.equal(
    (charging.match(/replace: built\.complete/g) ?? []).length,
    2,
    "OCPDB tables not replace: complete",
  );
  // No module writes a table value outside a plan.
  for (const module of MODULES) {
    assert.ok(!codeOnly(source(module)).includes(".commit("), `${module} commits signatures itself`);
  }
}

function prunesCarryTheirGuards(): void {
  let calls = 0;
  for (const module of MODULES) {
    const code = codeOnly(source(module));
    for (const call of code
      .split("prune.stale({")
      .slice(1)
      .map((rest) => rest.slice(0, rest.indexOf("});")))) {
      calls += 1;
      const pattern = /pattern: "([^"]+)"/.exec(call)?.[1];
      assert.ok(pattern !== undefined, `${module}: prune call without literal pattern`);
      assert.ok(
        pattern.startsWith("^urn:ngsi-ld:") && pattern.endsWith("$"),
        `${module}: pattern not anchored: ${pattern}`,
      );
      assert.ok(!pattern.includes(".*"), `${module}: pattern too broad: ${pattern}`);
      assert.ok(
        call.includes("keep:") || call.includes("liveMs:"),
        `${module}: prune without keep or liveMs`,
      );
      assert.ok(
        call.includes("graceMs:") ||
          (call.includes("confirmKey:") && call.includes("confirmMs: 24 * HOUR_MS")),
        `${module}: prune without grace period or 24 h confirmation`,
      );
      assert.ok(call.includes("intervalMs:"), `${module}: prune without interval`);
    }
  }
  // parken: 3 regular; sharing: 1; carsharing: 2; ladesaeulen: 2 (+ parken's legacy helper, built separately).
  assert.equal(calls, 8, `prune calls: ${String(calls)}`);
  const parken = codeOnly(source("parken-bw"));
  assert.match(
    parken,
    /inventory\.complete && plan\.ids\.size > 0 && \(await ctx\.prune\.masterDataPlausible\(\)\)/,
  );
  assert.match(
    parken,
    /for \(const key of CONFIRM_KEYS\) ctx\.prune\.resetConfirmations\(key\)/,
    "incomplete run keeps its candidates",
  );
  const legacy =
    /const legacy = \(type: SiteType\): PruneOptions => \(\{[\s\S]*?\}\);/.exec(parken)?.[0] ?? "";
  for (const needle of [
    "exclude: `^urn:ngsi-ld:${type}:parkapi-`",
    "accept",
    'attrs: ["ags", "dataProvider"]',
    "graceMs: 7 * 24 * HOUR_MS",
    "maxFraction: 1",
    "intervalMs: DAY_MS",
  ]) {
    assert.ok(legacy.includes(needle), `legacy prune without ${needle}`);
  }
  assert.match(
    parken,
    /Date\.parse\(createdAt\) < LEGACY_MIGRATION_MS/,
    "legacy prune without createdAt check",
  );
  const carsharing = codeOnly(source("carsharing-bw"));
  assert.equal(
    (carsharing.match(/accept: ownGbfs/g) ?? []).length,
    2,
    "carsharing prune without ownership check",
  );
}

function rowBudgetsCoverWhatIsWritten(): void {
  // The standing fuse from the incident: troe-stats warns when a type exceeds
  // the summed budgets. Every type the budgeted connectors write has one.
  const expected: Readonly<Record<string, readonly string[]>> = {
    "parken-bw": ["ParkingSite", "BikeParking", "ParkingSummary"],
    "carsharing-bw": ["CarSharingStation"],
    "ladesaeulen-bw": ["EVChargingStation", "ChargingSummary"],
  };
  for (const [id, types] of Object.entries(expected)) {
    const budget = registryEntry(id).rowBudget24h;
    assert.ok(budget !== null, `${id}: no rowBudget24h`);
    for (const type of types) assert.ok((budget[type] ?? 0) > 0, `${id}: no row budget for ${type}`);
  }
}

export {
  noIdFromSluggedText as "mobility invariants: no entity id from slugged free text in any ported module",
  parkApiIdsFromTheParkApiKey as "mobility invariants: parking site ids from the ParkAPI key, without the AGS",
  parkApiPaginatesByCursor as "mobility invariants: ParkAPI paginates by cursor start=, never offset=",
  parkApiChecksOverlapAndCapsTheLoop as "mobility invariants: ParkAPI checks page overlap, stalled cursors and caps the loop",
  gateModes as "mobility invariants: gate replace for whole-stock runs, merge per system, commit only via the plan",
  prunesCarryTheirGuards as "mobility invariants: every prune is anchored, bounded and guarded; legacy prune intact",
  rowBudgetsCoverWhatIsWritten as "mobility invariants: the registry row budgets cover every type written",
};
