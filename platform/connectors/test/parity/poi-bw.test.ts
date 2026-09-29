/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: poi-bw — FN_POI_REQ (`udp-rt-poi-req`), the shared wrap
 * (`udp-rt-poi-wrap`) and FN_POI_BUILD (`udp-rt-poi-build`) against the
 * ported module.
 *
 * Compared: the twelve tile URLs byte for byte (their boxes are floating-point
 * arithmetic that ends up in the query text); the entities of the build node
 * on joined parts against `build()` and against what `run()` upserts; the
 * chunking. The fixture puts 84 items of all nine kinds into Weil am Rhein, so
 * the class-balanced round-robin and its cap of 50 run on real data; a
 * modified copy pins the kind rules (recycling variants, defibrillator via
 * `emergency`), "named first" and the name cut.
 *
 * Fixture: test/fixtures/poi-bw.json (see its note), against
 * test/fixtures/grenzen-bw.json.
 */

import assert from "node:assert/strict";
import { build, kindOf, parse, QUERIES, run } from "../../src/connectors/poi-bw.js";
import {
  OVERPASS_MAX_BYTES,
  OVERPASS_MAX_CONCURRENT,
  OVERPASS_MIN_INTERVAL_MS,
  OVERPASS_TIMEOUT_MS,
  OVERPASS_USER_AGENT,
  wrapPart,
} from "../../src/connectors/overpass.js";
import type { RawPart } from "../../src/connectors/overpass.js";
import { chunk } from "../../src/kernel/orion.js";
import { readFixture } from "../harness/fixtures.js";
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

const REQUEST_NODE = "udp-rt-poi-req";
const WRAP_NODE = "udp-rt-poi-wrap";
const BUILD_NODE = "udp-rt-poi-build";
const FIXTURE = "poi-bw";
const CHUNK_SIZE = 100;
const WEIL = "08336091";

function fixtureElements(): unknown[] {
  const payload = readFixture(FIXTURE).payload;
  const elements = isRecord(payload) ? payload.elements : undefined;
  assert.ok(Array.isArray(elements));
  return elements;
}

/** The answer cut into `count` consecutive tile bodies. */
function tiles(elements: readonly unknown[], count: number): { elements: unknown[] }[] {
  const size = Math.ceil(elements.length / count);
  return Array.from({ length: count }, (_, i) => ({ elements: elements.slice(i * size, (i + 1) * size) }));
}

/** The old wrap + build nodes on successful tiles, and the port's parts for the same bodies. */
async function bothSides(bodies: readonly unknown[]): Promise<{ legacy: FunctionNodeRun; parts: RawPart[] }> {
  const joined: unknown[] = [];
  const parts: RawPart[] = [];
  for (const [index, body] of bodies.entries()) {
    const kind = `K${String(index + 1)}`;
    const wrap = await runFunctionNode(WRAP_NODE, {
      msg: { _msgid: "parity", kind, statusCode: 200, payload: structuredClone(body) },
    });
    joined.push(isRecord(wrap.returned) ? wrap.returned.payload : undefined);
    parts.push(wrapPart(kind, { status: 200, body, detail: "" }));
  }
  assert.deepEqual(normalize(parts), normalize(joined), "wrapped parts differ");
  const legacy = await runFunctionNode(BUILD_NODE, {
    msg: { _msgid: "parity", payload: joined },
    global: { bwGrenzen: boundaryFixture().raw },
  });
  return { legacy, parts };
}

async function requestsAreIdentical(): Promise<void> {
  const run = await runFunctionNode(REQUEST_NODE, { msg: { _msgid: "parity", payload: 0 } });
  const returned: unknown = Array.isArray(run.returned) ? run.returned[0] : undefined;
  assert.ok(Array.isArray(returned));
  const legacy = returned.map((msg: unknown) => (isRecord(msg) ? [msg.kind, msg.url, msg.headers] : null));
  assert.deepEqual(
    normalize(legacy),
    QUERIES.map((query) => [query.kind, query.url, { "User-Agent": OVERPASS_USER_AGENT }]),
    "tile URLs differ",
  );
  assert.equal(QUERIES.length, 12);
}

