/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: pollen-bw — old Node-RED function node against the ported module.
 *
 * The worked example of the parity harness (phase 2 of the connector
 * migration). `udp-rt-po-fn` was chosen because it is the smallest honest case:
 * ONE function node, no `flow`/`global` context, no `libs`, no `join` upstream —
 * DWD JSON in, NGSI-LD entities out. Whatever fails here is a fault of the
 * harness and not of the connector.
 *
 * The ported side was written in this file in phase 2 and moved to
 * src/connectors/pollen-bw.ts unchanged in phase 3; the tests below stayed as
 * they were — that is the whole point of them. The two deliberate differences
 * from the old node (loud parser, `Map` instead of an object literal) and the
 * species order taken from the key order of the DWD response are described in
 * the module header.
 *
 * DELIBERATE DEVIATION (module header): 08335 (Landkreis Konstanz) is mapped to
 * part-region 112; the old node left it out. {@link withKonstanz} adds it to
 * the old node's entities before every comparison, and
 * {@link everyDistrictIsMappedOnce} pins all 44 districts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parse,
  build as buildEntities,
  run,
  type PollenForecastEntity,
} from "../../src/connectors/pollen-bw.js";
import { messageFromFixture, readFixture, repositoryRoot } from "../harness/fixtures.js";
import {
  assertClockStamps,
  assertEntitiesEqual,
  isRecord,
  normalize,
  openClock,
} from "../harness/normalize.js";
import { runFunctionNode, solePayload } from "../harness/vm-runner.js";
import { jsonAnswer, upsertedBatches, weatherCtx, weatherFetcher } from "../harness/weather-ctx.js";

const NODE_ID = "udp-rt-po-fn";
const FIXTURE = "pollen-bw";

/** The pure half of the module, as the phase 2 tests call it: raw JSON and a timestamp. */
function build(raw: unknown, now: string): readonly PollenForecastEntity[] {
  return buildEntities(parse(raw), null, now);
}

/** The old node's entities with the deliberate fix: 08335 in part-region 112, keys sorted. */
function withKonstanz(legacy: unknown): unknown {
  if (!Array.isArray(legacy)) return legacy;
  return legacy.map((entity: unknown) => {
    if (!isRecord(entity) || entity.id !== "urn:ngsi-ld:PollenForecast:bw-region-112") return entity;
    const kreise = isRecord(entity.kreise) ? entity.kreise : {};
    const keys = Array.isArray(kreise.value) ? kreise.value.map(String) : [];
    return { ...entity, kreise: { ...kreise, value: [...keys, "08335"].sort() } };
  });
}

/* ── the tests ───────────────────────────────────────────────────────────────*/

const EXPECTED_IDS = [
  "urn:ngsi-ld:PollenForecast:bw-region-111",
  "urn:ngsi-ld:PollenForecast:bw-region-112",
  "urn:ngsi-ld:PollenForecast:bw-region-113",
];

function idsOf(entities: readonly PollenForecastEntity[]): string[] {
  return entities.map((entity) => entity.id);
}

async function fixtureKeepsOnlyBadenWuerttemberg(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const run = await runFunctionNode(NODE_ID, { msg: messageFromFixture(fixture) });

  assert.deepEqual(run.warnings, [], "the old node warned on the recorded fixture");
  assert.deepEqual(run.errors, [], "the old node reported an error on the recorded fixture");
  // normalize() rather than the raw value: the status object was created inside
  // the vm realm and carries a different Object.prototype, which
  // deepStrictEqual checks.
  assert.deepEqual(normalize(run.status), [{ text: "3 Teilregionen" }]);
  assert.deepEqual(idsOf(build(fixture.payload, "2026-01-01T00:00:00.000Z")), EXPECTED_IDS);
}

async function oldAndNewProduceIdenticalEntities(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const run = await runFunctionNode(NODE_ID, { msg: messageFromFixture(fixture) });
  const legacy = solePayload(run);
  const ported = build(fixture.payload, new Date().toISOString());
  assertEntitiesEqual(withKonstanz(legacy), ported);
}

