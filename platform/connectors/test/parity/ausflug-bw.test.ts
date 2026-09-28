/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: ausflug-bw — FN_AUSFLUG_REQ (`udp-rt-az-req`), FN_AUSFLUG_WRAP
 * (`udp-rt-az-wrap`) and FN_AUSFLUG_BUILD (`udp-rt-az-build`) against the
 * ported module and the shared Overpass helper.
 *
 * Compared: the four quadrant URLs byte for byte; the wrap on success, HTTP
 * error, a non-JSON body and no response; the entities of the build node on
 * the joined parts against `build()`, and against what `run()` upserts through
 * the real kernel. The joined payload is the real answer cut into four parts
 * in answer order, one of them failed — the join's partial result.
 *
 * The top-25 rule (first 25 distinct cut names, `zielCount` over all hits) is
 * exercised by the real data — two fixture municipalities have more than 25
 * hits — and on a modified copy with duplicate, long and apostrophe names.
 *
 * Fixture: test/fixtures/ausflug-bw.json (see its note), against
 * test/fixtures/grenzen-bw.json.
 */

import assert from "node:assert/strict";
import { build, parse, QUERIES, run } from "../../src/connectors/ausflug-bw.js";
import {
  OVERPASS_MIN_INTERVAL_MS,
  OVERPASS_TIMEOUT_MS,
  OVERPASS_USER_AGENT,
  wrapPart,
} from "../../src/connectors/overpass.js";
import type { OverpassResponse, RawPart } from "../../src/connectors/overpass.js";
import { chunk } from "../../src/kernel/orion.js";
import { readFixture } from "../harness/fixtures.js";
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

const REQUEST_NODE = "udp-rt-az-req";
const WRAP_NODE = "udp-rt-az-wrap";
const BUILD_NODE = "udp-rt-az-build";
const FIXTURE = "ausflug-bw";
const CHUNK_SIZE = 100;

function fixtureElements(): unknown[] {
  const payload = readFixture(FIXTURE).payload;
  const elements = isRecord(payload) ? payload.elements : undefined;
  assert.ok(Array.isArray(elements));
  return elements;
}

/** The answer cut into `count` consecutive parts, as Overpass bodies. */
function slices(elements: readonly unknown[], count: number): unknown[] {
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
  return { status, body: parsed ? answer.payload : undefined, detail: "" };
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
    const kind = `Q${String(index + 1)}`;
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

async function requestsAreIdentical(): Promise<void> {
  const run = await runFunctionNode(REQUEST_NODE, { msg: { _msgid: "parity", payload: 0 } });
  const returned: unknown = Array.isArray(run.returned) ? run.returned[0] : undefined;
  assert.ok(Array.isArray(returned));
  assert.deepEqual(
    normalize(returned.map((msg: unknown) => (isRecord(msg) ? [msg.kind, msg.url] : null))),
    QUERIES.map((query) => [query.kind, query.url]),
    "quadrant URLs differ",
  );
  for (const msg of returned) {
    assert.ok(isRecord(msg));
    assert.deepEqual(normalize(msg.headers), { "User-Agent": OVERPASS_USER_AGENT });
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
  assertEntitiesEqual(emittedEntities(legacy), entities);
  assert.deepEqual(
    emittedChunkSizes(legacy),
    [...chunk(entities, CHUNK_SIZE)].map((part) => part.length),
  );
  assert.deepEqual(normalize(legacy.status), [{ text: "8 Gemeinden · Quellen: Q1,Q2,Q4" }]);

  // What the fixture must keep exercising: the cap and destinations of ways/relations.
  const capped = entities.filter((entity) => entity.zielCount.value > 25);
  assert.equal(capped.length, 2, "two municipalities with more than 25 hits");
  for (const entity of capped) assert.equal(entity.ziele.value.length, 25);
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
  assertEntitiesEqual(emittedEntities(legacy), entities);
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

  const rig = overpassRig("ausflug-bw", () => httpResponse(504, "busy"));
  await run(rig.ctx);
  assert.deepEqual(rig.log.warnings(), [
    "Overpass Q1: empty or failed (HTTP 504)",
    "Overpass Q2: empty or failed (HTTP 504)",
    "Overpass Q3: empty or failed (HTTP 504)",
    "Overpass Q4: empty or failed (HTTP 504)",
    "Overpass tourist destinations: no entities (sources ok: )",
  ]);
  assert.equal(rig.upserted().length, 0);
}

async function runUpsertsWhatTheOldFlowSent(): Promise<void> {
  const bodies = slices(fixtureElements(), 4);
  const answers: Answer[] = bodies.map((payload, index) =>
    index === 1 ? { statusCode: 429, payload: "rate_limited" } : { statusCode: 200, payload },
  );
  const { legacy } = await bothSides(answers);
  const rig = overpassRig("ausflug-bw", (_url, index) =>
    index === 1 ? httpResponse(429, "rate_limited") : overpassAnswer(bodies[index]),
  );
  await run(rig.ctx);

  assertEntitiesEqual(emittedEntities(legacy), rig.upserted(), {
    labels: { left: "old (Node-RED flow)", right: "new (run → Orion)" },
  });
  assert.deepEqual(rig.upsertSizes(), emittedChunkSizes(legacy));
  assert.deepEqual(rig.log.warnings(), ["Overpass Q2: empty or failed (HTTP 429)"]);

  // Strictly serialised, in quadrant order, each paced, no retries.
  assert.deepEqual(
    rig.overpass().map((request) => request.url),
    QUERIES.map((query) => query.url),
  );
  assert.equal(rig.maxInFlight(), 1, "Overpass requests overlapped");
  for (const request of rig.overpass()) {
    assert.deepEqual(normalize(request.options), {
      minIntervalMs: OVERPASS_MIN_INTERVAL_MS,
      retries: 0,
      timeoutMs: OVERPASS_TIMEOUT_MS,
      userAgent: OVERPASS_USER_AGENT,
    });
  }
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
}

export {
  requestsAreIdentical as "ausflug-bw: the four quadrant URLs and the User-Agent are those of the old request node",
  wrapIsIdentical as "ausflug-bw: the wrap matches FN_AUSFLUG_WRAP on success, HTTP errors, non-JSON and no response",
  joinedPartsAreIdentical as "ausflug-bw: old FN_AUSFLUG_BUILD and ported build() agree on joined parts with a failed tile",
  selectionEdgesAreIdentical as "ausflug-bw: top 25, duplicate and long names, apostrophes and labels as in the old node",
  nothingUsableWarns as "ausflug-bw: all tiles failed — warned per tile and once for the run, nothing written",
  runUpsertsWhatTheOldFlowSent as "ausflug-bw: run() upserts what the old flow sent, tiles strictly serialised and paced",
  preconditionsSpendNoOverpassSlot as "ausflug-bw: no boundaries or a shutdown spend no further Overpass request",
};
