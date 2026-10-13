/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: ausflug-bw — FN_AUSFLUG_REQ (`udp-rt-az-req`), FN_AUSFLUG_WRAP
 * (`udp-rt-az-wrap`) and FN_AUSFLUG_BUILD (`udp-rt-az-build`) against the
 * ported module and the shared Overpass helper.
 *
 * Compared: the selector and the four quadrants of the old URLs; the wrap on
 * success, HTTP error, a non-JSON body and no response; the entities of the
 * build node on the joined parts against `build()`, and against what `run()`
 * upserts through the real kernel. The joined payload is the real answer cut
 * into parts in answer order, one of them failed — the join's partial result.
 *
 * The top-25 rule (first 25 distinct cut names, `zielCount` over all hits) is
 * exercised by the real data — two fixture municipalities have more than 25
 * hits — and on a modified copy with duplicate, long and apostrophe names.
 *
 * DELIBERATE DEVIATIONS (module header, overpass.ts), each pinned by its own
 * test and kept out of the comparisons above:
 *
 *  * `zielCount` counts an object once (same OSM id, or same cut name and
 *    position). No recorded element repeats; {@link duplicatesAreCountedOnce}.
 *  * `counts` per type label — compared without it, pinned by
 *    {@link countsSumUpToZielCount}.
 *  * 15 tiles with `[timeout:60][maxsize:128 MiB]` instead of 4 quadrants
 *    with `[timeout:120]` — {@link requestsAreTheQuartersOfTheOldQuadrants},
 *    {@link tilesCoverEveryMunicipality}.
 *  * A `remark` fails a tile ({@link wrapIsIdentical}); refused tiles are
 *    retried after a pause ({@link refusedTileIsRetriedAfterAPause}); a
 *    failed tile keeps the municipalities it touches
 *    ({@link failedTileKeepsItsMunicipalities}); a drop of more than 80 % is
 *    not written ({@link implausibleDropIsNotWritten}).
 *
 * Fixture: test/fixtures/ausflug-bw.json (see its note), against
 * test/fixtures/grenzen-bw.json.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  build,
  MAXSIZE_BYTES,
  OUTSIDE,
  parse,
  QUADRANTS,
  QUERIES,
  run,
  SELECTOR,
  TILES,
} from "../../src/connectors/ausflug-bw.js";
import {
  OVERPASS_HOST,
  OVERPASS_MAX_BYTES,
  OVERPASS_MAX_CONCURRENT,
  OVERPASS_MIN_INTERVAL_MS,
  OVERPASS_TIMEOUT_MS,
  OVERPASS_USER_AGENT,
  overpassUrl,
  plainResponse,
  touches,
  wrapPart,
} from "../../src/connectors/overpass.js";
import type { Box, OverpassResponse, RawPart } from "../../src/connectors/overpass.js";
import { chunk } from "../../src/kernel/orion.js";
import { readFixture, repositoryRoot } from "../harness/fixtures.js";
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
import { VirtualClock } from "../harness/virtual-clock.js";
import { runFunctionNode } from "../harness/vm-runner.js";
import type { FunctionNodeRun } from "../harness/vm-runner.js";

const REQUEST_NODE = "udp-rt-az-req";
const WRAP_NODE = "udp-rt-az-wrap";
const BUILD_NODE = "udp-rt-az-build";
const FIXTURE = "ausflug-bw";
const CHUNK_SIZE = 100;
const TYPE = "TouristDestination";
/** Weil am Rhein: in the fixture, far from every tile border. */
const WEIL = "08336091";
/** Its area reaches to within 1 km of 48.1°, the southern border of T8 (48.1–48.7). */
const BORDER = "08315015";
/** The fixture's tile, 47.5–48.1 / 7.4–8.2. */
const FIXTURE_TILE = 9;

function fixtureElements(): unknown[] {
  const payload = readFixture(FIXTURE).payload;
  const elements = isRecord(payload) ? payload.elements : undefined;
  assert.ok(Array.isArray(elements));
  return elements;
}

/** Warnings without those for answers that came without elements (the tiles a test leaves empty). */
function failures(warnings: readonly string[]): string[] {
  return warnings.filter((warning) => !/^Overpass T\d+: answer without elements/.test(warning));
}

/** Municipalities the whole fixture answer yields. */
function fixtureMunicipalities(): number {
  const parts = parse([{ kind: "T10", elements: fixtureElements() }]);
  return build(parts, fixtureGeo(), new Date().toISOString()).length;
}

/** The answer cut into `count` consecutive parts, as Overpass bodies. */
function slices(elements: readonly unknown[], count: number): { elements: unknown[] }[] {
  const size = Math.ceil(elements.length / count);
  return Array.from({ length: count }, (_, i) => ({ elements: elements.slice(i * size, (i + 1) * size) }));
}

