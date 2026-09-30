/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: hitze-bw — FN_HITZE (`udp-rt-hz-fn`) against the ported module.
 *
 * Compared: the entities on the recorded DWD answer (five BW cities kept, five
 * others skipped), the level/rank branches on a modified copy (missing
 * forecast, unknown level, `hoch`/`extrem`, an umlaut city slug), run() against
 * the old node's output, and the three guard branches.
 *
 * DELIBERATE DEVIATION (module header): the entities carry `forecastDay`
 * (`forecast_day` of the file) and `dateObserved` is the file's `last_update`
 * instead of the run time. {@link withForecastDay} applies both to the old
 * node's entities before every comparison; {@link forecastDayIsWritten} pins
 * them.
 *
 * Fixture: test/fixtures/hitze-bw.json — the real `gt.json`, trimmed to ten
 * cities as described in its `note`.
 */

import assert from "node:assert/strict";
import {
  berlinLocalToIso,
  build,
  parse,
  run,
  slugOf,
  type HeatHealthWarningEntity,
} from "../../src/connectors/hitze-bw.js";
import { messageFromFixture, readFixture } from "../harness/fixtures.js";
import {
  assertClockStamps,
  assertEntitiesEqual,
  isRecord,
  normalize,
  openClock,
} from "../harness/normalize.js";
import { evaluateSnippet, extractSnippet, runFunctionNode, solePayload } from "../harness/vm-runner.js";
import { jsonAnswer, upsertedBatches, weatherCtx, weatherFetcher } from "../harness/weather-ctx.js";

const NODE_ID = "udp-rt-hz-fn";
const FIXTURE = "hitze-bw";

async function legacyOn(
  payload: unknown,
  statusCode = 200,
): Promise<Awaited<ReturnType<typeof runFunctionNode>>> {
  const fixture = readFixture(FIXTURE);
  return runFunctionNode(NODE_ID, {
    msg: { ...messageFromFixture(fixture), statusCode, payload: structuredClone(payload) },
  });
}

/** The old node's entities with the deliberate fix: `forecastDay`, and `dateObserved` from the file. */
function withForecastDay(legacy: unknown, payload: unknown): unknown {
  if (!Array.isArray(legacy)) return legacy;
  const { forecastDay, issuedAt } = parse(payload);
  return legacy.map((entity: unknown) => {
    if (!isRecord(entity)) return entity;
    const fixed: Record<string, unknown> = { ...entity };
    if (forecastDay !== null) fixed.forecastDay = { type: "Property", value: forecastDay };
    if (issuedAt !== null)
      fixed.dateObserved = { type: "Property", value: { "@type": "DateTime", "@value": issuedAt } };
    return fixed;
  });
}

function ported(payload: unknown): readonly HeatHealthWarningEntity[] {
  return build(parse(payload), null, new Date().toISOString());
}

async function fixtureIsIdentical(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const legacy = await legacyOn(fixture.payload);
  const entities = ported(fixture.payload);

  assert.deepEqual(legacy.warnings, []);
  assert.deepEqual(normalize(legacy.status), [{ text: "5 Vertreterstädte" }]);
  assert.deepEqual(
    entities.map((entity) => entity.id),
    ["konstanz", "mannheim", "ulm", "stuttgart", "freiburg"].map(
      (slug) => `urn:ngsi-ld:HeatHealthWarning:bw-${slug}`,
    ),
    "BW cities in source order, the others skipped",
  );
  assertEntitiesEqual(withForecastDay(solePayload(legacy), fixture.payload), entities);
}

async function forecastDayIsWritten(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  // Recorded: forecast_day 2026-09-27, last_update 2026-09-27T07:30:00 (summer time).
  for (const entity of ported(fixture.payload)) {
    assert.equal(entity.forecastDay?.value, "2026-09-27");
    assert.deepEqual(entity.dateObserved.value, {
      "@type": "DateTime",
      "@value": "2026-09-27T05:30:00.000Z",
    });
  }
  assert.equal(berlinLocalToIso("2026-12-01T07:30:00"), "2026-12-01T06:30:00.000Z", "winter time");
  assert.equal(berlinLocalToIso("2026-09-27T07:30"), "2026-09-27T05:30:00.000Z");
  for (const bad of [undefined, 7, "gestern", "2026-09-27", "2026-09-27T07:30:00Z"]) {
    assert.equal(berlinLocalToIso(bad), null, String(bad));
  }
  // Without the two fields: no forecastDay, dateObserved the run time — as the old node.
  const payload = structuredClone(fixture.payload);
  assert.ok(isRecord(payload));
  delete payload.forecast_day;
  delete payload.last_update;
  const legacy = await legacyOn(payload);
  const now = new Date().toISOString();
  const bare = build(parse(payload), null, now);
  assert.ok(bare.every((entity) => entity.forecastDay === undefined));
  assert.equal(bare[0]?.dateObserved.value["@value"], now);
  assertEntitiesEqual(solePayload(legacy), bare);
}

