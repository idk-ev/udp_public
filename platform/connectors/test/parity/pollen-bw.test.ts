/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: pollen-bw — old Node-RED function node against a new pure function.
 *
 * The worked example of the parity harness (phase 2 of the connector
 * migration). `udp-rt-po-fn` was chosen because it is the smallest honest case:
 * ONE function node, no `flow`/`global` context, no `libs`, no `join` upstream —
 * DWD JSON in, NGSI-LD entities out. Whatever fails here is a fault of the
 * harness and not of the connector.
 *
 * ── NOTE FOR THE PHASE 3 OWNER (agent B · weather) ────────────────────────────
 * `build()` below is deliberately NOT in `src/`. Phase 1 owns that directory and
 * the `ctx` contract was not yet frozen when this file was written. When
 * pollen-bw is ported: move `parseDwdPollen`, `REGION_KREISE` and `build` into
 * `src/connectors/pollen-bw.ts` UNCHANGED, fit them to the module contract, and
 * import `build` here instead of declaring it. The tests themselves stay as they
 * are — that is the whole point of them.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two deliberate differences from the old node, both only for input the fixture
 * does not contain:
 *
 *  * `parseDwdPollen` gets loud on a malformed response. The old node would put
 *    `undefined` into the position array for a species without `today`, and
 *    would fail outright on a species that is not an object. Getting loud is
 *    thus closer to it than silently skipping — and it is what the type
 *    discipline of the service demands (`platform/connectors/README.md`).
 *  * The mapping part-region -> district lives in a `Map`, not in an object
 *    literal. `REGION_KREISE["constructor"]` would find something on an object
 *    literal; a `Map` would not. Unreachable here, since the key comes from a
 *    number — but it costs nothing.
 *
 * Not a difference, and worth knowing before porting: the order of the species
 * within `arten` comes from the ORDER OF THE KEYS in the DWD response and
 * differs from part-region to part-region. The old node reads it via
 * `Object.keys()`, so the new one has to as well. A fixed species list would be
 * tidier and would fail the parity test.
 */

import assert from "node:assert/strict";
import { messageFromFixture, readFixture } from "../harness/fixtures.js";
import { assertEntitiesEqual, normalize } from "../harness/normalize.js";
import { runFunctionNode, solePayload } from "../harness/vm-runner.js";

const NODE_ID = "udp-rt-po-fn";
const FIXTURE = "pollen-bw";
const CONTEXT_URL = "https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld";
const DATA_PROVIDER = "DWD Pollenflug-Gefahrenindex (GeoNutzV)";

/* ── the ported side ─────────────────────────────────────────────────────────*/

/**
 * One species in the forecast — position array, exactly as the old node emits
 * it. The names of the tuple elements are what used to be a comment.
 */
type SpeciesForecast = readonly [species: string, today: string, tomorrow: string];

interface PartRegion {
  /** DWD part-region id as a string; the key of the district mapping. */
  readonly id: string;
  readonly name: string;
  readonly species: readonly SpeciesForecast[];
}

interface PollenForecastEntity {
  readonly id: string;
  readonly type: "PollenForecast";
  readonly name: { readonly type: "Property"; readonly value: string };
  readonly kreise: { readonly type: "Property"; readonly value: readonly string[] };
  readonly arten: {
    readonly type: "Property";
    readonly value: readonly SpeciesForecast[];
    readonly observedAt: string;
  };
  readonly dateObserved: {
    readonly type: "Property";
    readonly value: { readonly "@type": "DateTime"; readonly "@value": string };
  };
  readonly dataProvider: { readonly type: "Property"; readonly value: string };
  readonly "@context": string;
}

/**
 * Curated district mapping of the three Baden-Württemberg part-regions
 * (111 Oberrhein/unteres Neckartal, 112 Hohenlohe/mittlerer Neckar/Oberschwaben,
 * 113 Mittelgebirge). Identical to `POLLEN_REGION` in
 * `scripts/generate-nodered-flows.py`; a difference here would show up as a
 * parity failure in `kreise`.
 *
 * As blank-separated strings, not as arrays of literals: 43 district keys one
 * per line is what Prettier makes of the latter, and that buries the mapping.
 */
