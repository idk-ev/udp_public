/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: baustellen-bw — FN_RW_BW (`udp-rt-br-fn`) and FN_RW_EXPIRE
 * (`udp-rt-brx-fn`) against the ported module.
 *
 * Compared: the entities and chunks of 100 on the recorded feed (trimmed geo
 * fixtures, and the full gui/public files), the counters of the status line,
 * the lat/lon swap and the invalid-share warning, the prune on both sides
 * against the same scripted broker (two runs: arm, then delete), and the
 * expiry — ids, the 200 cap, and the delete request `run()` sends.
 *
 * The recorded end dates lie in the future of the recording and would not stay
 * there: every test input moves them by a hundred years ({@link timeless}), so
 * the split between ended and running works stay the same whenever the test
 * runs. Ended road works are test inputs, marked as such.
 *
 * Fixture: test/fixtures/baustellen-bw.json — 76 of 949 real features (see
 * its `note`).
 */

import assert from "node:assert/strict";
import {
  build,
  CHUNK_SIZE,
  expiredIds,
  EXPIRY_MAX_DELETE,
  parse,
  run,
  statusText,
} from "../../src/connectors/baustellen-bw.js";
import type { RoadworkBuild } from "../../src/connectors/baustellen-bw.js";
import { createGeoIndex } from "../../src/kernel/geo.js";
import { chunk } from "../../src/kernel/orion.js";
import { isArray } from "../../src/kernel/parse.js";
import type { HttpResponse } from "../../src/kernel/types.js";
import { messageFromFixture, readFixture } from "../harness/fixtures.js";
import { fakeHttpModule, httpResponse } from "../harness/kernel.js";
import type { SeenRequest } from "../harness/kernel.js";
import { assertEntitiesEqual, isRecord, normalize } from "../harness/normalize.js";
import { payloadOf, runFunctionNode } from "../harness/vm-runner.js";
import type { FunctionNodeRun } from "../harness/vm-runner.js";
import {
  deleteBodies,
  fixtureGeo,
  fullGeo,
  legacyChunks,
  rig,
  upsertBodies,
} from "../harness/water-warnings-rig.js";
import type { FixtureGeo } from "../harness/water-warnings-rig.js";

const NODE_ID = "udp-rt-br-fn";
const EXPIRE_NODE_ID = "udp-rt-brx-fn";
const FIXTURE = "baustellen-bw";
const HOUR = 3_600_000;

/* ── inputs ──────────────────────────────────────────────────────────────────*/

/** The recorded feed with every end date moved a hundred years ahead (see the header). */
function timeless(): Record<string, unknown> {
  const payload = structuredClone(readFixture(FIXTURE).payload);
  assert.ok(isRecord(payload) && isArray(payload.features));
  for (const feature of payload.features) {
    if (!isRecord(feature) || !isRecord(feature.properties)) continue;
    const end = feature.properties.endtime;
    if (typeof end === "string")
      feature.properties.endtime = `${String(Number(end.slice(0, 4)) + 100)}${end.slice(4)}`;
  }
  return payload;
}

function features(payload: Record<string, unknown>): Record<string, unknown>[] {
  const list = payload.features;
  assert.ok(isArray(list));
  return list.filter(isRecord);
}

/** Appends test-input features to the feed. */
function addFeatures(payload: Record<string, unknown>, ...extra: readonly unknown[]): void {
  const list = payload.features;
  payload.features = [...(isArray(list) ? list : []), ...extra];
}

function propertiesOf(feature: Record<string, unknown>): Record<string, unknown> {
  assert.ok(isRecord(feature.properties));
  return feature.properties;
}

/* ── the two sides ───────────────────────────────────────────────────────────*/

