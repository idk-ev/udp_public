/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: wetter-bw — the old node chain `udp-rt-bw-*` (batch node, wrap node,
 * join 8 / 240 s, build node) against the ported module.
 *
 * Compared: the eight Open-Meteo URLs and `agsList`s of the batch node (both
 * daily variants), the master data it puts into the geo context, the `withDaily`
 * hour switch across both DST changes, and the upserted entities and their
 * chunking — on the recorded answer, on hand-made joined arrays for the build
 * node's skip branches, with failed batches (HTTP 500 and a network error), and
 * with a join that times out: a PARTIAL group first, the late batches as a
 * second group, as the old join node emitted them.
 *
 * Fixtures: test/fixtures/stammdaten-bw.json (its first 22 rows are the
 * municipalities) and test/fixtures/wetter-bw.json (one real Open-Meteo answer
 * for exactly those 22, split along the batches — see its `note`).
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
  withDailyAt,
  type WeatherObservedEntity,
} from "../../src/connectors/wetter-bw.js";
import { chunk } from "../../src/kernel/orion.js";
import { isArray } from "../../src/kernel/parse.js";
import type { MunicipalityRow } from "../../src/kernel/types.js";
import { readFixture } from "../harness/fixtures.js";
import {
  assertClockStamps,
  assertEntitiesEqual,
  isRecord,
  normalize,
  openClock,
} from "../harness/normalize.js";
import { evaluateSnippet, extractSnippet } from "../harness/vm-runner.js";
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
  withTimeZone,
  type LegacyAnswer,
  type LegacyBatch,
  type ScriptedAnswer,
} from "../harness/weather-ctx.js";

const NODES = { batch: "udp-rt-bw-batch", wrap: "udp-rt-bw-wrap", build: "udp-rt-bw-build" } as const;
const ROWS = 22;

/**
 * Two zones three hours apart flip `getHours() % 6 < 3` at every instant, so
 * the old batch node yields both variants without touching its clock.
 */
const DAILY_ZONES = ["UTC", "Etc/GMT-3"] as const;

function municipalitiesPayload(): Record<string, unknown> {
  const payload = readFixture("stammdaten-bw").payload;
  assert.ok(isRecord(payload) && Array.isArray(payload.gemeinden));
  return { ...payload, gemeinden: payload.gemeinden.slice(0, ROWS) };
}

function rows(): readonly MunicipalityRow[] {
  return parseMunicipalities(municipalitiesPayload()).gemeinden;
}

/** The recorded answer split along the 8 batches (sizes do not depend on withDaily). */
function batchBodies(): unknown[] {
  return splitAnswer(readFixture("wetter-bw").payload, planBatches(rows(), true));
}

function withDailyOf(batches: readonly LegacyBatch[]): boolean {
  return batches[0]?.msg.withDaily === true;
}

async function oldBatches(zone: string): Promise<Awaited<ReturnType<typeof legacyBatches>>> {
  return withTimeZone(zone, () =>
    legacyBatches(NODES.batch, { _msgid: "parity", statusCode: 200, payload: municipalitiesPayload() }),
  );
}

/** The old batch node's output for the given daily variant. */
async function oldBatchesWith(withDaily: boolean): Promise<LegacyBatch[]> {
  // Twice round, in case an hour boundary passes between two runs.
  for (const zone of [...DAILY_ZONES, ...DAILY_ZONES]) {
    const legacy = await oldBatches(zone);
    if (withDailyOf(legacy.batches) === withDaily) return legacy.batches;
  }
  throw new Error(`the old batch node never produced withDaily=${String(withDaily)}`);
}

function ok(payload: unknown): LegacyAnswer {
  return { statusCode: 200, payload };
}

const ALL = [0, 1, 2, 3, 4, 5, 6, 7] as const;

/* ------------------------------------------------------------------ batch node */

async function batchesAndGeoContextMatch(): Promise<void> {
  const expectedRows = rows();
  const variants = new Set<boolean>();
  for (const zone of DAILY_ZONES) {
    const legacy = await oldBatches(zone);
    assert.deepEqual(legacy.warnings, []);
    assert.equal(legacy.batches.length, 8, "22 municipalities are 8 batches of at most 3");
    const withDaily = withDailyOf(legacy.batches);
    variants.add(withDaily);

    assert.deepEqual(
      legacy.batches.map((batch) => [batch.url, batch.agsList, batch.msg.withDaily]),
      planBatches(expectedRows, withDaily).map((batch) => [batch.url, batch.agsList, batch.withDaily]),
      `batch URLs differ (withDaily ${String(withDaily)})`,
    );
    // global.set('bwGemeinden', g): the rows as they came, all nine columns.
    assert.deepEqual(normalize(legacy.global.get("bwGemeinden")), normalize(expectedRows));
  }
  assert.equal(variants.size, 2, "both daily variants were compared");
}