/** An answer as the http request node hands it to the wrap (`ret: "obj"`). */
interface Answer {
  readonly statusCode: number | string | undefined;
  readonly payload: unknown;
}

/** The same answer as the port's fetchOverpass reports it. */
function asResponse(answer: Answer): OverpassResponse {
  const status = typeof answer.statusCode === "number" ? answer.statusCode : null;
  const parsed = status !== null && status < 400 && typeof answer.payload !== "string";
  return plainResponse(status, parsed ? answer.payload : undefined);
}

async function legacyWrap(kind: string, answer: Answer): Promise<FunctionNodeRun> {
  return runFunctionNode(WRAP_NODE, {
    msg: { _msgid: "parity", kind, statusCode: answer.statusCode, payload: structuredClone(answer.payload) },
  });
}

function wrappedPayload(run: FunctionNodeRun): unknown {
  return isRecord(run.returned) ? run.returned.payload : undefined;
}

/** Both sides from the same answers: the old wrap + build nodes, and the port's wrap. */
async function bothSides(answers: readonly Answer[]): Promise<{ legacy: FunctionNodeRun; parts: RawPart[] }> {
  const joined: unknown[] = [];
  const parts: RawPart[] = [];
  for (const [index, answer] of answers.entries()) {
    const kind = `T${String(index + 1)}`;
    joined.push(wrappedPayload(await legacyWrap(kind, answer)));
    parts.push(wrapPart(kind, asResponse(answer)));
  }
  assert.deepEqual(normalize(parts), normalize(joined), "wrapped parts differ");
  const legacy = await runFunctionNode(BUILD_NODE, {
    msg: { _msgid: "parity", payload: joined },
    global: { bwGrenzen: boundaryFixture().raw },
  });
  return { legacy, parts };
}

/** Entities without the given attributes, for comparing the rest with the old node. */
function without(entities: readonly unknown[], ...keys: string[]): unknown[] {
  return entities.map((entity) => {
    if (!isRecord(entity)) return entity;
    return Object.fromEntries(Object.entries(entity).filter(([key]) => !keys.includes(key)));
  });
}

/** The old URL of a quadrant: `[out:json][timeout:120]`, its box, the selector. */
function legacyUrl(box: Box): string {
  return overpassUrl(`[out:json][timeout:120][bbox:${box.join(",")}];(${SELECTOR});out tags center;`);
}

async function requestsAreTheQuartersOfTheOldQuadrants(): Promise<void> {
  const run = await runFunctionNode(REQUEST_NODE, { msg: { _msgid: "parity", payload: 0 } });
  const returned: unknown = Array.isArray(run.returned) ? run.returned[0] : undefined;
  assert.ok(Array.isArray(returned));
  // Selector and quadrants are the old node's, byte for byte.
  assert.deepEqual(
    normalize(returned.map((msg: unknown) => (isRecord(msg) ? [msg.kind, msg.url] : null))),
    QUADRANTS.map((box, index) => [`Q${String(index + 1)}`, legacyUrl(box)]),
    "quadrant URLs differ",
  );
  for (const msg of returned) {
    assert.ok(isRecord(msg));
    assert.deepEqual(normalize(msg.headers), { "User-Agent": OVERPASS_USER_AGENT });
  }

  // DELIBERATE DEVIATION: every quadrant cut into its four quarters, in the
  // old quadrant order, without the one outside the state.
  const quarters = QUADRANTS.flatMap(([south, west, north, east]): Box[] => {
    const lat = Math.round(((south + north) / 2) * 10) / 10;
    const lon = Math.round(((west + east) / 2) * 10) / 10;
    return [
      [lat, west, north, lon],
      [lat, lon, north, east],
      [south, west, lat, lon],
      [south, lon, lat, east],
    ];
  });
  assert.deepEqual(
    TILES,
    quarters.filter((box) => box.join() !== OUTSIDE.join()),
  );
  assert.equal(QUERIES.length, 15);
  assert.equal(MAXSIZE_BYTES, 134_217_728);
  QUERIES.forEach((query, index) => {
    assert.equal(query.kind, `T${String(index + 1)}`);
    assert.deepEqual(query.box, TILES[index]);
    assert.equal(
      query.url,
      legacyUrl(query.box).replace(
        encodeURIComponent("[timeout:120]"),
        encodeURIComponent("[timeout:60][maxsize:134217728]"),
      ),
    );
  });
}