const REGION_KREISE = new Map<string, readonly string[]>([
  ["111", "08211 08212 08215 08216 08221 08222 08226 08311 08315 08316 08317 08336".split(" ")],
  [
    "112",
    "08111 08115 08116 08117 08118 08119 08121 08125 08126 08127 08128 08135 08136 08231 08236 08415 08416 08421 08425 08426 08435 08436 08437".split(
      " ",
    ),
  ],
  ["113", "08225 08235 08237 08325 08326 08327 08337 08417".split(" ")],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** External data enters as `unknown` and is narrowed, never asserted. */
function parseDwdPollen(raw: unknown): readonly PartRegion[] {
  if (!isRecord(raw)) throw new Error("DWD pollen: response is not a JSON object");
  const content = raw.content;
  if (!Array.isArray(content)) throw new Error('DWD pollen: field "content" is not an array');

  const regions: PartRegion[] = [];
  for (const entry of content) {
    if (!isRecord(entry)) throw new Error("DWD pollen: entry in content is not an object");
    const id = String(entry.partregion_id);
    const name = entry.partregion_name;
    if (typeof name !== "string") {
      throw new Error(`DWD pollen: part-region ${id} has no "partregion_name"`);
    }
    const pollen = entry.Pollen;
    const species: SpeciesForecast[] = [];
    if (isRecord(pollen)) {
      for (const [key, value] of Object.entries(pollen)) {
        if (!isRecord(value)) throw new Error(`DWD pollen: species "${key}" in ${id} is not an object`);
        const today = value.today;
        const tomorrow = value.tomorrow;
        if (typeof today !== "string" || typeof tomorrow !== "string") {
          throw new Error(`DWD pollen: species "${key}" in ${id} has no today/tomorrow`);
        }
        species.push([key, today, tomorrow]);
      }
    }
    regions.push({ id, name, species });
  }
  return regions;
}

/**
 * Transformation as a pure function: raw data and a timestamp in, entities out.
 * No network, no clock, no global state — that is what makes it comparable
 * against the old Node-RED code in the first place.
 */
function build(raw: unknown, now: string): readonly PollenForecastEntity[] {
  const entities: PollenForecastEntity[] = [];
  for (const region of parseDwdPollen(raw)) {
    const kreise = REGION_KREISE.get(region.id);
    if (kreise === undefined) continue;
    entities.push({
      id: `urn:ngsi-ld:PollenForecast:bw-region-${region.id}`,
      type: "PollenForecast",
      name: { type: "Property", value: region.name },
      kreise: { type: "Property", value: kreise },
      arten: { type: "Property", value: region.species, observedAt: now },
      dateObserved: { type: "Property", value: { "@type": "DateTime", "@value": now } },
      dataProvider: { type: "Property", value: DATA_PROVIDER },
      "@context": CONTEXT_URL,
    });
  }
  return entities;
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
  assertEntitiesEqual(legacy, ported);
}

async function aDriftedFieldIsReportedWithItsPath(): Promise<void> {
  // The proof that the harness can fail at all. A harness that cannot fail is
  // worse than none: it turns every port green, including a broken one.
  const fixture = readFixture(FIXTURE);
  const run = await runFunctionNode(NODE_ID, { msg: messageFromFixture(fixture) });
  const legacy = solePayload(run);
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

export {
  fixtureKeepsOnlyBadenWuerttemberg as "pollen-bw: recorded DWD fixture yields exactly the three BW part-regions",
  oldAndNewProduceIdenticalEntities as "pollen-bw: old Node-RED node udp-rt-po-fn and ported build() produce identical entities",
  aDriftedFieldIsReportedWithItsPath as "parity harness: a single drifted field fails the comparison and names its path",
  onlyWallClockStampsAreNeutralised as "parity harness: neutralises the wall-clock stamps and nothing else",
};