async function dailySwitchFollowsBerlinHours(): Promise<void> {
  // The expression itself, cut out of the node, against a frozen clock.
  const expression = extractSnippet(NODES.batch, "new Date().getHours()", "< 3");
  await withTimeZone("Europe/Berlin", () => {
    // Both DST changes of 2026 (29 March, 25 October), quarter-hour by quarter-hour.
    for (const day of ["2026-03-28T22:00:00Z", "2026-10-24T22:00:00Z"]) {
      for (let quarter = 0; quarter < 4 * 26; quarter += 1) {
        const instant = new Date(Date.parse(day) + quarter * 15 * 60_000).toISOString();
        class FixedDate extends Date {
          constructor() {
            super(instant);
          }
        }
        const legacy = evaluateSnippet("", { Date: FixedDate }, expression);
        assert.equal(withDailyAt(instant), legacy, `withDaily differs at ${instant}`);
      }
    }
  });
}

/* ------------------------------------------------------------------ build node */

async function fixtureChainIsIdentical(): Promise<void> {
  const bodies = batchBodies();
  for (const withDaily of [true, false]) {
    const batches = await oldBatchesWith(withDaily);
    const old = await legacyChain(NODES, batches, bodies.map(ok), ALL);
    const parts = planBatches(rows(), withDaily).map(
      (batch, index) => partOf(batch, { ok: true, body: bodies[index] }).part,
    );
    const ported = build({ parts, malformed: 0 }, null, new Date().toISOString());

    assert.deepEqual([...old.wrapWarnings, ...old.warnings], []);
    assert.equal(ported.length, ROWS);
    assertEntitiesEqual(old.chunks.flat(), ported);
    assert.deepEqual(
      old.chunks.map((part) => part.length),
      chunk(ported, UPSERT_CHUNK_SIZE).map((part) => part.length),
    );
    assert.equal("tempMax" in (ported[0] ?? {}), withDaily, "daily values follow withDaily");
  }
}

async function skipBranchesOfTheBuildNode(): Promise<void> {
  // A hand-made joined array: every `continue`/`return` of the build node,
  // next to real locations of the fixture.
  const recorded = readFixture("wetter-bw").payload;
  assert.ok(isArray(recorded));
  const [a, b, c]: readonly unknown[] = recorded;
  const withoutDaily = isRecord(b) ? { ...b, daily: undefined } : b;
  const joined: unknown[] = [
    null,
    { data: [a] },
    { agsList: ["08000001", "08000002"], data: [] }, // failed batch, as the wrap node wrote it
    {
      agsList: ["08000003"],
      withDaily: true,
      data: ["RequestError: socket hang up : https://api.open-meteo.com"],
    },
    {
      agsList: ["08000004", "08000005", "08000006"],
      withDaily: true,
      data: [a, { current: null }, withoutDaily],
    },
    { agsList: ["08000007", "08000008"], withDaily: false, data: [c] },
  ];
  const old = await legacyBuild(NODES.build, joined);
  const ported = build(parse(joined), null, new Date().toISOString());
  assertEntitiesEqual(old.chunks.flat(), ported);
  assert.deepEqual(
    ported.map((entity) => entity.id),
    [
      "urn:ngsi-ld:WeatherObserved:bw-08000004",
      "urn:ngsi-ld:WeatherObserved:bw-08000006",
      "urn:ngsi-ld:WeatherObserved:bw-08000007",
    ],
  );
}

async function nothingLeftWarnsOnBothSides(): Promise<void> {
  const joined = [{ agsList: ["08000001"], data: [] }];
  const old = await legacyBuild(NODES.build, joined);
  assert.deepEqual(old.chunks, []);
  assert.deepEqual(old.warnings, ["BW-Wetter: keine Entitäten"]);
  assert.deepEqual(build(parse(joined), null, new Date().toISOString()), []);
}

function malformedLocationIsCountedNotWritten(): void {
  // Deliberate difference (module comment): the old node would have sent the
  // string as a temperature; the port drops the location and counts it.
  const recorded = readFixture("wetter-bw").payload;
  assert.ok(isArray(recorded));
  const [first, second]: readonly unknown[] = recorded;
  assert.ok(isRecord(first) && isRecord(first.current));
  const broken = { ...first, current: { ...first.current, temperature_2m: "warm" } };
  const parsed = parse([{ agsList: ["08000001", "08000002"], withDaily: true, data: [broken, second] }]);
  assert.equal(parsed.malformed, 1);
  assert.deepEqual(
    build(parsed, null, new Date().toISOString()).map((entity) => entity.id),
    ["urn:ngsi-ld:WeatherObserved:bw-08000002"],
  );
}

