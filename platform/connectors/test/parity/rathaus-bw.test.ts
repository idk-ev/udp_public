/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: rathaus-bw — FN_RATHAUS_REQ (`udp-rt-rh-req`) and FN_RATHAUS_BUILD
 * (`udp-rt-rh-build`) against the ported module.
 *
 * Compared: the request URL and User-Agent byte for byte; the entities of the
 * build node's chunk messages against `build()` on the same fixture and the
 * same boundaries, and against what `run()` actually upserts through the real
 * kernel; the chunking; the guards (HTTP error, no `elements`, no boundaries).
 * The "best town hall per municipality" rule with its tie-break is exercised
 * by the real data (see the fixture's note) and additionally on a reordered
 * copy, where a tie must flip the winner on both sides.
 *
 * Fixture: test/fixtures/rathaus-bw.json — one real Overpass answer for the
 * district of Loerrach and its neighbours across the border, against the
 * boundary fixture test/fixtures/grenzen-bw.json.
 */

import assert from "node:assert/strict";
import { build, parse, QUERY, REQUEST_URL, run, score } from "../../src/connectors/rathaus-bw.js";
import {
  OVERPASS_MAX_BYTES,
  OVERPASS_MAX_CONCURRENT,
  OVERPASS_MIN_INTERVAL_MS,
  OVERPASS_TIMEOUT_MS,
  OVERPASS_USER_AGENT,
} from "../../src/connectors/overpass.js";
import { chunk } from "../../src/kernel/orion.js";
import { messageFromFixture, readFixture } from "../harness/fixtures.js";
import { httpResponse } from "../harness/kernel.js";
import { assertEntitiesEqual, isRecord, normalize } from "../harness/normalize.js";
import {
  boundaryFixture,
  emittedChunkSizes,
  emittedEntities,
  fixtureGeo,
  overpassAnswer,
  overpassRig,
} from "../harness/overpass-rig.js";
import { runFunctionNode } from "../harness/vm-runner.js";
import type { FunctionNodeRun } from "../harness/vm-runner.js";

const REQUEST_NODE = "udp-rt-rh-req";
const BUILD_NODE = "udp-rt-rh-build";
const FIXTURE = "rathaus-bw";
const CHUNK_SIZE = 100;

async function runLegacy(
  payload: unknown,
  statusCode = 200,
  withBoundaries = true,
): Promise<FunctionNodeRun> {
  const fixture = readFixture(FIXTURE);
  const msg = { ...messageFromFixture(fixture), statusCode, payload: structuredClone(payload) };
  return runFunctionNode(BUILD_NODE, {
    msg,
    global: withBoundaries ? { bwGrenzen: boundaryFixture().raw } : {},
  });
}

function elementsOf(payload: unknown): unknown[] {
  const elements = isRecord(payload) ? payload.elements : undefined;
  assert.ok(Array.isArray(elements), "fixture payload has elements");
  return elements;
}

async function requestIsIdentical(): Promise<void> {
  const run = await runFunctionNode(REQUEST_NODE, { msg: { _msgid: "parity", payload: 0 } });
  const returned = run.returned;
  assert.ok(isRecord(returned));
  assert.equal(returned.url, REQUEST_URL, "Overpass URL differs");
  assert.deepEqual(normalize(returned.headers), { "User-Agent": OVERPASS_USER_AGENT });
  // The connector's own query with the state's box, as recorded with a smaller one.
  assert.ok(REQUEST_URL.endsWith(encodeURIComponent(QUERY)));
}

async function fixtureEntitiesAreIdentical(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const legacy = await runLegacy(fixture.payload);
  const entities = build(parse(fixture.payload), fixtureGeo(), new Date().toISOString());

  assert.deepEqual(legacy.warnings, []);
  assert.equal(entities.length, 31, "31 fixture municipalities have a town hall");
  assertEntitiesEqual(emittedEntities(legacy), entities);
  assert.deepEqual(
    emittedChunkSizes(legacy),
    [...chunk(entities, CHUNK_SIZE)].map((part) => part.length),
  );
  const withHours = entities.filter((entity) => entity.openingHours !== undefined).length;
  assert.deepEqual(normalize(legacy.status), [
    { text: `31 Rathäuser (${String(withHours)} mit Öffnungszeiten)` },
  ]);

  // The branches the fixture has to keep covering, or this test proves less than it says.
  const parsed = parse(fixture.payload);
  assert.equal(parsed.skipped, 0);
  assert.ok(
    entities.some((entity) => entity.name.value === "Rathaus"),
    "an unnamed winner falls back to 'Rathaus'",
  );
  assert.ok(entities.some((entity) => entity.url !== undefined));
  assert.ok(entities.some((entity) => entity.telephone !== undefined));
  assert.ok(
    parsed.elements.some((element) => element.lat !== null && element.tags.get("name") === undefined),
  );
}

/**
 * The tie-break: in the fixture, Schopfheim (08336081) has two candidates of
 * score 3 and Feldberg (08315074) two of score 2 — the first in Overpass order
 * wins. Reversing the element order must flip both winners, on both sides.
 */
async function tieBreakKeepsTheFirstOnBothSides(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const reversed = { ...(isRecord(fixture.payload) ? fixture.payload : {}) };
  reversed.elements = [...elementsOf(fixture.payload)].reverse();
  const geo = fixtureGeo();
  const now = new Date().toISOString();

  const forward = build(parse(fixture.payload), geo, now);
  const backward = build(parse(reversed), geo, now);
  assertEntitiesEqual(emittedEntities(await runLegacy(reversed)), backward);

  const nameOf = (entities: typeof forward, ags: string): string | undefined =>
    entities.find((entity) => entity.ags.value === ags)?.name.value;
  for (const ags of ["08336081", "08315074"]) {
    assert.notEqual(nameOf(forward, ags), nameOf(backward, ags), `tie in ${ags} did not flip`);
  }
  // And the scores really are tied there.
  const tied = parse(fixture.payload).elements.filter((element) => {
    const { lat, lon } = element;
    return lat !== null && lon !== null && geo.agsAt(lat, lon) === "08336081" && score(element.tags) === 3;
  });
  assert.equal(tied.length, 2);
}

async function modifiedTagsAreIdentical(): Promise<void> {
  // Apostrophes, empty tags, contact:* fallbacks and a name the score regex
  // matches only case-insensitively (the non-ASCII Ü) — a modified copy of the
  // input, not fixture data.
  const fixture = readFixture(FIXTURE);
  const payload = structuredClone(fixture.payload);
  const elements = elementsOf(payload);
  const edits: Record<string, string>[] = [
    { name: "BÜRGERBÜRO Rheinfelden", opening_hours: "" },
    { name: "Rathaus d'Hüsingen", "contact:phone": "+49 7621 1'2", website: "" },
    { name: "", "contact:website": "https://example.org/'x'", opening_hours: "Mo 08:00-12:00" },
  ];
  // Onto the town halls that are the only candidate in their municipality, so
  // the edits reach an entity whatever they do to the score.
  const geo = fixtureGeo();
  const byAgs = new Map<string, number[]>();
  parse(payload).elements.forEach(({ lat, lon }, index) => {
    const ags = lat === null || lon === null ? null : geo.agsAt(lat, lon);
    if (ags !== null) byAgs.set(ags, [...(byAgs.get(ags) ?? []), index]);
  });
  const inside = [...byAgs.values()].filter((indices) => indices.length === 1).flat();
  edits.forEach((tags, n) => {
    const element: unknown = elements[inside[n] ?? -1];
    assert.ok(isRecord(element), "fixture has three elements inside the fixture municipalities");
    element.tags = { ...(isRecord(element.tags) ? element.tags : {}), ...tags };
  });
  const legacy = await runLegacy(payload);
  const now = new Date().toISOString();
  const ported = build(parse(payload), geo, now);
  assertEntitiesEqual(emittedEntities(legacy), ported);
  assert.ok(JSON.stringify(ported).includes("’"), "an apostrophe edit reached an entity");
  assert.notDeepEqual(
    normalize(ported),
    normalize(build(parse(fixture.payload), geo, now)),
    "edits had no effect",
  );
}

async function guardsWarnAndWriteNothing(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  // HTTP error: the old node warns and stops.
  const failed = await runLegacy("<html>504 Gateway Timeout</html>", 504);
  assert.deepEqual(failed.warnings, ["Overpass Rathaus: keine Daten (504)"]);
  assert.equal(failed.returned, null);
  const rig = overpassRig("rathaus-bw", () => httpResponse(504, "<html>504 Gateway Timeout</html>"));
  await run(rig.ctx);
  assert.deepEqual(rig.log.warnings(), ["Overpass town halls: no data (HTTP 504)"]);
  assert.equal(rig.upserted().length, 0);

  // 200 without an elements array (Overpass reports some errors that way).
  const odd = await runLegacy({ remark: "runtime error" });
  assert.equal(odd.warnings.length, 1);
  const oddRig = overpassRig("rathaus-bw", () => overpassAnswer({ remark: "runtime error" }));
  await run(oddRig.ctx);
  assert.deepEqual(oddRig.log.warnings(), ["Overpass town halls: no data (HTTP 200)"]);

  // No boundaries: the old node warns after the request; the port warns before
  // it and spends no Overpass slot (deliberate, see the module header).
  const blind = await runLegacy(fixture.payload, 200, false);
  assert.deepEqual(blind.warnings, ["Overpass-FN: Grenzen-Cache fehlt"]);
  const blindRig = overpassRig("rathaus-bw", () => overpassAnswer(fixture.payload), { boundaries: false });
  await run(blindRig.ctx);
  assert.equal(blindRig.overpass().length, 0, "no request without boundaries");
  assert.equal(blindRig.upserted().length, 0);
  assert.match(
    blindRig.log.warnings()[0] ?? "",
    /^Overpass town halls: municipality boundaries .* not loaded/,
  );

  // No hit in any municipality: the old node returns null without a word.
  const empty = { ...(isRecord(fixture.payload) ? fixture.payload : {}), elements: [] };
  const quiet = await runLegacy(empty);
  assert.deepEqual([quiet.warnings, quiet.returned], [[], null]);
  const quietRig = overpassRig("rathaus-bw", () => overpassAnswer(empty));
  await run(quietRig.ctx);
  assert.deepEqual([quietRig.log.warnings(), quietRig.upserted()], [[], []]);
}

async function runUpsertsWhatTheOldFlowSent(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const legacy = await runLegacy(fixture.payload);
  const rig = overpassRig("rathaus-bw", () => overpassAnswer(fixture.payload));
  await run(rig.ctx);

  assert.deepEqual(rig.log.warnings(), []);
  assertEntitiesEqual(emittedEntities(legacy), rig.upserted(), {
    labels: { left: "old (Node-RED flow)", right: "new (run → Orion)" },
  });
  assert.deepEqual(rig.upsertSizes(), emittedChunkSizes(legacy));

  // Exactly one request, polite: paced by the shared bucket, no retry, the
  // Node-RED timeout, the contact address.
  const requests = rig.overpass();
  const [request] = requests;
  assert.ok(request !== undefined && requests.length === 1);
  assert.equal(request.url, REQUEST_URL);
  assert.deepEqual(normalize(request.options), {
    maxBytes: OVERPASS_MAX_BYTES,
    maxConcurrent: OVERPASS_MAX_CONCURRENT,
    minIntervalMs: OVERPASS_MIN_INTERVAL_MS,
    retries: 0,
    timeoutMs: OVERPASS_TIMEOUT_MS,
    userAgent: OVERPASS_USER_AGENT,
  });
}

async function unreachableOverpassIsAWarning(): Promise<void> {
  const rig = overpassRig("rathaus-bw", () => new Error("overpass-api.de: no response within 120000 ms"));
  await run(rig.ctx);
  assert.deepEqual(rig.log.warnings(), [
    "Overpass town halls: no data (overpass-api.de: no response within 120000 ms)",
  ]);
  assert.equal(rig.upserted().length, 0);
}

export {
  requestIsIdentical as "rathaus-bw: request URL and User-Agent are those of the old request node",
  fixtureEntitiesAreIdentical as "rathaus-bw: old FN_RATHAUS_BUILD and ported build() emit identical entities and chunks",
  tieBreakKeepsTheFirstOnBothSides as "rathaus-bw: best town hall per municipality, ties go to the first element on both sides",
  modifiedTagsAreIdentical as "rathaus-bw: apostrophes, empty tags and contact:* fallbacks as in the old node",
  guardsWarnAndWriteNothing as "rathaus-bw: HTTP error, missing elements, missing boundaries and no hit write nothing",
  runUpsertsWhatTheOldFlowSent as "rathaus-bw: run() upserts what the old flow sent, with one polite Overpass request",
  unreachableOverpassIsAWarning as "rathaus-bw: an unreachable Overpass is a warning, not a crash",
};