async function runLegacy(
  payload: unknown,
  geo: FixtureGeo,
  options: {
    respond?: (request: SeenRequest) => HttpResponse | Error;
    flow?: Readonly<Record<string, unknown>>;
    context?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<FunctionNodeRun> {
  const respond = options.respond ?? ((): Error => new Error("no network in the parity test"));
  return runFunctionNode(NODE_ID, {
    msg: { ...messageFromFixture(readFixture(FIXTURE)), payload: structuredClone(payload) },
    global: { bwGrenzen: geo.rawBoundaries, bwGemeinden: geo.rawRows },
    modules: { http: fakeHttpModule(respond) },
    flow: options.flow ?? {},
    context: options.context ?? {},
  });
}

function ported(payload: unknown, geo: FixtureGeo): RoadworkBuild {
  return build(parse(payload), createGeoIndex(geo.rows, geo.boundaries), new Date().toISOString());
}

/** The German status line of the old node, from the port's counters. */
function oldStatus(result: RoadworkBuild): string {
  return (
    `${String(result.entities.length)} Objekte, ${String(result.districts)} Kreise` +
    (result.ended > 0 ? `, ${String(result.ended)} beendet übersprungen` : "") +
    (result.swapped > 0 ? `, ${String(result.swapped)} Koordinaten getauscht` : "") +
    (result.invalid > 0 ? `, ${String(result.invalid)} ungültig` : "") +
    (result.outside > 0 ? `, ${String(result.outside)} außerhalb BW` : "")
  );
}

async function assertSame(payload: unknown, geo: FixtureGeo): Promise<RoadworkBuild> {
  const legacy = await runLegacy(payload, geo);
  const chunks = legacyChunks(legacy);
  const result = ported(payload, geo);
  assertEntitiesEqual(chunks.entities, result.entities);
  assert.deepEqual(
    chunks.sizes,
    chunk(result.entities, CHUNK_SIZE).map((part) => part.length),
    "chunking differs",
  );
  assert.deepEqual(normalize(legacy.status[0]), { text: oldStatus(result) }, "status counters differ");
  return result;
}

/* ── tests ───────────────────────────────────────────────────────────────────*/

async function recordedFeedIsIdentical(): Promise<void> {
  const result = await assertSame(timeless(), fixtureGeo());
  // What the recording exercises — facts about the fixture.
  assert.equal(result.features, 76);
  assert.equal(result.swapped, 2, "the two Point features carry [lat, lon]");
  assert.ok(result.outside >= 12, "features outside the geo fixture are counted, not assigned");
  assert.equal(result.districts, 7);
  assert.ok(result.entities.some((entity) => entity.id.endsWith("-summary")));
  assert.ok(result.entities.some((entity) => "endDate" in entity));
  // The ids: free text never enters unchanged (the recorded ids contain dots).
  assert.ok(
    result.entities.every((entity) =>
      /^urn:ngsi-ld:RoadWork:bw-(svz-[A-Za-z0-9_-]+|kreis-\d{5}-summary)$/.test(entity.id),
    ),
  );
}

async function fullGeoIsIdentical(): Promise<void> {
  // With the full boundary file the swapped Point features (Plankstadt) are
  // assigned as well.
  const result = await assertSame(timeless(), fullGeo());
  assert.equal(result.outside, 0);
  assert.ok(result.entities.filter((entity) => entity.id.endsWith("-summary")).length > 7);
}

async function editedFeaturesAgree(): Promise<void> {
  // Test inputs, each a branch the recording does not reach.
  const payload = timeless();
  // Features that are assigned in the recording, so every edit reaches its branch.
  const assigned = new Set(ported(payload, fixtureGeo()).entities.map((entity) => entity.id));
  const inside = features(payload).filter((feature) => {
    const id = propertiesOf(feature).id;
    return (
      typeof id === "string" &&
      assigned.has(`urn:ngsi-ld:RoadWork:bw-svz-${id.replace(/[^A-Za-z0-9_-]+/g, "-")}`)
    );
  });
  const [first, second, third] = inside;
  assert.ok(first !== undefined && second !== undefined && third !== undefined);
  propertiesOf(first).endtime = "2020-01-01T00:00:00.000+01:00"; // ended
  const p2 = propertiesOf(second);
  delete p2.id;
  delete p2.reference; // id falls back to the running entity count
  p2.name = "Brücke 'Am Rhein', Sperrung";
  delete p2.endtime; // no endDate attribute
  const p3 = propertiesOf(third);
  p3.name = "";
  p3.street = ""; // -> description
  addFeatures(
    payload,
    { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { id: "zero" } },
    { type: "Feature", geometry: null, properties: { id: "no-geometry" } },
    // Coordinates as text, Freiburg: Number() reads them.
    { type: "Feature", geometry: { type: "Point", coordinates: ["7.85", "47.99"] }, properties: {} },
  );
  const result = await assertSame(payload, fixtureGeo());
  assert.equal(result.ended, 1);
  assert.ok(result.invalid >= 1);
}

async function invalidShareWarnsOnBothSides(): Promise<void> {
  const payload = timeless();
  for (let i = 0; i < 5; i += 1) {
    addFeatures(payload, {
      type: "Feature",
      geometry: { type: "Point", coordinates: [1, 2] },
      properties: { id: `x${String(i)}` },
    });
  }
  const legacy = await runLegacy(payload, fixtureGeo());
  assert.match(
    legacy.warnings[0] ?? "",
    /^BW roadworks: 5 of 81 records with invalid coordinates — feed format changed\?$/,
  );

  const r = rig("baustellen-bw", (request) => {
    if (request.url.host === "api.mobidata-bw.de") return httpResponse(200, JSON.stringify(payload));
    if (request.method === "GET") return httpResponse(200, "[]", { "ngsild-results-count": "0" });
    return httpResponse(204);
  });
  const geo = fixtureGeo();
  r.geo.setMunicipalities(geo.rows);
  r.geo.setBoundaries(geo.boundaries, 0);
  await run(r.ctx);
  assert.ok(
    r.log.warnings().includes(legacy.warnings[0] ?? "?"),
    `port warnings: ${r.log.warnings().join(" | ")}`,
  );
}

function malformedGeometryIsCountedNotFatal(): void {
  // Deliberate difference: the old node threw on this feature and lost the run.
  const payload = timeless();
  addFeatures(payload, { type: "Feature", geometry: { type: "LineString" }, properties: { id: "broken" } });
  const feed = parse(payload);
  assert.equal(feed.malformedGeometry, 1);
  assert.equal(feed.features.length, 76);
}

/* ── the prune, against one scripted broker per side ─────────────────────────*/

class Broker {
  readonly entities = new Map<string, Record<string, unknown>>();
  readonly deleted: string[] = [];

  constructor() {
    const old = { type: "Property", value: { "@type": "DateTime", "@value": "2020-01-01T00:00:00.000Z" } };
    const stale = (id: string): Record<string, unknown> => ({ id, type: "RoadWork", dateObserved: old });
    for (const id of [
      "urn:ngsi-ld:RoadWork:bw-svz-left-the-feed-001",
      "urn:ngsi-ld:RoadWork:bw-kreis-08999-summary",
      // Foreign, and stale: never touched.
      "urn:ngsi-ld:RoadWork:reutlingen-baustelle-1",
      "urn:ngsi-ld:RoadWork:bw-svz-with.dot",
    ]) {
      this.entities.set(id, stale(id));
    }
  }

  readonly respond = (request: SeenRequest): HttpResponse | Error => {
    const params = request.url.searchParams;
    if (request.method === "GET" && params.get("type") === "Municipality") {
      return httpResponse(200, "[]", { "ngsild-results-count": "1103" });
    }
    if (request.method === "GET" && params.get("count") === "true") {
      const all = [...this.entities.values()];
      return httpResponse(200, JSON.stringify(all), { "ngsild-results-count": String(all.length) });
    }
    if (request.method === "GET") return httpResponse(200, "[]"); // the expiry query
    if (request.url.pathname.endsWith("/entityOperations/delete")) {
      const parsed: unknown = JSON.parse(request.body ?? "[]");
      for (const id of isArray(parsed) ? parsed : []) {
        if (typeof id !== "string") continue;
        this.deleted.push(id);
        this.entities.delete(id);
      }
      return httpResponse(204);
    }
    if (request.url.pathname.endsWith("/entityOperations/upsert")) {
      const parsed: unknown = JSON.parse(request.body ?? "[]");
      const now = { type: "Property", value: { "@type": "DateTime", "@value": new Date().toISOString() } };
      for (const entity of isArray(parsed) ? parsed : []) {
        if (isRecord(entity) && typeof entity.id === "string")
          this.entities.set(entity.id, { ...entity, dateObserved: now });
      }
      return httpResponse(204);
    }
    return httpResponse(404);
  };
}

/** The old prune runs detached from the node; wait until it has deleted or gone quiet. */
async function settled(broker: Broker): Promise<void> {
  for (let i = 0; i < 400 && broker.deleted.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function pruneDeletesTheSameOnBothSides(): Promise<void> {
  const geo = fullGeo();
  const payload = timeless();

  // Old: the broker holds this run's entities too, as the upserts would have
  // written them; two runs share flow and node context (arm, then delete).
  const legacyBroker = new Broker();
  for (const entity of ported(payload, geo).entities) {
    legacyBroker.entities.set(entity.id, { id: entity.id, type: "RoadWork" });
  }
  const first = await runLegacy(payload, geo, { respond: legacyBroker.respond });
  await runLegacy(payload, geo, {
    respond: legacyBroker.respond,
    flow: Object.fromEntries(first.flow),
    context: Object.fromEntries(first.context),
  });
  await settled(legacyBroker);

  // New: two runs six hours apart.
  const portedBroker = new Broker();
  const r = rig("baustellen-bw", (request) =>
    request.url.host === "api.mobidata-bw.de"
      ? httpResponse(200, JSON.stringify(payload))
      : portedBroker.respond(request),
  );
  r.geo.setMunicipalities(geo.rows);
  r.geo.setBoundaries(geo.boundaries, 0);
  await run(r.ctx);
  assert.deepEqual(portedBroker.deleted, [], "the first run only arms the interval guard");
  r.clock.now += 6 * HOUR;
  await run(r.ctx);

  assert.deepEqual([...portedBroker.deleted].sort(), [...legacyBroker.deleted].sort());
  assert.deepEqual(portedBroker.deleted.sort(), [
    "urn:ngsi-ld:RoadWork:bw-kreis-08999-summary",
    "urn:ngsi-ld:RoadWork:bw-svz-left-the-feed-001",
  ]);
  assert.ok(portedBroker.entities.has("urn:ngsi-ld:RoadWork:reutlingen-baustelle-1"));
  assert.ok(
    portedBroker.entities.has("urn:ngsi-ld:RoadWork:bw-svz-with.dot"),
    "not matched by the anchored pattern",
  );
  // Both runs upserted everything, ungated.
  const bodies = upsertBodies(r.seen);
  assert.equal(bodies.flat().length, 2 * ported(payload, geo).entities.length);
  assert.ok(
    r.log.lines.some((line) => line.level === "info" && line.text.startsWith("BW roadworks: pruned 2 of")),
  );
}

/* ── expiry ──────────────────────────────────────────────────────────────────*/

function expiryListing(): unknown[] {
  const listing: unknown[] = [
    {
      id: "urn:ngsi-ld:RoadWork:bw-svz-a",
      type: "RoadWork",
      endDate: { type: "Property", value: "2020-01-01T00:00:00" },
    },
    {
      id: "urn:ngsi-ld:RoadWork:bw-svz-b",
      type: "RoadWork",
      endDate: { type: "Property", value: "2999-01-01T00:00:00" },
    },
    { id: "urn:ngsi-ld:RoadWork:bw-svz-c", type: "RoadWork", endDate: "2020-05-05T10:00:00" },
    { id: "urn:ngsi-ld:RoadWork:bw-svz-d", type: "RoadWork" },
    {
      id: "urn:ngsi-ld:RoadWork:bw-svz-e",
      type: "RoadWork",
      endDate: { type: "Property", value: { "@type": "DateTime", "@value": "2020-01-01T00:00:00Z" } },
    },
    { id: "urn:ngsi-ld:RoadWork:bw-svz-f", type: "RoadWork", endDate: { type: "Property", value: null } },
    { id: "urn:ngsi-ld:RoadWork:bw-svz-g", type: "RoadWork", endDate: "" },
  ];
  for (let i = 0; i < 205; i += 1) {
    listing.push({
      id: `urn:ngsi-ld:RoadWork:bw-svz-bulk-${String(i)}`,
      type: "RoadWork",
      endDate: { type: "Property", value: "2021-06-30T12:00:00" },
    });
  }
  return listing;
}

async function expiryMatchesTheOldNode(): Promise<void> {
  const listing = expiryListing();
  const legacy = await runFunctionNode(EXPIRE_NODE_ID, {
    msg: { _msgid: "parity", statusCode: 200, payload: structuredClone(listing) },
  });
  const ids = expiredIds(listing, new Date().toISOString());
  assert.equal(ids.length, 208, "a, c, g and the 205 bulk ones");
  assert.deepEqual(normalize(payloadOf(legacy.returned)), ids.slice(0, EXPIRY_MAX_DELETE));
  assert.deepEqual(normalize(legacy.status), [{ text: "208 abgelaufene Baustellen gelöscht" }]);

  // run(): the source is down, the expiry runs anyway and sends one delete of 200.
  const r = rig("baustellen-bw", (request) => {
    if (request.url.host === "api.mobidata-bw.de") return httpResponse(503, "busy");
    if (request.method === "GET") return httpResponse(200, JSON.stringify(listing));
    return httpResponse(204);
  });
  await run(r.ctx);
  const query = r.seen.find((request) => request.method === "GET" && request.url.host === "orion-ld:1026");
  assert.ok(query !== undefined);
  assert.equal(query.url.searchParams.get("type"), "RoadWork");
  assert.equal(query.url.searchParams.get("idPattern"), "urn:ngsi-ld:RoadWork:bw-svz-.*");
  assert.equal(query.url.searchParams.get("attrs"), "endDate");
  assert.equal(query.url.searchParams.get("limit"), "1000");
  assert.deepEqual(deleteBodies(r.seen), [ids.slice(0, EXPIRY_MAX_DELETE)]);
  assert.deepEqual(r.log.warnings(), ["BW roadworks: data incomplete (503)"]);

  // Nothing expired: no delete on either side.
  const none = await runFunctionNode(EXPIRE_NODE_ID, { msg: { statusCode: 200, payload: [] } });
  assert.equal(none.returned, null);
  assert.deepEqual(expiredIds([], new Date().toISOString()), []);
}

function statusTextIsTheOldOneInEnglish(): void {
  const result = ported(timeless(), fixtureGeo());
  assert.equal(
    statusText(result),
    oldStatus(result)
      .replace("Objekte", "objects")
      .replace("Kreise", "districts")
      .replace("Koordinaten getauscht", "coordinates swapped")
      .replace("außerhalb BW", "outside BW"),
  );
}

export {
  recordedFeedIsIdentical as "baustellen-bw: old FN_RW_BW and ported build() emit identical entities, chunks and counters",
  fullGeoIsIdentical as "baustellen-bw: identical on the full gui/public boundary file (swapped points assigned)",
  editedFeaturesAgree as "baustellen-bw: ended, id-less, renamed, invalid and point-less features (test inputs) agree",
  invalidShareWarnsOnBothSides as "baustellen-bw: more than 5 % invalid coordinates warn identically",
  malformedGeometryIsCountedNotFatal as "baustellen-bw: a geometry without coordinates is counted, not fatal (deliberate)",
  pruneDeletesTheSameOnBothSides as "baustellen-bw: old and new prune delete the same stale own ids, foreign ids stay",
  expiryMatchesTheOldNode as "baustellen-bw: expiry agrees with FN_RW_EXPIRE (ids, 200 cap) and runs when the feed is down",
  statusTextIsTheOldOneInEnglish as "baustellen-bw: the status line is the old one, translated",
};