async function aDriftedValueFailsTheComparison(): Promise<void> {
  // The proof that this comparison can fail at all.
  const bodies = batchBodies();
  const old = await legacyChain(NODES, await oldBatchesWith(true), bodies.map(ok), ALL);
  const parts = planBatches(rows(), true).map(
    (batch, index) => partOf(batch, { ok: true, body: bodies[index] }).part,
  );
  const drifted = build({ parts, malformed: 0 }, null, new Date().toISOString()).map<WeatherObservedEntity>(
    (entity, index) =>
      index === 4 ? { ...entity, windDirection: { ...entity.windDirection, unitCode: "DEG" } } : entity,
  );
  assert.throws(
    () => {
      assertEntitiesEqual(old.chunks.flat(), drifted);
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /1 difference\(s\), first at \[4\]\.windDirection\.unitCode/);
      assert.match(error.message, /"DD" vs new \(build\) "DEG"/);
      return true;
    },
  );
}

/* ------------------------------------------------------------------ run */

async function runPacesAndWritesWhatTheOldChainWrote(): Promise<void> {
  const bodies = batchBodies();
  const network = openMeteoNetwork(municipalitiesPayload(), (index) => jsonAnswer(200, bodies[index]));
  const { ctx, kernel, log } = weatherCtx("wetter-bw", network.fetcher);
  const portClock = openClock();
  await runWith(ctx, { count: 8, timeoutMs: 5_000 });
  const portWindow = portClock.close();

  const calls = openMeteoCalls(network.seen);
  const withDaily = calls[0]?.url.includes("&daily=") === true;
  assert.deepEqual(
    calls.map((call) => call.url),
    planBatches(rows(), withDaily).map((batch) => batch.url),
    "the port requests its batches in batch order",
  );
  for (const call of calls) {
    const options = call.options;
    assert.ok(options !== undefined);
    assert.equal(options.minIntervalMs, REQUEST_INTERVAL_MS, "one Open-Meteo call per 15 s");
    assert.equal(options.timeoutMs, REQUEST_TIMEOUT_MS, "the 120 s of the http request node");
    assert.equal(options.retries, 0, "no retry against a provider that sent 429");
  }

  const legacyClock = openClock();
  const old = await legacyChain(NODES, await oldBatchesWith(withDaily), bodies.map(ok), ALL);
  const legacyWindow = legacyClock.close();
  const upserts = upsertedBatches(network.seen);
  assert.deepEqual(
    upserts.map((part) => part.length),
    old.chunks.map((part) => part.length),
  );
  assertEntitiesEqual(old.chunks.flat(), upserts.flat());
  assertClockStamps(old.chunks.flat(), upserts.flat(), { legacy: legacyWindow, ported: portWindow });
  assert.deepEqual(log.warnings(), []);
  // global.set('bwGemeinden', g) -> the geo context.
  assert.deepEqual(normalize(kernel.geo.municipalities), normalize(rows()));
}

async function failedBatchesAreSkippedAsBefore(): Promise<void> {
  const bodies = batchBodies();
  const failures = new Map<number, ScriptedAnswer>([
    [2, { response: { status: 500, ok: false, headers: {}, body: "busy" } }],
    [5, { response: new Error("socket hang up") }],
  ]);
  const network = openMeteoNetwork(
    municipalitiesPayload(),
    (index) => failures.get(index) ?? jsonAnswer(200, bodies[index]),
  );
  const { ctx, log } = weatherCtx("wetter-bw", network.fetcher);
  await runWith(ctx, { count: 8, timeoutMs: 5_000 });
  const withDaily = openMeteoCalls(network.seen)[0]?.url.includes("&daily=") === true;

  // The old side: a 500 reached the wrap node as status and body; a network
  // error as `err.code` and `err.toString() + " : " + url` (21-httprequest.js).
  const batches = await oldBatchesWith(withDaily);
  const answers = bodies.map(ok);
  answers[2] = { statusCode: 500, payload: "busy" };
  answers[5] = {
    statusCode: "ECONNRESET",
    payload: `RequestError: socket hang up : ${batches[5]?.url ?? ""}`,
  };
  const old = await legacyChain(NODES, batches, answers, ALL);

  assert.deepEqual(old.wrapWarnings, ["Open-Meteo-Batch fehlgeschlagen (500)"]);
  const upserts = upsertedBatches(network.seen);
  assert.equal(upserts.flat().length, ROWS - 6, "two batches of three municipalities are missing");
  assertEntitiesEqual(old.chunks.flat(), upserts.flat());
  assert.deepEqual(log.warnings(), ["Open-Meteo batch failed (HTTP 500)"]);
  assert.equal(
    log.lines.filter((line) => line.level === "error").length,
    1,
    "the network error is an error line",
  );
}

