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
 * DELIBERATE DEVIATION (module header): the choice of the town hall — the
 * query adds relations, the score marks district and village offices down,
 * and a tie goes to the candidate nearer the municipality's centre. The
 * fixture geo carries boundaries only (PIP_ONLY without master data), where
 * name bonus and distance cannot apply and the Loerrach data has no district
 * office winning, so old and new agree there. Where they differ is pinned on
 * synthetic elements modelled on the real OSM tags of Stuttgart, Baden-Baden,
 * Goeppingen and Neckarsulm ({@link auditExamplesPickTheSeat}).
 *
 * Fixture: test/fixtures/rathaus-bw.json — one real Overpass answer for the
 * district of Loerrach and its neighbours across the border, against the
 * boundary fixture test/fixtures/grenzen-bw.json.
 */

import assert from "node:assert/strict";
import { build, parse, QUERY, REQUEST_URL, run, score, SCORE } from "../../src/connectors/rathaus-bw.js";
import { createGeoIndex } from "../../src/kernel/geo.js";
import type { BoundarySet, GeoIndex, MunicipalityRow } from "../../src/kernel/types.js";
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
import {
  assertClockStamps,
  assertEntitiesEqual,
  isRecord,
  normalize,
  openClock,
} from "../harness/normalize.js";
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

/** The one addition to the old query (deliberate deviation, module header). */
const RELATIONS = 'relation["amenity"="townhall"];';