async function levelBranchesMatch(): Promise<void> {
  // Test input, not fixture data: the recorded day was mild.
  const payload = structuredClone(readFixture(FIXTURE).payload);
  assert.ok(isRecord(payload));
  const content: unknown = payload.content;
  assert.ok(Array.isArray(content));
  const byCity = (city: string): Record<string, unknown> => {
    const entry: unknown = content.find((item: unknown) => isRecord(item) && item.city === city);
    assert.ok(isRecord(entry));
    return entry;
  };
  byCity("Stuttgart").forecast = { today_15MEZ: "hoch", tomorrow_15MEZ: "extrem" };
  byCity("Freiburg").forecast = undefined; // `r.forecast || {}` -> 'keine' twice
  byCity("Ulm").forecast = { today_15MEZ: "", tomorrow_15MEZ: "unbekannt" }; // '' -> 'keine', unknown rank 0
  byCity("Konstanz").forecast = { tomorrow_15MEZ: "mittel" };
  content.push({ forecast: { today_15MEZ: "hoch" } }); // no city at all

  const legacy = await legacyOn(payload);
  const entities = ported(payload);
  assertEntitiesEqual(withForecastDay(solePayload(legacy), payload), entities);
  assert.deepEqual(
    entities.map((entity) => [entity.todayLevel.value, entity.tomorrowLevel.value, entity.maxRank.value]),
    [
      ["keine", "mittel", 2],
      ["mittel", "mittel", 2],
      ["keine", "unbekannt", 0],
      ["hoch", "extrem", 4],
      ["keine", "keine", 0],
    ],
  );
}

async function hochDecidesTheRank(): Promise<void> {
  // Test input: "hoch" against "mittel" on either day, so the rank of "hoch"
  // alone decides maxRank — above, "extrem" always outranks it.
  for (const [today, tomorrow] of [
    ["hoch", "mittel"],
    ["mittel", "hoch"],
  ] as const) {
    const payload = structuredClone(readFixture(FIXTURE).payload);
    assert.ok(isRecord(payload) && Array.isArray(payload.content));
    const mannheim: unknown = payload.content.find(
      (item: unknown) => isRecord(item) && item.city === "Mannheim",
    );
    assert.ok(isRecord(mannheim));
    mannheim.forecast = { today_15MEZ: today, tomorrow_15MEZ: tomorrow };

    const legacy = await legacyOn(payload);
    const entities = ported(payload);
    assertEntitiesEqual(withForecastDay(solePayload(legacy), payload), entities);
    const entity = entities.find((candidate) => candidate.id === "urn:ngsi-ld:HeatHealthWarning:bw-mannheim");
    assert.ok(entity !== undefined);
    assert.deepEqual(
      [entity.todayLevel.value, entity.tomorrowLevel.value, entity.maxRank.value],
      [today, tomorrow, 3],
    );
  }
}

function slugMatchesTheOldExpression(): void {
  // The old node only slugs the five mapped cities, so the expression is cut
  // out of it and run on cities that stress it (umlauts, blanks, hyphens).
  const expression = extractSnippet(NODE_ID, "r.city.toLowerCase()", "'-')");
  const cities = [
    "Saarbrücken",
    "Würzburg",
    "Köln",
    "Sankt Peter-Ording",
    "Bad Dürrheim",
    "Überlingen",
    "Ulm",
  ];
  for (const city of cities) {
    assert.equal(slugOf(city), evaluateSnippet("", { r: { city } }, expression), city);
  }
  assert.deepEqual(
    ported({ content: cities.slice(0, 6).map((city) => ({ city, forecast: {} })) }),
    [],
    "only the five BW cities are emitted",
  );
}