async function joinTimeoutWritesPartialThenLate(): Promise<void> {
  // Batches 5–7 answer after the join timeout: the old join emitted the five it
  // had, and the three late ones opened a group of their own.
  const bodies = batchBodies();
  const network = openMeteoNetwork(municipalitiesPayload(), (index) =>
    jsonAnswer(200, bodies[index], index >= 5 ? 400 : 0),
  );
  const { ctx, log } = weatherCtx("wetter-bw", network.fetcher);
  await runWith(ctx, { count: 8, timeoutMs: 100 });
  const withDaily = openMeteoCalls(network.seen)[0]?.url.includes("&daily=") === true;

  const batches = await oldBatchesWith(withDaily);
  const partial = await legacyChain(NODES, batches, bodies.map(ok), [0, 1, 2, 3, 4]);
  const late = await legacyChain(NODES, batches, bodies.map(ok), [5, 6, 7]);
  const upserts = upsertedBatches(network.seen);

  assert.equal(upserts.length, 2, "two groups, two upserts");
  assertEntitiesEqual(partial.chunks.flat(), upserts[0]);
  assertEntitiesEqual(late.chunks.flat(), upserts[1]);
  assert.deepEqual(
    upserts.map((part) => part.length),
    [15, 7],
  );
  const warnings = log.warnings();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /join timeout after 0\.1 s — writing a partial result of 5\/8 batches/);
}

async function shutdownDropsTheOpenGroup(): Promise<void> {
  // Node-RED's join drops its in-flight groups on close; so does the port.
  const bodies = batchBodies();
  const network = openMeteoNetwork(municipalitiesPayload(), (index) =>
    jsonAnswer(200, bodies[index], index >= 5 ? 300 : 0),
  );
  const { ctx, kernel, log } = weatherCtx("wetter-bw", network.fetcher);
  setTimeout(() => {
    kernel.shutdown.abort();
  }, 50);
  await runWith(ctx, { count: 8, timeoutMs: 10_000 });
  assert.deepEqual(upsertedBatches(network.seen), []);
  assert.deepEqual(log.warnings(), ["BW weather: shutdown — 5 fetched batches not written"]);
}

async function unreadableMunicipalitiesStopTheRun(): Promise<void> {
  const legacy = await legacyBatches(NODES.batch, {
    _msgid: "parity",
    statusCode: 404,
    payload: "not found",
  });
  assert.deepEqual(legacy.batches, []);
  assert.deepEqual(legacy.warnings, ["BW-Wetter: bw-gemeinden.json nicht ladbar (404)"]);

  const network = openMeteoNetwork(null, () => jsonAnswer(200, []), {
    response: { status: 404, ok: false, headers: {}, body: "not found" },
  });
  const { ctx, log } = weatherCtx("wetter-bw", network.fetcher);
  await runWith(ctx, { count: 8, timeoutMs: 5_000 });
  assert.deepEqual(openMeteoCalls(network.seen), []);
  assert.deepEqual(log.warnings(), ["BW weather: bw-gemeinden.json not loadable (HTTP 404)"]);
}

export {
  batchesAndGeoContextMatch as "wetter-bw: old batch node and planBatches() build identical URLs and fill the geo context identically",
  dailySwitchFollowsBerlinHours as "wetter-bw: withDailyAt() matches `getHours() % 6 < 3` under TZ=Europe/Berlin across both DST changes",
  fixtureChainIsIdentical as "wetter-bw: old batch/wrap/build chain and the port produce identical entities and chunks on the recorded answer",
  skipBranchesOfTheBuildNode as "wetter-bw: failed batches, error text and locations without values are skipped as in the old build node",
  nothingLeftWarnsOnBothSides as "wetter-bw: a join without usable locations yields no entities on both sides",
  malformedLocationIsCountedNotWritten as "wetter-bw: a malformed location is counted and dropped (deliberate difference)",
  aDriftedValueFailsTheComparison as "wetter-bw: a single drifted unit code fails the comparison and names its path",
  runPacesAndWritesWhatTheOldChainWrote as "wetter-bw: run() paces its calls (15 s, 120 s, no retry) and upserts what the old chain wrote",
  failedBatchesAreSkippedAsBefore as "wetter-bw: an HTTP 500 and a network error cost their batch only, as in the old chain",
  joinTimeoutWritesPartialThenLate as "wetter-bw: a join timeout writes the partial group, the late batches follow as a second group",
  shutdownDropsTheOpenGroup as "wetter-bw: a shutdown drops the open join group, as Node-RED's join did on close",
  unreadableMunicipalitiesStopTheRun as "wetter-bw: an unreadable bw-gemeinden.json stops the run on both sides",
};