async function requestIsIdentical(): Promise<void> {
  const run = await runFunctionNode(REQUEST_NODE, { msg: { _msgid: "parity", payload: 0 } });
  const returned = run.returned;
  assert.ok(isRecord(returned));
  // DELIBERATE DEVIATION (module header): relations are queried too — the old
  // URL plus exactly that clause.
  assert.ok(QUERY.includes(RELATIONS));
  assert.equal(
    returned.url,
    REQUEST_URL.replace(encodeURIComponent(RELATIONS), ""),
    "Overpass URL differs beyond the relation clause",
  );
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
 * That holds for the port without master data only (fixture geo); with it,
 * the nearer candidate wins ({@link tieGoesToTheNearerCandidate}).
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
  const legacyClock = openClock();
  const legacy = await runLegacy(fixture.payload);
  const legacyWindow = legacyClock.close();
  const rig = overpassRig("rathaus-bw", () => overpassAnswer(fixture.payload));
  const portClock = openClock();
  await run(rig.ctx);
  const portWindow = portClock.close();

  assert.deepEqual(rig.log.warnings(), []);
  assertEntitiesEqual(emittedEntities(legacy), rig.upserted(), {
    labels: { left: "old (Node-RED flow)", right: "new (run → Orion)" },
  });
  assert.deepEqual(rig.upsertSizes(), emittedChunkSizes(legacy));
  assertClockStamps(emittedEntities(legacy), rig.upserted(), { legacy: legacyWindow, ported: portWindow });

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

/* ------------------------------------------------ the audit examples */

type Town = readonly [ags: string, name: string, lat: number, lon: number];

/** Master data (name, centre) as in bw-gemeinden.json. */
const TOWNS: readonly Town[] = [
  ["08111000", "Stuttgart", 48.77458, 9.17201],
  ["08211000", "Baden-Baden", 48.74847, 8.23191],
  ["08117026", "Göppingen", 48.70983, 9.66643],
  ["08125065", "Neckarsulm", 49.19881, 9.23555],
];

/** A square of ±0.15° around each centre: far apart, no overlap, every probe inside. */
function townBoundaries(): BoundarySet {
  const size = 0.15;
  return Object.fromEntries(
    TOWNS.map(([ags, , lat, lon]) => {
      const [w, s, e, n] = [lon - size, lat - size, lon + size, lat + size];
      return [
        ags,
        {
          b: [w, s, e, n],
          r: [
            [
              [w, s],
              [e, s],
              [e, n],
              [w, n],
              [w, s],
            ],
          ],
        },
      ];
    }),
  );
}

function townGeo(withMasterData = true): GeoIndex {
  const rows: MunicipalityRow[] = TOWNS.map(([ags, name, lat, lon]) => [
    ags,
    name,
    lat,
    lon,
    ags.slice(0, 5),
    "S",
    null,
    null,
    name.toLowerCase(),
  ]);
  return createGeoIndex(withMasterData ? rows : [], townBoundaries());
}

let nextId = 1;
function osm(
  type: "node" | "way" | "relation",
  lat: number,
  lon: number,
  tags: Record<string, string>,
): Record<string, unknown> {
  nextId += 1;
  const position = type === "node" ? { lat, lon } : { center: { lat, lon } };
  return { type, id: nextId, ...position, tags };
}

/**
 * Modelled on the real OSM tags (Overpass, 2026-09): the district office
 * that won on the live pages comes FIRST, so the old first-wins tie-break and
 * its opening-hours bonus pick it; the seat comes later.
 */
function auditElements(): Record<string, unknown>[] {
  const hours = "Mo-Fr 08:30-12:00";
  return [
    // Stuttgart: the seat is a relation, which the old query did not even ask for.
    osm("node", 48.77805, 9.1315, {
      amenity: "townhall",
      name: "Bezirksrathaus Botnang",
      opening_hours: hours,
    }),
    osm("node", 48.84899, 9.15683, {
      amenity: "townhall",
      name: "Bezirksrathaus Stammheim",
      operator: "Stadt Stuttgart",
      "townhall:type": "district",
    }),
    osm("node", 48.72623, 9.14506, { amenity: "townhall", name: "Bürgerbüro Möhringen" }),
    osm("relation", 48.77474, 9.17801, {
      amenity: "townhall",
      name: "Stuttgarter Rathaus",
      opening_hours: "Mo-Fr 08:00-18:00",
      "townhall:type": "city",
    }),
    // Baden-Baden: village offices with opening hours, the seat without any.
    osm("node", 48.80598, 8.21614, {
      amenity: "townhall",
      name: "Ortsverwaltung Haueneberstein",
      opening_hours: hours,
    }),
    osm("node", 48.78026, 8.26979, {
      amenity: "townhall",
      name: "Ortverwaltung Ebersteinburg",
      opening_hours: hours,
    }),
    osm("way", 48.76234, 8.24056, { amenity: "townhall", name: "Rathaus" }),
    // Göppingen: the annex is nearer the master data centre than the seat.
    osm("node", 48.66766, 9.61555, {
      amenity: "townhall",
      name: "Bezirksamt Bezgenriet",
      opening_hours: hours,
    }),
    osm("way", 48.70986, 9.61686, { amenity: "townhall", name: "Bezirksamt Faurndau" }),
    osm("way", 48.70973, 9.65586, { amenity: "townhall", name: "Technisches Rathaus" }),
    osm("node", 48.70346, 9.65379, { amenity: "townhall", name: "Rathaus" }),
    // Neckarsulm: two Verwaltungsstellen, one of them named after the town.
    osm("node", 49.1968, 9.19837, {
      amenity: "townhall",
      name: "Verwaltungsstelle Obereisesheim",
      opening_hours: hours,
      operator: "Stadt Neckarsulm",
    }),
    osm("node", 49.21135, 9.25434, {
      amenity: "townhall",
      name: "Verwaltungsstelle Stadt Neckarsulm",
      "townhall:type": "village",
    }),
    osm("way", 49.19152, 9.2247, { amenity: "townhall", name: "Historisches Rathaus" }),
    osm("way", 49.19128, 9.22505, {
      amenity: "townhall",
      name: "Rathaus (Gebäude A und B)",
      operator: "Stadt Neckarsulm",
    }),
  ];
}

function winners(entities: readonly unknown[]): Record<string, unknown> {
  return Object.fromEntries(
    entities.filter(isRecord).map((entity) => {
      const ags = isRecord(entity.ags) ? entity.ags.value : undefined;
      const name = isRecord(entity.name) ? entity.name.value : undefined;
      return [String(ags), name];
    }),
  );
}

/** The four pages of the audit: the old node picks the district office, the port the seat. */
async function auditExamplesPickTheSeat(): Promise<void> {
  const payload = { elements: auditElements() };
  const now = new Date().toISOString();
  const legacy = await runFunctionNode(BUILD_NODE, {
    msg: { ...messageFromFixture(readFixture(FIXTURE)), statusCode: 200, payload: structuredClone(payload) },
    global: { bwGrenzen: townBoundaries() },
  });
  assert.deepEqual(winners(emittedEntities(legacy)), {
    "08111000": "Bezirksrathaus Botnang",
    "08211000": "Ortsverwaltung Haueneberstein",
    "08117026": "Bezirksamt Bezgenriet",
    "08125065": "Verwaltungsstelle Obereisesheim",
  });
  const expected = {
    "08111000": "Stuttgarter Rathaus",
    "08211000": "Rathaus",
    "08117026": "Rathaus",
    "08125065": "Rathaus (Gebäude A und B)",
  };
  const ported = build(parse(payload), townGeo(), now);
  assert.deepEqual(winners(ported), expected);
  // The right building, with its own coordinates.
  const goeppingen = ported.find((entity) => entity.ags.value === "08117026");
  assert.deepEqual(goeppingen?.location.value.coordinates, [9.65379, 48.70346]);
  // Without master data (PIP_ONLY with boundaries only) the penalties alone
  // still pick the seat in all four.
  assert.deepEqual(winners(build(parse(payload), townGeo(false), now)), expected);
}

/** Equal score: the one nearer the centre wins, whatever the order; without master data the first. */
function tieGoesToTheNearerCandidate(): void {
  const far = osm("node", 48.70346, 9.65379, { amenity: "townhall", name: "Rathaus" });
  const near = osm("node", 48.70983, 9.66543, { amenity: "townhall", name: "Rathaus" });
  const now = new Date().toISOString();
  const pick = (elements: unknown[], geo: GeoIndex): unknown =>
    build(parse({ elements }), geo, now)[0]?.location.value.coordinates;
  assert.deepEqual(pick([far, near], townGeo()), [9.66543, 48.70983]);
  assert.deepEqual(pick([near, far], townGeo()), [9.66543, 48.70983]);
  assert.deepEqual(pick([far, near], townGeo(false)), [9.65379, 48.70346]);
}

function scoreWeighsNameTypeAndHours(): void {
  const tags = (entries: Record<string, string>): ReadonlyMap<string, string> =>
    new Map(Object.entries(entries));
  // The old two signals are still there, and secondary.
  assert.equal(score(tags({ name: "Rathaus", opening_hours: "Mo 08:00-12:00" })), 3);
  assert.equal(
    score(tags({ name: "Stuttgarter Rathaus" }), "Stuttgart"),
    SCORE.townHallName + SCORE.municipalityName,
  );
  // Word start only: "Au" is not in "Rathaus", but in "Rathaus Au".
  assert.equal(score(tags({ name: "Rathaus" }), "Au"), SCORE.townHallName);
  assert.equal(score(tags({ name: "Rathaus Au" }), "Au"), SCORE.townHallName + SCORE.municipalityName);
  // The core of an official name with a river or region.
  assert.equal(
    score(tags({ name: "Rathaus Wendlingen" }), "Wendlingen am Neckar"),
    SCORE.townHallName + SCORE.municipalityName,
  );
  // Sub offices by name, and never a municipality bonus for them.
  for (const name of [
    "Bezirksrathaus Botnang",
    "Bezirksamt Bezgenriet",
    "Ortsverwaltung Haueneberstein",
    "Ortschaftsverwaltung Hegnach",
    "Verwaltungsstelle Stadt Neckarsulm",
    "Ortsamt Musterdorf",
  ]) {
    assert.ok(score(tags({ name }), "Neckarsulm") < 0, name);
  }
  // "Bürgerbüro <Ortsteil>" is one, a bare or the town's own citizens' office is not.
  assert.ok(score(tags({ name: "Bürgerbüro Möhringen" }), "Stuttgart") < 0);
  assert.equal(score(tags({ name: "Bürgerbüro" }), "Stuttgart"), SCORE.townHallName);
  assert.equal(
    score(tags({ name: "Bürgerbüro Stuttgart" }), "Stuttgart"),
    SCORE.townHallName + SCORE.municipalityName,
  );
  // townhall:type both ways.
  assert.equal(
    score(tags({ name: "Rathaus", "townhall:type": "city" })),
    SCORE.townHallName + SCORE.mainType,
  );
  assert.equal(
    score(tags({ name: "Rathaus", "townhall:type": "district" })),
    SCORE.townHallName + SCORE.subType,
  );
  assert.equal(
    score(tags({ name: "Rathaus", "townhall:type": "village" })),
    SCORE.townHallName + SCORE.subType,
  );
  // In a village municipality `village` is the seat itself.
  assert.equal(
    score(tags({ name: "Rathaus", "townhall:type": "village" }), "Birenbach", false),
    SCORE.townHallName,
  );
  // Word END too: an Ortsteil that starts like the town is not the town.
  assert.equal(score(tags({ name: "Rathaus Aufeld" }), "Au"), SCORE.townHallName);
  // One part of a double name counts.
  assert.equal(
    score(tags({ name: "Rathaus Villingen" }), "Villingen-Schwenningen"),
    SCORE.townHallName + SCORE.municipalityName,
  );
  // An annex named after the town does not beat the plain seat.
  const plain = score(tags({ name: "Rathaus" }), "Göppingen");
  assert.ok(score(tags({ name: "Technisches Rathaus Göppingen" }), "Göppingen") < plain);
  assert.ok(score(tags({ name: "Altes Rathaus Göppingen" }), "Göppingen") < plain);
  // The district authority is no town hall of the municipality.
  assert.ok(
    score(tags({ name: "Landratsamt Göppingen", opening_hours: "Mo 08:00-12:00" }), "Göppingen") < plain,
  );
  // Where the citizens' office sits is no district.
  for (const name of ["Bürgerbüro im Rathaus", "Bürgeramt (Rathaus)", "Bürgerbüro / Stadtverwaltung"]) {
    assert.equal(score(tags({ name }), "Göppingen"), SCORE.townHallName, name);
  }
  // Word start for the office names: a "Sportverwaltung" is no Ortsverwaltung.
  assert.equal(score(tags({ name: "Sportverwaltung" })), 0);
}

export {
  auditExamplesPickTheSeat as "rathaus-bw: Stuttgart, Baden-Baden, Göppingen, Neckarsulm get their seat, not a district office (deliberate deviation)",
  tieGoesToTheNearerCandidate as "rathaus-bw: a tie goes to the candidate nearer the municipality centre (deliberate deviation)",
  scoreWeighsNameTypeAndHours as "rathaus-bw: score weighs sub offices, townhall:type, the municipality's name and opening hours",
  requestIsIdentical as "rathaus-bw: request URL and User-Agent are those of the old request node",
  fixtureEntitiesAreIdentical as "rathaus-bw: old FN_RATHAUS_BUILD and ported build() emit identical entities and chunks",
  tieBreakKeepsTheFirstOnBothSides as "rathaus-bw: best town hall per municipality, ties go to the first element on both sides",
  modifiedTagsAreIdentical as "rathaus-bw: apostrophes, empty tags and contact:* fallbacks as in the old node",
  guardsWarnAndWriteNothing as "rathaus-bw: HTTP error, missing elements, missing boundaries and no hit write nothing",
  runUpsertsWhatTheOldFlowSent as "rathaus-bw: run() upserts what the old flow sent, with one polite Overpass request",
  unreachableOverpassIsAWarning as "rathaus-bw: an unreachable Overpass is a warning, not a crash",
};