function tilesCoverEveryMunicipality(): void {
  // The boundaries the page itself loads: every municipality of the state.
  const path = join(repositoryRoot(), "gui", "public", "bw-grenzen.json");
  const boundaries: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(isRecord(boundaries));
  const boxes = Object.values(boundaries).map((entry) => {
    assert.ok(isRecord(entry) && Array.isArray(entry.b) && entry.b.length === 4);
    const [west, south, east, north] = entry.b.map(Number);
    assert.ok(west !== undefined && south !== undefined && east !== undefined && north !== undefined);
    return [west, south, east, north] as const;
  });
  assert.ok(boxes.length > 1000);
  // The tile left out holds no municipality; the fifteen hold them all.
  assert.equal(boxes.filter((b) => touches(b, OUTSIDE, 0)).length, 0, "a municipality in the left-out tile");
  for (const [west, south, east, north] of boxes) {
    assert.ok(west >= 7.4 && east <= 10.6 && south >= 47.5 && north <= 49.9, "outside the quadrants");
    assert.ok(TILES.some((tile) => touches([west, south, east, north], tile, 0)));
  }
}

async function wrapIsIdentical(): Promise<void> {
  const cases: readonly Answer[] = [
    { statusCode: 200, payload: { elements: fixtureElements() } },
    { statusCode: 200, payload: { elements: [] } },
    { statusCode: 504, payload: "<html>504 Gateway Timeout</html>" },
    { statusCode: 429, payload: "rate_limited" },
    // ret: "obj" leaves an unparseable body as a string, status 200.
    { statusCode: 200, payload: "<?xml version='1.0'?><osm/>" },
    { statusCode: 200, payload: { remark: "runtime error: Query timed out" } },
    // No response at all: Node-RED puts the error code into statusCode.
    { statusCode: "ETIMEDOUT", payload: "RequestError: timeout" },
  ];
  for (const answer of cases) {
    const legacy = await legacyWrap("Q2", answer);
    const ported = wrapPart("Q2", asResponse(answer));
    assert.deepEqual(
      normalize(ported),
      normalize(wrappedPayload(legacy)),
      `wrap of ${String(answer.statusCode)}`,
    );
    // The old node warns exactly when the part is empty; run() does the same.
    assert.equal(legacy.warnings.length, ported.elements.length === 0 ? 1 : 0);
  }

  // DELIBERATE DEVIATION: a remark next to elements is a truncated answer.
  // The old wrap took its elements; the port takes none.
  const truncated: Answer = {
    statusCode: 200,
    payload: {
      elements: fixtureElements().slice(0, 3),
      remark: 'runtime error: Query ran out of memory in "query"',
    },
  };
  const legacy = wrappedPayload(await legacyWrap("Q2", truncated));
  assert.ok(isRecord(legacy) && Array.isArray(legacy.elements) && legacy.elements.length === 3);
  assert.deepEqual(wrapPart("Q2", asResponse(truncated)).elements, []);
}

async function joinedPartsAreIdentical(): Promise<void> {
  const [q1, q2, q3] = slices(fixtureElements(), 3);
  // Q3 failed: the join's partial result, with one part empty.
  const answers: Answer[] = [
    { statusCode: 200, payload: q1 },
    { statusCode: 200, payload: q2 },
    { statusCode: 504, payload: "<html>504</html>" },
    { statusCode: 200, payload: q3 },
  ];
  const { legacy, parts } = await bothSides(answers);
  const entities = build(parse(parts), fixtureGeo(), new Date().toISOString());

  assert.equal(entities.length, 8);
  assertEntitiesEqual(emittedEntities(legacy), without(entities, "counts"));
  assert.deepEqual(
    emittedChunkSizes(legacy),
    [...chunk(entities, CHUNK_SIZE)].map((part) => part.length),
  );
  assert.deepEqual(normalize(legacy.status), [{ text: "8 Gemeinden · Quellen: T1,T2,T4" }]);

  // What the fixture must keep exercising: the cap and destinations of ways/relations.
  const capped = entities.filter((entity) => entity.zielCount.value > 25);
  assert.equal(capped.length, 2, "two municipalities with more than 25 hits");
  for (const entity of capped) assert.equal(entity.ziele.value.length, 25);
}

function countsSumUpToZielCount(): void {
  const entities = build(
    parse([{ kind: "T10", elements: fixtureElements() }]),
    fixtureGeo(),
    new Date().toISOString(),
  );
  assert.ok(entities.length > 0);
  for (const entity of entities) {
    const counts = Object.values(entity.counts.value);
    assert.equal(
      counts.reduce((sum, n) => sum + n, 0),
      entity.zielCount.value,
      entity.id,
    );
    // Labels of the old TYP table, or "Ziel".
    for (const label of Object.keys(entity.counts.value)) {
      assert.ok(["Sehenswürdigkeit", "Aussichtspunkt", "Museum", "Burg/Schloss", "Ziel"].includes(label));
    }
  }
  // Uncapped: where the list is cut at 25, the counts are not.
  const capped = entities.filter((entity) => entity.zielCount.value > entity.ziele.value.length);
  assert.ok(capped.length > 0);
  for (const entity of capped) {
    const listed = entity.ziele.value.length;
    assert.ok(Object.values(entity.counts.value).reduce((sum, n) => sum + n, 0) > listed);
  }
}