async function runWritesTheEntitiesOfTheOldNode(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const legacyClock = openClock();
  const legacy = withForecastDay(solePayload(await legacyOn(fixture.payload)), fixture.payload);
  const legacyWindow = legacyClock.close();
  const network = weatherFetcher((call) =>
    call.method === "POST"
      ? { response: { status: 204, ok: true, headers: {}, body: "" } }
      : jsonAnswer(200, fixture.payload),
  );
  const { ctx, log } = weatherCtx("hitze-bw", network.fetcher);
  const portClock = openClock();
  await run(ctx);
  const portWindow = portClock.close();
  assert.equal(network.seen[0]?.url, fixture.source);
  const upserts = upsertedBatches(network.seen);
  assert.equal(upserts.length, 1);
  assertEntitiesEqual(legacy, upserts[0]);
  assertClockStamps(legacy, upserts[0], { legacy: legacyWindow, ported: portWindow });
  assert.deepEqual(log.warnings(), []);
}

async function unusableAnswersWarnOnBothSides(): Promise<void> {
  const cases: { status: number; payload: unknown; old: string; ported: string }[] = [
    {
      status: 503,
      payload: "down",
      old: "DWD-Hitze: keine Daten (503)",
      ported: "DWD heat: no data (HTTP 503)",
    },
    {
      status: 200,
      payload: { name: "x" },
      old: "DWD-Hitze: keine Daten (200)",
      ported: "DWD heat: no data (HTTP 200)",
    },
    {
      status: 200,
      payload: { content: [{ city: "Osnabrück", forecast: {} }] },
      old: "DWD-Hitze: keine BW-Städte",
      ported: "DWD heat: no BW cities",
    },
  ];
  for (const entry of cases) {
    const legacy = await legacyOn(entry.payload, entry.status);
    assert.equal(legacy.returned, null);
    assert.deepEqual(legacy.warnings, [entry.old]);

    const network = weatherFetcher(() => ({
      response: {
        status: entry.status,
        ok: entry.status < 300,
        headers: {},
        body: JSON.stringify(entry.payload),
      },
    }));
    const { ctx, log } = weatherCtx("hitze-bw", network.fetcher);
    await run(ctx);
    assert.deepEqual(upsertedBatches(network.seen), []);
    assert.deepEqual(log.warnings(), [entry.ported]);
  }
}

function malformedEntryIsCountedNotWritten(): void {
  // Deliberate difference: the old node crashed on a non-object entry and
  // wrote a non-string level as it came; the port skips and counts both.
  const parsed = parse({
    content: [null, { city: "Ulm", forecast: { today_15MEZ: 3 } }, { city: "Stuttgart", forecast: {} }],
  });
  assert.equal(parsed.malformed, 2);
  assert.deepEqual(
    build(parsed, null, new Date().toISOString()).map((entity) => entity.id),
    ["urn:ngsi-ld:HeatHealthWarning:bw-stuttgart"],
  );
}

async function aDriftedCoordinateFailsTheComparison(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const legacy = withForecastDay(solePayload(await legacyOn(fixture.payload)), fixture.payload);
  const drifted = ported(fixture.payload).map<HeatHealthWarningEntity>((entity, index) =>
    index === 2
      ? { ...entity, location: { type: "GeoProperty", value: { type: "Point", coordinates: [48.4, 9.99] } } }
      : entity,
  );
  assert.throws(
    () => {
      assertEntitiesEqual(legacy, drifted);
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /2 difference\(s\), first at \[2\]\.location\.value\.coordinates\[0\]/);
      return true;
    },
  );
}

export {
  forecastDayIsWritten as "hitze-bw: forecastDay and dateObserved come from the file, Berlin local time (deliberate)",
  fixtureIsIdentical as "hitze-bw: old FN_HITZE and ported build() produce identical entities on the recorded DWD answer",
  levelBranchesMatch as "hitze-bw: missing forecast, empty and unknown levels and the rank maximum match the old node",
  hochDecidesTheRank as 'hitze-bw: "hoch" against "mittel" on either day ranks 3, as in the old node',
  slugMatchesTheOldExpression as "hitze-bw: slugOf() is the old slug expression; only BW cities are emitted",
  runWritesTheEntitiesOfTheOldNode as "hitze-bw: run() upserts what the old node emitted, in one request",
  unusableAnswersWarnOnBothSides as "hitze-bw: HTTP error, missing content and no BW city warn and write nothing on both sides",
  malformedEntryIsCountedNotWritten as "hitze-bw: malformed entries are counted and skipped (deliberate difference)",
  aDriftedCoordinateFailsTheComparison as "hitze-bw: swapped coordinates fail the comparison and name their path",
};