async function fixtureEntitiesAreIdentical(): Promise<void> {
  // Three tiles, each a consecutive third of the real answer.
  const { legacy, parts } = await bothSides(tiles(fixtureElements(), 3));
  const entities = build(parse(parts), fixtureGeo(), new Date().toISOString());

  assert.deepEqual(legacy.warnings, []);
  assertEntitiesEqual(emittedEntities(legacy), entities);
  assert.deepEqual(
    emittedChunkSizes(legacy),
    [...chunk(entities, CHUNK_SIZE)].map((part) => part.length),
  );
  assert.deepEqual(normalize(legacy.status), [{ text: "1 Gemeinden mit Versorgungs-POI" }]);

  // The cap is reached on real data, over all nine kinds.
  const weil = entities.find((entity) => entity.ags.value === WEIL);
  assert.ok(weil !== undefined);
  const counted = Object.values(weil.counts.value).reduce((sum, count) => sum + count, 0);
  assert.equal(counted, 84);
  assert.equal(Object.keys(weil.counts.value).length, 9);
  assert.equal(weil.amenities.value.length, 50);
  assert.equal(weil.totalCount.value, 50, "totalCount is the selected length, as in the old node");
}

async function twoMunicipalitiesKeepTheOldOrder(): Promise<void> {
  // The recording falls into ONE municipality. A modified copy, not fixture
  // data: every third element of Weil am Rhein is copied into Loerrach (new
  // id, a point in its polygon), interleaved with the originals, so the order
  // across municipalities and the per-municipality cap are exercised.
  const geo = fixtureGeo();
  const [lat, lon] = [47.6156, 7.6613];
  const loerrach = geo.agsAt(lat, lon);
  assert.ok(loerrach !== null && loerrach !== WEIL, "the point lies in a second municipality");
  const elements: unknown[] = [];
  fixtureElements().forEach((element, index) => {
    elements.push(element);
    if (index % 3 !== 0 || !isRecord(element) || typeof element.id !== "number") return;
    const offset = (index % 7) * 0.0002;
    elements.push({
      ...structuredClone(element),
      id: element.id + 10_000_000_000,
      lat: lat + offset,
      lon: lon + offset,
    });
  });

  const { legacy, parts } = await bothSides(tiles(elements, 3));
  const entities = build(parse(parts), geo, new Date().toISOString());
  assertEntitiesEqual(emittedEntities(legacy), entities);
  assert.deepEqual(
    entities.map((entity) => entity.ags.value).sort(),
    [loerrach, WEIL].sort(),
    "two municipalities",
  );
  assert.deepEqual(normalize(legacy.status), [{ text: "2 Gemeinden mit Versorgungs-POI" }]);
}

async function kindRulesAreIdentical(): Promise<void> {
  // A modified copy, not fixture data: every branch of artOf, named versus
  // unnamed (a name equal to its kind counts as unnamed), a name beyond 50
  // characters with an apostrophe, and objects the query returns but no rule
  // maps (amenity=kindergarten is mapped, amenity=school is not).
  const elements = structuredClone(fixtureElements());
  const geo = fixtureGeo();
  const inWeil = parse([{ kind: "K1", elements }])[0]?.elements.map(({ lat, lon }) =>
    lat === null || lon === null ? false : geo.agsAt(lat, lon) === WEIL,
  );
  assert.ok(inWeil !== undefined);
  const edits: Record<string, string>[] = [
    { amenity: "recycling", recycling_type: "centre" },
    { amenity: "recycling", "recycling:glass_bottles": "yes", recycling_type: "container" },
    { amenity: "recycling", "recycling:glass": "no" },
    { amenity: "townhall", emergency: "defibrillator", name: "Defibrillator" },
    { amenity: "school", leisure: "playground", name: "Spielplatz" },
    { amenity: "school" },
    { amenity: "pharmacy", name: `Apotheke 'Zum Rhein' am Läublinpark in Weil am Rhein-Friedlingen` },
    { amenity: "doctors", name: "" },
  ];
  let edit = 0;
  elements.forEach((element, index) => {
    if (edit >= edits.length || inWeil[index] !== true || !isRecord(element)) return;
    element.tags = { ...(isRecord(element.tags) ? element.tags : {}), ...edits[edit] };
    edit += 1;
  });
  assert.equal(edit, edits.length);

  const { legacy, parts } = await bothSides(tiles(elements, 2));
  const entities = build(parse(parts), geo, new Date().toISOString());
  assertEntitiesEqual(emittedEntities(legacy), entities);
  const weil = entities.find((entity) => entity.ags.value === WEIL);
  assert.ok(weil !== undefined);
  assert.ok(weil.counts.value.Recyclinghof !== undefined && weil.counts.value.Altglas !== undefined);
}