async function selectionEdgesAreIdentical(): Promise<void> {
  // A modified copy, not fixture data: duplicate names, names beyond 60
  // characters (duplicates only after the cut), apostrophes, empty names, a
  // way without center, and the four labelled kinds.
  const elements = structuredClone(fixtureElements());
  const geo = fixtureGeo();
  const inside = parse([{ kind: "Q1", elements }])[0]?.elements.map(({ lat, lon }) =>
    lat === null || lon === null ? null : geo.agsAt(lat, lon),
  );
  assert.ok(inside !== undefined);
  const long = `Aussichtspunkt 'Hohe Möhr' über dem Wiesental und dem Dinkelberg, ${"x".repeat(10)}`;
  const edits: Record<string, string>[] = [
    { name: "Burg Rötteln" },
    { name: "Burg Rötteln", historic: "castle" },
    { name: `${long}-A`, tourism: "viewpoint" },
    { name: `${long}-B`, tourism: "museum" },
    { name: "" },
    { name: "L'Ancienne Douane", tourism: "attraction" },
  ];
  let edit = 0;
  elements.forEach((element, index) => {
    if (edit >= edits.length || inside[index] === null || !isRecord(element)) return;
    element.tags = { ...(isRecord(element.tags) ? element.tags : {}), ...edits[edit] };
    edit += 1;
  });
  assert.equal(edit, edits.length);
  // One way loses its center: skipped on both sides.
  const way = elements.find((element) => isRecord(element) && element.type === "way");
  if (isRecord(way)) delete way.center;

  const { legacy, parts } = await bothSides([{ statusCode: 200, payload: { elements } }]);
  const entities = build(parse(parts), geo, new Date().toISOString());
  assertEntitiesEqual(emittedEntities(legacy), without(entities, "counts"));
  const names = entities.flatMap((entity) => entity.ziele.value.map((destination) => destination[0]));
  assert.ok(
    names.some((name) => name.length === 60 && name.includes("’")),
    "a long name was cut after the swap",
  );
}

async function nothingUsableWarns(): Promise<void> {
  const answers: Answer[] = [0, 1, 2, 3].map(() => ({ statusCode: 504, payload: "busy" }));
  const { legacy, parts } = await bothSides(answers);
  assert.deepEqual(legacy.warnings, ["Ausflugsziele: keine Entitäten (Quellen ok: )"]);
  assert.equal(build(parse(parts), fixtureGeo(), new Date().toISOString()).length, 0);

  // Every tile refused: the run's six retries go to the first two tiles; a
  // refusal after that ends the run's requests — the rest is not sent.
  const rig = overpassRig("ausflug-bw", () => httpResponse(504, "busy"));
  await run(rig.ctx);
  const warnings = rig.log.warnings();
  assert.equal(warnings.length, 4, warnings.join("\n"));
  assert.match(warnings[0] ?? "", /^Overpass T1: failed after 4 attempts — HTTP 504 after \d+\.\d s: busy$/);
  assert.match(warnings[1] ?? "", /^Overpass T2: failed after 4 attempts — HTTP 504/);
  assert.equal(
    warnings[2],
    `Overpass ${QUERIES.slice(2)
      .map((query) => query.kind)
      .join(",")}: not requested — Overpass keeps refusing after the run's retries`,
  );
  assert.equal(warnings.at(-1), "Overpass tourist destinations: no entities (sources ok: )");
  assert.equal(rig.overpass().length, 2 * 4);
  assert.equal(rig.pauses.length, 6);
  assert.equal(rig.upserted().length, 0);
}