function everyDistrictIsMappedOnce(): void {
  // The 44 district keys of Baden-Württemberg, from the municipality catalogue of the pages.
  const catalogue: unknown = JSON.parse(
    readFileSync(join(repositoryRoot(), "gui", "public", "bw-gemeinden.json"), "utf8"),
  );
  const rows = isRecord(catalogue) && Array.isArray(catalogue.kreise) ? catalogue.kreise : [];
  const districts = rows.map((row: unknown) => (Array.isArray(row) ? String(row[0]) : "")).sort();
  assert.equal(districts.length, 44);
  const mapped = build(readFixture(FIXTURE).payload, "2026-01-01T00:00:00.000Z").flatMap(
    (entity) => entity.kreise.value,
  );
  assert.deepEqual([...mapped].sort(), districts, "every BW district in exactly one part-region");
  const region = build(readFixture(FIXTURE).payload, "2026-01-01T00:00:00.000Z").find((entity) =>
    entity.kreise.value.includes("08335"),
  );
  assert.equal(region?.id, "urn:ngsi-ld:PollenForecast:bw-region-112", "Konstanz beside the Bodenseekreis");
}

async function aDriftedFieldIsReportedWithItsPath(): Promise<void> {
  // The proof that the harness can fail at all. A harness that cannot fail is
  // worse than none: it turns every port green, including a broken one.
  const fixture = readFixture(FIXTURE);
  const run = await runFunctionNode(NODE_ID, { msg: messageFromFixture(fixture) });
  const legacy = withKonstanz(solePayload(run));
  const drifted = build(fixture.payload, new Date().toISOString()).map<PollenForecastEntity>(
    (entity, index) =>
      index === 1 ? { ...entity, name: { type: "Property", value: "Hohenlohe (drifted)" } } : entity,
  );

  assert.throws(
    () => {
      assertEntitiesEqual(legacy, drifted);
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /1 difference\(s\)/);
      assert.match(error.message, /\[1\]\.name\.value/);
      assert.match(error.message, /Hohenlohe \(drifted\)/);
      return true;
    },
  );
}

function onlyWallClockStampsAreNeutralised(): void {
  const fixture = readFixture(FIXTURE);
  // Same data, two different run instants: must be equal.
  assertEntitiesEqual(
    build(fixture.payload, "2026-08-31T06:00:00.000Z"),
    build(fixture.payload, "2026-08-31T18:30:12.417Z"),
  );

  // But a timestamp that is DATA, not a clock reading, must not be blanked —
  // otherwise every connector with a validity period would be checked blind.
  assert.throws(() => {
    assertEntitiesEqual(
      [{ startsAt: "2026-08-31T06:00:00Z", observedAt: "2026-08-31T06:00:00Z" }],
      [{ startsAt: "2026-09-01T06:00:00Z", observedAt: "2026-08-31T07:04:31Z" }],
    );
  }, /startsAt/);
}

/* ── phase 3: run() and the guard branches ───────────────────────────────────*/

async function runWritesTheEntitiesOfTheOldNode(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const legacyClock = openClock();
  const legacy = solePayload(await runFunctionNode(NODE_ID, { msg: messageFromFixture(fixture) }));
  const legacyWindow = legacyClock.close();
  const network = weatherFetcher((call) =>
    call.method === "POST"
      ? { response: { status: 204, ok: true, headers: {}, body: "" } }
      : jsonAnswer(200, fixture.payload),
  );
  const { ctx, log } = weatherCtx("pollen-bw", network.fetcher);
  const portClock = openClock();
  await run(ctx);
  const portWindow = portClock.close();

  assert.equal(network.seen[0]?.url, fixture.source);
  const upserts = upsertedBatches(network.seen);
  assert.equal(upserts.length, 1, "three entities, one request — the old upsert node sent one message");
  assertEntitiesEqual(withKonstanz(legacy), upserts[0]);
  assertClockStamps(legacy, upserts[0], { legacy: legacyWindow, ported: portWindow });
  assert.deepEqual(log.warnings(), []);
}

