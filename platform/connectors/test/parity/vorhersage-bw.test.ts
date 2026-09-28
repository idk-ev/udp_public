/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: vorhersage-bw — the old node chain `udp-rt-bv-*` (batch node, wrap
 * node, join 8 / 240 s, build node) against the ported module.
 *
 * Compared: the eight Open-Meteo URLs and `agsList`s of the batch node, and the
 * upserted entities and their chunking — on the recorded answer, on hand-made
 * joined arrays for the build node's skip and optional-attribute branches, with
 * failed batches, and with a join that times out (partial group first, the late
 * batches as a second group).
 *
 * Fixtures: test/fixtures/stammdaten-bw.json (its first 22 rows are the
 * municipalities) and test/fixtures/vorhersage-bw.json (one real Open-Meteo
 * answer for exactly those 22, split along the batches — see its `note`).
 */

import assert from "node:assert/strict";
import {
  REQUEST_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  UPSERT_CHUNK_SIZE,
} from "../../src/connectors/open-meteo-batches.js";
import { parse as parseMunicipalities } from "../../src/connectors/stammdaten-bw.js";
import {
  build,
  parse,
  partOf,
  planBatches,
  runWith,
  type WeatherForecastEntity,
} from "../../src/connectors/vorhersage-bw.js";
import { chunk } from "../../src/kernel/orion.js";
import type { MunicipalityRow } from "../../src/kernel/types.js";
import { readFixture } from "../harness/fixtures.js";
import { assertEntitiesEqual, isRecord, normalize } from "../harness/normalize.js";
import {
  jsonAnswer,
  legacyBatches,
  legacyBuild,
  legacyChain,
  openMeteoCalls,
  openMeteoNetwork,
  splitAnswer,
  upsertedBatches,
  weatherCtx,
  type LegacyAnswer,
  type LegacyBatch,
  type ScriptedAnswer,
} from "../harness/weather-ctx.js";

const NODES = { batch: "udp-rt-bv-batch", wrap: "udp-rt-bv-wrap", build: "udp-rt-bv-build" } as const;
const ROWS = 22;
const ALL = [0, 1, 2, 3, 4, 5, 6, 7] as const;

function municipalitiesPayload(): Record<string, unknown> {
  const payload = readFixture("stammdaten-bw").payload;
  assert.ok(isRecord(payload) && Array.isArray(payload.gemeinden));
  return { ...payload, gemeinden: payload.gemeinden.slice(0, ROWS) };
}

function rows(): readonly MunicipalityRow[] {
  return parseMunicipalities(municipalitiesPayload()).gemeinden;
}

function recorded(): unknown[] {
  const payload = readFixture("vorhersage-bw").payload;
  assert.ok(Array.isArray(payload));
  return payload;
}

function batchBodies(): unknown[] {
  return splitAnswer(recorded(), planBatches(rows()));
}

async function oldBatches(): Promise<LegacyBatch[]> {
  const legacy = await legacyBatches(NODES.batch, {
    _msgid: "parity",
    statusCode: 200,
    payload: municipalitiesPayload(),
  });
  assert.deepEqual(legacy.warnings, []);
  return legacy.batches;
}

function ok(payload: unknown): LegacyAnswer {
  return { statusCode: 200, payload };
}

function ported(bodies: readonly unknown[]): readonly WeatherForecastEntity[] {
  const parts = planBatches(rows()).map(
    (batch, index) => partOf(batch, { ok: true, body: bodies[index] }).part,
  );
  return build({ parts, malformed: 0 }, null, new Date().toISOString());
}

/* ------------------------------------------------------------------ batch node */

async function batchesMatch(): Promise<void> {
  const legacy = await legacyBatches(NODES.batch, {
    _msgid: "parity",
    statusCode: 200,
    payload: municipalitiesPayload(),
  });
  assert.equal(legacy.batches.length, 8);
  assert.deepEqual(
    legacy.batches.map((batch) => [batch.url, batch.agsList]),
    planBatches(rows()).map((batch) => [batch.url, batch.agsList]),
  );
  // Unlike wetter-bw, this batch node leaves the geo context alone.
  assert.equal(legacy.global.size, 0);
}

/* ------------------------------------------------------------------ build node */

async function fixtureChainIsIdentical(): Promise<void> {
  const bodies = batchBodies();
  const old = await legacyChain(NODES, await oldBatches(), bodies.map(ok), ALL);
  const entities = ported(bodies);

  assert.deepEqual([...old.wrapWarnings, ...old.warnings], []);
  assert.equal(entities.length, ROWS);
  assertEntitiesEqual(old.chunks.flat(), entities);
  assert.deepEqual(
    old.chunks.map((part) => part.length),
    chunk(entities, UPSERT_CHUNK_SIZE).map((part) => part.length),
  );
  // The recording carries every optional attribute; the branches without them
  // are pinned below.
  assert.ok(
    entities.every((entity) => entity.sunrise !== undefined && entity.apparentTemperature !== undefined),
  );
}