async function runUpsertsWhatTheOldFlowSent(): Promise<void> {
  const bodies = slices(fixtureElements(), QUERIES.length);
  const answers: Answer[] = bodies.map((payload) => ({ statusCode: 200, payload }));
  const legacyClock = openClock();
  const { legacy } = await bothSides(answers);
  const legacyWindow = legacyClock.close();
  const rig = overpassRig("ausflug-bw", (_url, index) => overpassAnswer(bodies[index]));
  const portClock = openClock();
  await run(rig.ctx);
  const portWindow = portClock.close();

  assertEntitiesEqual(emittedEntities(legacy), without(rig.upserted(), "counts"), {
    labels: { left: "old (Node-RED flow)", right: "new (run → Orion)" },
  });
  assert.deepEqual(rig.upsertSizes(), emittedChunkSizes(legacy));
  assertClockStamps(emittedEntities(legacy), without(rig.upserted(), "counts"), {
    legacy: legacyWindow,
    ported: portWindow,
  });
  assert.deepEqual(rig.log.warnings(), []);

  // Strictly serialised, in tile order, each paced by the shared bucket, no
  // transport retries.
  assert.deepEqual(
    rig.overpass().map((request) => request.url),
    QUERIES.map((query) => query.url),
  );
  assert.equal(rig.maxInFlight(), 1, "Overpass requests overlapped");
  for (const request of rig.overpass()) {
    assert.deepEqual(normalize(request.options), {
      bucket: null,
      maxBytes: OVERPASS_MAX_BYTES,
      retries: 0,
      timeoutMs: OVERPASS_TIMEOUT_MS,
      userAgent: OVERPASS_USER_AGENT,
    });
  }
  assert.deepEqual(
    rig.acquired,
    QUERIES.map(() => ({
      host: OVERPASS_HOST,
      minIntervalMs: OVERPASS_MIN_INTERVAL_MS,
      maxConcurrent: OVERPASS_MAX_CONCURRENT,
      signal: true,
    })),
  );
  assert.deepEqual(rig.pauses, []);
}

async function refusedTileIsRetriedAfterAPause(): Promise<void> {
  // T3: a "too busy" 504, then the answer. T5: a 429 asking for 400 s, then
  // the answer. The waits are the shared bucket's, on a simulated clock.
  const busy =
    '<?xml version="1.0"?><html><head><title>OSM3S Response</title></head><body><p>The data included in ' +
    "this document is from www.openstreetmap.org.</p><p><strong>Error</strong>: runtime error: open64: 0 " +
    "Success /osm3s_osm_base Dispatcher_Client::request_read_and_idx::timeout. The server is probably too " +
    "busy to handle your request.</p></body></html>";
  const clock = new VirtualClock(Date.parse("2026-10-11T03:10:00Z"));
  const bodies = slices(fixtureElements(), QUERIES.length);
  const rig = overpassRig(
    "ausflug-bw",
    (url, index) => {
      if (index === 2) return httpResponse(504, busy);
      if (index === 5) return httpResponse(429, "rate_limited", { "Retry-After": "400" });
      const tile = QUERIES.findIndex((query) => query.url === url);
      return overpassAnswer(bodies[tile]);
    },
    { clock },
  );
  await clock.run(run(rig.ctx));

  const requests = rig.overpass();
  assert.equal(requests.length, 17);
  const kinds = requests.map((request) => QUERIES.find((query) => query.url === request.url)?.kind);
  assert.deepEqual(kinds.slice(0, 7), ["T1", "T2", "T3", "T3", "T4", "T5", "T5"]);
  assert.deepEqual(rig.pauses, [
    { host: OVERPASS_HOST, ms: 120_000 },
    { host: OVERPASS_HOST, ms: 400_000 },
  ]);
  // The spacing of the bucket, and the pauses after the refusals.
  const at = requests.map((request) => request.at);
  for (let i = 1; i < at.length; i += 1) {
    assert.ok((at[i] ?? 0) - (at[i - 1] ?? 0) >= OVERPASS_MIN_INTERVAL_MS, `request ${String(i)} too early`);
  }
  assert.ok((at[3] ?? 0) - (at[2] ?? 0) >= 120_000, "retry of T3 before its pause");
  assert.ok((at[6] ?? 0) - (at[5] ?? 0) >= 400_000, "retry of T5 before Retry-After");
  // Logged: status, latency, the error text of the page — no warning, the tiles came.
  const infos = rig.log.lines.filter((line) => line.level === "info").map((line) => line.text);
  assert.ok(
    infos.some((text) =>
      /^Overpass T3: HTTP 504 after \d+\.\d s: Error: runtime error: open64: 0 Success \/osm3s_osm_base Dispatcher_Client::.* — retry 1\/3 in 120 s$/.test(
        text,
      ),
    ),
    infos.join("\n"),
  );
  assert.ok(infos.some((text) => /^Overpass T5: HTTP 429 after .* — retry 1\/3 in 400 s$/.test(text)));
  // Each pause is set while the refused request still holds its token, so no
  // other Overpass request can slip in before it.
  rig.events.forEach((event, index) => {
    if (event !== "pause") return;
    assert.deepEqual([rig.events[index - 1], rig.events[index + 1]], ["acquire", "release"]);
  });
  assert.deepEqual(rig.log.warnings(), []);
  assert.equal(rig.upserted().length, fixtureMunicipalities());
}