async function unusableAnswersWarnOnBothSides(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const cases: { status: number; payload: unknown; old: string; ported: string }[] = [
    {
      status: 404,
      payload: "<html/>",
      old: "DWD-Pollen: keine Daten (404)",
      ported: "DWD pollen: no data (HTTP 404)",
    },
    {
      status: 200,
      payload: { content: {} },
      old: "DWD-Pollen: keine Daten (200)",
      ported: "DWD pollen: no data (HTTP 200)",
    },
    {
      status: 200,
      payload: { content: [{ partregion_id: 41, partregion_name: "Rhein.-Westfäl. Tiefland", Pollen: {} }] },
      old: "DWD-Pollen: keine BW-Regionen",
      ported: "DWD pollen: no BW part-regions",
    },
  ];
  for (const entry of cases) {
    const legacy = await runFunctionNode(NODE_ID, {
      msg: { ...messageFromFixture(fixture), statusCode: entry.status, payload: entry.payload },
    });
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
    const { ctx, log } = weatherCtx("pollen-bw", network.fetcher);
    await run(ctx);
    assert.deepEqual(upsertedBatches(network.seen), []);
    assert.deepEqual(log.warnings(), [entry.ported]);
  }
}

async function repeatedPartRegionsAgree(): Promise<void> {
  // Sixty copies of the content (a synthetic test input — DWD lists each of
  // the three BW part-regions once): 180 entities, beyond one chunk of 150.
  const fixture = readFixture(FIXTURE);
  const payload = structuredClone(fixture.payload);
  assert.ok(isRecord(payload) && Array.isArray(payload.content));
  const content: unknown[] = payload.content;
  payload.content = Array.from({ length: 60 }, () => content).flat();
  const legacy = solePayload(
    await runFunctionNode(NODE_ID, { msg: { ...messageFromFixture(fixture), payload } }),
  );
  const network = weatherFetcher((call) =>
    call.method === "POST"
      ? { response: { status: 204, ok: true, headers: {}, body: "" } }
      : jsonAnswer(200, payload),
  );
  const { ctx } = weatherCtx("pollen-bw", network.fetcher);
  await run(ctx);
  const upserts = upsertedBatches(network.seen);
  assertEntitiesEqual(withKonstanz(legacy), upserts.flat());
  // NOT compared: the request split. The old node handed all 180 to its
  // upsert node as ONE message; run() sends chunks of 150 (the kernel
  // default). Only reachable with repeated part-regions — reported, not pinned.
  assert.equal(upserts.flat().length, 180);
}

function malformedSpeciesIsLoud(): void {
  // Deliberate difference (module header): the old node would have written
  // `undefined` for a species without `tomorrow`.
  assert.throws(
    () =>
      parse({ content: [{ partregion_id: 112, partregion_name: "x", Pollen: { Birke: { today: "0" } } }] }),
    /species "Birke" in 112 has no today\/tomorrow/,
  );
}

export {
  everyDistrictIsMappedOnce as "pollen-bw: all 44 BW districts are mapped, each once, 08335 in 112 (deliberate)",
  runWritesTheEntitiesOfTheOldNode as "pollen-bw: run() upserts what the old node emitted, in one request",
  unusableAnswersWarnOnBothSides as "pollen-bw: HTTP error, missing content and no BW part-region warn and write nothing on both sides",
  repeatedPartRegionsAgree as "pollen-bw: more entities than one chunk (synthetic repeated part-regions) agree with the old node",
  malformedSpeciesIsLoud as "pollen-bw: a species without today/tomorrow makes parse() loud (deliberate difference)",
  fixtureKeepsOnlyBadenWuerttemberg as "pollen-bw: recorded DWD fixture yields exactly the three BW part-regions",
  oldAndNewProduceIdenticalEntities as "pollen-bw: old Node-RED node udp-rt-po-fn and ported build() produce identical entities",
  aDriftedFieldIsReportedWithItsPath as "parity harness: a single drifted field fails the comparison and names its path",
  onlyWallClockStampsAreNeutralised as "parity harness: neutralises the wall-clock stamps and nothing else",
};