async function skipAndOptionalBranches(): Promise<void> {
  const [a, b, c, d]: unknown[] = recorded();
  assert.ok(isRecord(a) && isRecord(b) && isRecord(c) && isRecord(d) && isRecord(d.daily));
  const joined: unknown[] = [
    null,
    { data: [a] },
    { agsList: ["08000001", "08000002"], data: [] }, // failed batch, as the wrap node wrote it
    { agsList: ["08000003"], data: ["RequestError: socket hang up : https://api.open-meteo.com"] },
    {
      agsList: ["08000004", "08000005", "08000006", "08000007", "08000008"],
      data: [
        { ...a, daily: { ...d.daily, time: [] } }, // no days -> skipped
        { ...b, current: undefined }, // no current -> no apparentTemperature / uvIndex
        { ...c, current: { apparent_temperature: null, uv_index: 0 } }, // null omitted, 0 kept
        { ...d, daily: { ...d.daily, weather_code: undefined, sunrise: [], sunset: [""] } },
        a,
      ],
    },
  ];
  const old = await legacyBuild(NODES.build, joined);
  const entities = build(parse(joined), null, new Date().toISOString());
  // Compared as the JSON bodies that reach Orion. The one place where the
  // objects differ before serialisation: without `weather_code`, the old node
  // put `undefined` into the day tuple (`(dl.weather_code || [])[j]`), which
  // JSON writes as `null` inside an array; the port writes `null` directly.
  assert.throws(() => {
    assertEntitiesEqual(old.chunks.flat(), entities);
  }, /4 difference\(s\), first at \[2\]\.days\.value\[0\]\[6\] — old \(Node-RED function node\) <undefined> vs new \(build\) null/);
  assertEntitiesEqual(wire(old.chunks.flat()), wire(entities));
  assert.deepEqual(
    entities.map((entity) => entity.id),
    [
      "urn:ngsi-ld:WeatherForecast:bw-08000005",
      "urn:ngsi-ld:WeatherForecast:bw-08000006",
      "urn:ngsi-ld:WeatherForecast:bw-08000007",
      "urn:ngsi-ld:WeatherForecast:bw-08000008",
    ],
  );
}

/** What `JSON.stringify` puts on the wire, parsed back. */
function wire(value: unknown): unknown {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return parsed;
}

async function nothingLeftWarnsOnBothSides(): Promise<void> {
  const joined = [{ agsList: ["08000001"], data: [] }];
  const old = await legacyBuild(NODES.build, joined);
  assert.deepEqual(old.chunks, []);
  assert.deepEqual(old.warnings, ["BW-Vorhersage: keine Entitäten"]);
  assert.deepEqual(build(parse(joined), null, new Date().toISOString()), []);
}

function malformedLocationIsCountedNotWritten(): void {
  // Deliberate difference: a one-day series would have sent `undefined` as
  // tomorrow's values; the port drops the location and counts it.
  const [a, b]: unknown[] = recorded();
  assert.ok(isRecord(a) && isRecord(a.daily));
  const oneDay = {
    ...a,
    daily: Object.fromEntries(
      Object.entries(a.daily).map(([key, value]) => [key, Array.isArray(value) ? value.slice(0, 1) : value]),
    ),
  };
  const parsed = parse([{ agsList: ["08000001", "08000002"], data: [oneDay, b] }]);
  assert.equal(parsed.malformed, 1);
  assert.deepEqual(
    build(parsed, null, new Date().toISOString()).map((entity) => entity.id),
    ["urn:ngsi-ld:WeatherForecast:bw-08000002"],
  );
}

async function aDriftedDayFailsTheComparison(): Promise<void> {
  const bodies = batchBodies();
  const old = await legacyChain(NODES, await oldBatches(), bodies.map(ok), ALL);
  const drifted = ported(bodies).map<WeatherForecastEntity>((entity, index) => {
    if (index !== 7) return entity;
    const [first, ...rest] = entity.days.value;
    assert.ok(first !== undefined);
    const [date, min, max, rain, wind, uv] = first;
    return { ...entity, days: { ...entity.days, value: [[date, min, max, rain, wind, uv, 99], ...rest] } };
  });
  assert.throws(
    () => {
      assertEntitiesEqual(old.chunks.flat(), drifted);
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /1 difference\(s\), first at \[7\]\.days\.value\[0\]\[6\]/);
      return true;
    },
  );
}

/* ------------------------------------------------------------------ run */