/** A point of `ags` in the fixture boundaries, found on a grid over its bounding box. */
function pointIn(ags: string): readonly [lat: number, lon: number] {
  const geo = fixtureGeo();
  const entry = boundaryFixture().boundaries[ags];
  assert.ok(entry !== undefined);
  const [west, south, east, north] = entry.b;
  for (let i = 1; i < 20; i += 1) {
    for (let j = 1; j < 20; j += 1) {
      const lat = south + ((north - south) * i) / 20;
      const lon = west + ((east - west) * j) / 20;
      if (geo.agsAt(lat, lon) === ags) return [lat, lon];
    }
  }
  throw new Error(`no point found in ${ags}`);
}

/**
 * What a tile without fixture data answers: one unnamed node at its centre,
 * which no build takes — `ausflug-bw` counts an answer without any element as
 * a failed tile.
 */
function filler(tile: number): unknown[] {
  const [south, west, north, east] = TILES[tile] ?? OUTSIDE;
  return [
    { type: "node", id: 8_000_000_000 + tile, lat: (south + north) / 2, lon: (west + east) / 2, tags: {} },
  ];
}

/** Named viewpoints around one point, as an Overpass answer lists nodes. */
function viewpoints(ags: string, count: number, firstId: number): unknown[] {
  const [lat, lon] = pointIn(ags);
  return Array.from({ length: count }, (_, i) => ({
    type: "node",
    id: firstId + i,
    lat: lat + i * 0.00001,
    lon,
    tags: { name: `Aussicht ${String(i)}`, tourism: "viewpoint" },
  }));
}