function kindOfCoversEveryBranch(): void {
  const tags = (entries: Record<string, string>): ReadonlyMap<string, string> =>
    new Map(Object.entries(entries));
  assert.equal(kindOf(tags({ amenity: "recycling", recycling_type: "centre" })), "Recyclinghof");
  assert.equal(kindOf(tags({ amenity: "recycling", "recycling:glass": "yes" })), "Altglas");
  assert.equal(kindOf(tags({ amenity: "recycling", "recycling:glass_bottles": "yes" })), "Altglas");
  assert.equal(kindOf(tags({ amenity: "recycling" })), "Wertstoff-Container");
  assert.equal(kindOf(tags({ amenity: "drinking_water", leisure: "playground" })), "Trinkwasser");
  assert.equal(kindOf(tags({ amenity: "school", leisure: "playground" })), "Spielplatz");
  assert.equal(kindOf(tags({ amenity: "school", emergency: "defibrillator" })), "Defibrillator");
  assert.equal(kindOf(tags({ amenity: "school" })), null);
  // A prototype key is no kind (the old object literal would have answered with a function).
  assert.equal(kindOf(tags({ amenity: "constructor" })), null);
}

async function runUpsertsWhatTheOldFlowSent(): Promise<void> {
  const bodies = tiles(fixtureElements(), 12);
  const legacyClock = openClock();
  const { legacy } = await bothSides(bodies.map((body, index) => (index === 4 ? { elements: [] } : body)));
  const legacyWindow = legacyClock.close();
  const rig = overpassRig("poi-bw", (_url, index) =>
    index === 4 ? new Error("overpass-api.de: request failed") : overpassAnswer(bodies[index]),
  );
  const portClock = openClock();
  await run(rig.ctx);
  const portWindow = portClock.close();

  assertEntitiesEqual(emittedEntities(legacy), rig.upserted(), {
    labels: { left: "old (Node-RED flow)", right: "new (run → Orion)" },
  });
  assert.deepEqual(rig.upsertSizes(), emittedChunkSizes(legacy));
  assertClockStamps(emittedEntities(legacy), rig.upserted(), { legacy: legacyWindow, ported: portWindow });
  assert.deepEqual(rig.log.warnings(), ["Overpass K5: empty or failed (overpass-api.de: request failed)"]);
  assert.deepEqual(
    rig.overpass().map((request) => request.url),
    QUERIES.map((query) => query.url),
  );
  assert.equal(rig.maxInFlight(), 1, "Overpass requests overlapped");
  for (const request of rig.overpass()) {
    assert.deepEqual(normalize(request.options), {
      maxBytes: OVERPASS_MAX_BYTES,
      maxConcurrent: OVERPASS_MAX_CONCURRENT,
      minIntervalMs: OVERPASS_MIN_INTERVAL_MS,
      retries: 0,
      timeoutMs: OVERPASS_TIMEOUT_MS,
      userAgent: OVERPASS_USER_AGENT,
    });
  }
}

async function nothingUsableWarns(): Promise<void> {
  const { legacy } = await bothSides([{ elements: [] }]);
  // The per-tile warning comes from the wrap node, the run's from the build node.
  assert.deepEqual(legacy.warnings, ["Versorgung: keine Entitäten (Overpass evtl. überlastet)"]);

  const rig = overpassRig("poi-bw", () => httpResponse(504, "busy"));
  await run(rig.ctx);
  const warnings = rig.log.warnings();
  assert.equal(warnings.length, 13);
  assert.equal(warnings.at(-1), "Overpass amenities: no entities (Overpass possibly overloaded)");
  assert.equal(rig.upserted().length, 0);
}

export {
  requestsAreIdentical as "poi-bw: the twelve tile URLs and the User-Agent are those of the old request node",
  fixtureEntitiesAreIdentical as "poi-bw: old FN_POI_BUILD and ported build() agree, round-robin cap of 50 on real data",
  twoMunicipalitiesKeepTheOldOrder as "poi-bw: two municipalities (a modified copy) keep the old order and caps",
  kindRulesAreIdentical as "poi-bw: recycling variants, defibrillators, named-first and the name cut as in the old node",
  kindOfCoversEveryBranch as "poi-bw: kindOf covers every branch of the old artOf",
  runUpsertsWhatTheOldFlowSent as "poi-bw: run() upserts what the old flow sent, twelve tiles strictly serialised and paced",
  nothingUsableWarns as "poi-bw: no usable tile — warned per tile and once for the run, nothing written",
};