async function runPacesAndWritesWhatTheOldChainWrote(): Promise<void> {
  const bodies = batchBodies();
  const network = openMeteoNetwork(municipalitiesPayload(), (index) => jsonAnswer(200, bodies[index]));
  const { ctx, kernel, log } = weatherCtx("vorhersage-bw", network.fetcher);
  await runWith(ctx, { count: 8, timeoutMs: 5_000 });

  const calls = openMeteoCalls(network.seen);
  assert.deepEqual(
    calls.map((call) => call.url),
    planBatches(rows()).map((batch) => batch.url),
  );
  for (const call of calls) {
    const options = call.options;
    assert.ok(options !== undefined);
    assert.equal(options.minIntervalMs, REQUEST_INTERVAL_MS, "one Open-Meteo call per 15 s");
    assert.equal(options.timeoutMs, REQUEST_TIMEOUT_MS);
    assert.equal(options.retries, 0);
  }
  const old = await legacyChain(NODES, await oldBatches(), bodies.map(ok), ALL);
  const upserts = upsertedBatches(network.seen);
  assert.deepEqual(
    upserts.map((part) => part.length),
    old.chunks.map((part) => part.length),
  );
  assertEntitiesEqual(old.chunks.flat(), upserts.flat());
  assert.deepEqual(log.warnings(), []);
  assert.equal(kernel.geo.municipalities, null, "vorhersage-bw does not touch the geo context");
}

async function failedBatchesAreSkippedAsBefore(): Promise<void> {
  const bodies = batchBodies();
  const failures = new Map<number, ScriptedAnswer>([
    [0, { response: { status: 429, ok: false, headers: {}, body: "Too many requests" } }],
    [7, { response: new Error("socket hang up") }],
  ]);
  const network = openMeteoNetwork(
    municipalitiesPayload(),
    (index) => failures.get(index) ?? jsonAnswer(200, bodies[index]),
  );
  const { ctx, log } = weatherCtx("vorhersage-bw", network.fetcher);
  await runWith(ctx, { count: 8, timeoutMs: 5_000 });

  const batches = await oldBatches();
  const answers = bodies.map(ok);
  answers[0] = { statusCode: 429, payload: "Too many requests" };
  answers[7] = {
    statusCode: "ECONNRESET",
    payload: `RequestError: socket hang up : ${batches[7]?.url ?? ""}`,
  };
  const old = await legacyChain(NODES, batches, answers, ALL);

  assert.deepEqual(old.wrapWarnings, ["Open-Meteo-Batch fehlgeschlagen (429)"]);
  const upserts = upsertedBatches(network.seen);
  assert.equal(upserts.flat().length, ROWS - 3 - 1, "the first batch (3) and the last (1) are missing");
  assertEntitiesEqual(old.chunks.flat(), upserts.flat());
  assert.deepEqual(log.warnings(), ["Open-Meteo batch failed (HTTP 429)"]);
}

async function joinTimeoutWritesPartialThenLate(): Promise<void> {
  // Batch 1 hangs past the join timeout: the other seven go out first, in
  // arrival order, and batch 1 follows alone.
  const bodies = batchBodies();
  const network = openMeteoNetwork(municipalitiesPayload(), (index) =>
    jsonAnswer(200, bodies[index], index === 1 ? 400 : 0),
  );
  const { ctx, log } = weatherCtx("vorhersage-bw", network.fetcher);
  await runWith(ctx, { count: 8, timeoutMs: 100 });

  const batches = await oldBatches();
  const partial = await legacyChain(NODES, batches, bodies.map(ok), [0, 2, 3, 4, 5, 6, 7]);
  const late = await legacyChain(NODES, batches, bodies.map(ok), [1]);
  const upserts = upsertedBatches(network.seen);
  assert.equal(upserts.length, 2);
  assertEntitiesEqual(partial.chunks.flat(), upserts[0]);
  assertEntitiesEqual(late.chunks.flat(), upserts[1]);
  assert.deepEqual(normalize(upserts.map((part) => part.length)), [19, 3]);
  const warnings = log.warnings();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /join timeout after 0\.1 s — writing a partial result of 7\/8 batches/);
}

export {
  batchesMatch as "vorhersage-bw: old batch node and planBatches() build identical URLs",
  fixtureChainIsIdentical as "vorhersage-bw: old batch/wrap/build chain and the port produce identical entities and chunks on the recorded answer",
  skipAndOptionalBranches as "vorhersage-bw: skipped locations and omitted optional attributes match the old build node",
  nothingLeftWarnsOnBothSides as "vorhersage-bw: a join without usable locations yields no entities on both sides",
  malformedLocationIsCountedNotWritten as "vorhersage-bw: a malformed location is counted and dropped (deliberate difference)",
  aDriftedDayFailsTheComparison as "vorhersage-bw: a single drifted weather code fails the comparison and names its path",
  runPacesAndWritesWhatTheOldChainWrote as "vorhersage-bw: run() paces its calls and upserts what the old chain wrote",
  failedBatchesAreSkippedAsBefore as "vorhersage-bw: an HTTP 429 and a network error cost their batch only, as in the old chain",
  joinTimeoutWritesPartialThenLate as "vorhersage-bw: a join timeout writes the partial group, the late batch follows as a second group",
};