async function failedTileKeepsItsMunicipalities(): Promise<void> {
  // The fixture's tile answers, with 30 more destinations in BORDER; T8 north
  // of it fails three retries in a row. BORDER reaches to within 1 km of T8
  // and is kept; the others lie wholly in tiles that answered.
  const elements = [...fixtureElements(), ...viewpoints(BORDER, 30, 9_000_000_000)];
  const failing = QUERIES.findIndex((query) => query.kind === "T8");
  assert.ok(touches(boundaryFixture().boundaries[BORDER]?.b ?? [0, 0, 0, 0], TILES[failing] ?? OUTSIDE));
  const rig = overpassRig("ausflug-bw", (url) => {
    const tile = QUERIES.findIndex((query) => query.url === url);
    if (tile === failing) return httpResponse(504, "busy");
    return overpassAnswer({ elements: tile === FIXTURE_TILE ? elements : filler(tile) });
  });
  await run(rig.ctx);

  const written = rig.upserted().map((entity) => (isRecord(entity) ? entity.id : null));
  assert.ok(written.includes(`urn:ngsi-ld:${TYPE}:bw-${WEIL}`), "an inner municipality was not written");
  assert.ok(!written.includes(`urn:ngsi-ld:${TYPE}:bw-${BORDER}`), "the border municipality was written");
  const inner = fixtureMunicipalities();
  assert.equal(written.length, inner);
  const warnings = failures(rig.log.warnings());
  assert.equal(warnings.length, 2, warnings.join("\n"));
  assert.match(warnings[0] ?? "", /^Overpass T8: failed after 4 attempts — HTTP 504 after \d+\.\d s: busy$/);
  assert.equal(
    warnings[1],
    `Overpass tourist destinations: 1 of ${String(inner + 1)} municipalities not written — ` +
      "they touch the failed tiles T8; previous values kept",
  );
  const status = `${String(inner)} of ${String(inner + 1)} municipalities`;
  assert.ok(rig.log.lines.some((line) => line.level === "status" && line.text.startsWith(status)));

  // A remark fails the tile the same way, without a retry.
  const remark = overpassRig("ausflug-bw", (url) => {
    const tile = QUERIES.findIndex((query) => query.url === url);
    if (tile === failing) {
      return overpassAnswer({
        elements: viewpoints(BORDER, 2, 9_100_000_000),
        remark: 'runtime error: Query ran out of memory in "query" at line 1.',
      });
    }
    return overpassAnswer({ elements: tile === FIXTURE_TILE ? elements : filler(tile) });
  });
  await run(remark.ctx);
  assert.equal(remark.overpass().length, 15);
  assert.match(
    failures(remark.log.warnings())[0] ?? "",
    /^Overpass T8: failed — HTTP 200, remark after \d+\.\d s: runtime error: Query ran out of memory in "query" at line 1\.$/,
  );
  assert.equal(remark.upserted().length, inner);

  // An answer without any element fails the tile as well (ausflug-bw only).
  const empty = overpassRig("ausflug-bw", (url) => {
    const tile = QUERIES.findIndex((query) => query.url === url);
    if (tile === failing) return overpassAnswer({ elements: [] });
    return overpassAnswer({ elements: tile === FIXTURE_TILE ? elements : filler(tile) });
  });
  await run(empty.ctx);
  assert.equal(empty.overpass().length, 15);
  assert.match(
    failures(empty.log.warnings())[0] ?? "",
    /^Overpass T8: failed — answer without elements \(HTTP 200/,
  );
  assert.equal(empty.upserted().length, inner);

  // Every tile answered: BORDER too.
  const whole = overpassRig("ausflug-bw", (url) => {
    const tile = QUERIES.findIndex((query) => query.url === url);
    return overpassAnswer({ elements: tile === FIXTURE_TILE ? elements : filler(tile) });
  });
  await run(whole.ctx);
  assert.equal(whole.upserted().length, inner + 1);
}

async function implausibleDropIsNotWritten(): Promise<void> {
  const elements = fixtureElements();
  const now = new Date().toISOString();
  const built = build(parse([{ kind: "T10", elements }]), fixtureGeo(), now);
  const byCount = [...built].sort((a, b) => b.zielCount.value - a.zielCount.value);
  const [big, second] = byCount;
  const small = byCount.find((entity) => entity.zielCount.value === 1);
  const fifth = byCount.find((entity) => entity.zielCount.value >= 4 && entity !== big && entity !== second);
  assert.ok(big !== undefined && second !== undefined && small !== undefined && fifth !== undefined);
  // big: was six times as many (a drop of 83 %) — refused. second: a rise.
  // small: 19 → 1, but 19 is too few to judge. fifth: exactly 80 % less — allowed.
  const stored = [
    { id: big.id, type: TYPE, zielCount: big.zielCount.value * 6 },
    { id: second.id, type: TYPE, zielCount: Math.max(0, second.zielCount.value - 5) },
    { id: small.id, type: TYPE, zielCount: 19 },
    { id: fifth.id, type: TYPE, zielCount: fifth.zielCount.value * 5 },
  ];
  const answer = (url: string): ReturnType<typeof overpassAnswer> => {
    const tile = QUERIES.findIndex((query) => query.url === url);
    return overpassAnswer({ elements: tile === FIXTURE_TILE ? elements : filler(tile) });
  };
  const rig = overpassRig("ausflug-bw", answer, { stored: { [TYPE]: stored } });
  await run(rig.ctx);
  const written = rig.upserted().map((entity) => (isRecord(entity) ? entity.id : null));
  assert.equal(written.length, built.length - 1);
  assert.ok(!written.includes(big.id));
  for (const kept of [second, small, fifth]) assert.ok(written.includes(kept.id), kept.id);
  assert.deepEqual(failures(rig.log.warnings()), [
    `Overpass tourist destinations: 1 municipality not written — count fell by more than 80 % ` +
      `(${big.ags.value}: ${String(big.zielCount.value * 6)} → ${String(big.zielCount.value)}); previous values kept`,
  ]);
  // The listing: one per run, the count attribute only.
  const listings = rig.seen.filter(
    (request) => request.method === "GET" && !request.url.includes(OVERPASS_HOST),
  );
  assert.equal(listings.length, 1);
  const query = new URL(listings[0]?.url ?? "").searchParams;
  assert.deepEqual(
    [query.get("type"), query.get("idPattern"), query.get("attrs"), query.get("options")],
    [TYPE, `^urn:ngsi-ld:${TYPE}:bw-`, "zielCount", "keyValues"],
  );

  // The broker cannot list the previous values: nothing is written.
  const blind = overpassRig("ausflug-bw", answer, { listingStatus: 503 });
  await run(blind.ctx);
  assert.equal(blind.upserted().length, 0);
  assert.deepEqual(failures(blind.log.warnings()), [
    "Overpass tourist destinations: previous counts not readable (HTTP 503) — nothing written, previous values kept",
  ]);
}

async function preconditionsSpendNoOverpassSlot(): Promise<void> {
  // No boundaries: skipped before the first request (the old flow sent all four).
  const blind = overpassRig("ausflug-bw", () => overpassAnswer({ elements: [] }), { boundaries: false });
  await run(blind.ctx);
  assert.equal(blind.overpass().length, 0);
  assert.match(blind.log.warnings()[0] ?? "", /^Overpass tourist destinations: municipality boundaries/);

  // Shutdown during the run: no further tile, nothing written.
  const stopped = overpassRig("ausflug-bw", () => overpassAnswer({ elements: fixtureElements() }), {
    beforeAnswer: (index, rig) => {
      if (index === 1) rig.kernel.shutdown.abort();
    },
  });
  await run(stopped.ctx);
  assert.equal(stopped.overpass().length, 2);
  assert.equal(stopped.upserted().length, 0);

  // Shutdown while waiting out the pause before a retry (simulated clock): the
  // wait ends, no retry, nothing written.
  const clock = new VirtualClock(Date.parse("2026-10-11T03:10:00Z"));
  const paused = overpassRig("ausflug-bw", () => httpResponse(504, "busy"), { clock });
  clock.setTimeout(() => {
    paused.kernel.shutdown.abort();
  }, 60_000);
  await clock.run(run(paused.ctx));
  assert.equal(paused.overpass().length, 1);
  assert.deepEqual(paused.pauses, [{ host: OVERPASS_HOST, ms: 120_000 }]);
  assert.equal(clock.now(), Date.parse("2026-10-11T03:11:00Z"), "the run waited beyond the shutdown");
  assert.equal(paused.upserted().length, 0);
}

function countOf(entities: readonly unknown[], id: string): number {
  const entity = entities.find((candidate) => isRecord(candidate) && candidate.id === id);
  assert.ok(isRecord(entity) && isRecord(entity.zielCount) && typeof entity.zielCount.value === "number");
  return entity.zielCount.value;
}

async function duplicatesAreCountedOnce(): Promise<void> {
  // A modified copy, not fixture data: the second answer repeats the first
  // ten elements of the first one (a way on a tile border comes back in
  // both), and one element is copied as a node with a new id at the same
  // place (same name and position).
  const elements = fixtureElements();
  const half = Math.ceil(elements.length / 2);
  const first = elements.slice(0, half);
  const second = elements.slice(half);
  const twin = first.find((element) => isRecord(element) && typeof element.id === "number");
  assert.ok(isRecord(twin) && typeof twin.id === "number");
  const copies = [
    ...structuredClone(first.slice(0, 10)),
    { ...structuredClone(twin), id: twin.id + 10_000_000_000 },
  ];
  const plain = await bothSides([
    { statusCode: 200, payload: { elements: first } },
    { statusCode: 200, payload: { elements: second } },
  ]);
  const doubled = await bothSides([
    { statusCode: 200, payload: { elements: first } },
    { statusCode: 200, payload: { elements: [...second, ...copies] } },
  ]);
  const now = new Date().toISOString();
  const once = build(parse(plain.parts), fixtureGeo(), now);
  const ported = build(parse(doubled.parts), fixtureGeo(), now);
  const legacy = emittedEntities(doubled.legacy);
  // Everything but the counts as in the old node: the list dedups by name anyway.
  assertEntitiesEqual(without(legacy, "zielCount"), without(ported, "zielCount", "counts"));
  assertEntitiesEqual(once, ported);
  let extra = 0;
  for (const entity of ported) {
    assert.equal(entity.zielCount.value, countOf(once, entity.id), `${entity.id}: a duplicate counted`);
    extra += countOf(legacy, entity.id) - entity.zielCount.value;
  }
  assert.ok(extra > 0, "the old node counted the repeated elements as well");
}

export {
  duplicatesAreCountedOnce as "ausflug-bw: zielCount and counts count an object in two answers once (deliberate)",
  requestsAreTheQuartersOfTheOldQuadrants as "ausflug-bw: selector and quadrants of the old request node, cut into 15 tiles with timeout 60 and maxsize 128 MiB (deliberate)",
  tilesCoverEveryMunicipality as "ausflug-bw: the 15 tiles cover every municipality of bw-grenzen.json, the left-out one none",
  wrapIsIdentical as "ausflug-bw: the wrap matches FN_AUSFLUG_WRAP on success, HTTP errors, non-JSON and no response; a remark fails the tile (deliberate)",
  joinedPartsAreIdentical as "ausflug-bw: old FN_AUSFLUG_BUILD and ported build() agree on joined parts with a failed tile",
  countsSumUpToZielCount as "ausflug-bw: counts per type are uncapped and sum up to zielCount (deliberate)",
  selectionEdgesAreIdentical as "ausflug-bw: top 25, duplicate and long names, apostrophes and labels as in the old node",
  nothingUsableWarns as "ausflug-bw: all tiles refused — six retries per run, warned per tile and once for the run, nothing written",
  runUpsertsWhatTheOldFlowSent as "ausflug-bw: run() upserts what the old flow sent, tiles strictly serialised and paced by the shared bucket",
  refusedTileIsRetriedAfterAPause as "ausflug-bw: a refused tile (fast 504, 429 with Retry-After) is retried after a pause of the shared bucket (deliberate)",
  failedTileKeepsItsMunicipalities as "ausflug-bw: a tile failed after its retries, or with a remark, keeps the municipalities it touches; inner ones are written (deliberate)",
  implausibleDropIsNotWritten as "ausflug-bw: a zielCount drop of more than 80 % from at least 20 is not written; a failed listing writes nothing (deliberate)",
  preconditionsSpendNoOverpassSlot as "ausflug-bw: no boundaries or a shutdown spend no further Overpass request",
};
