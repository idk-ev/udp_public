/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: eco-bw — `udp-rt-be-fn` ("→ Radzähler BW") against the ported
 * module, and its daily prune against the old node on the full master data.
 *
 * `dateObserved` is DATA in this connector (the day the count belongs to), so
 * the comparison neutralises only `observedAt` (the run time of `P()`); a
 * drifted day must fail, and the last test shows that it does.
 *
 * Fixture: test/fixtures/eco-bw.json, see its note.
 */

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { build, parse, run, SOURCE_URL, summarize } from "../../src/connectors/eco-bw.js";
import type { HttpResponse } from "../../src/kernel/types.js";
import {
  Broker,
  fixtureGeo,
  flowOf,
  fullGeo,
  legacyChunkSizes,
  legacyEntities,
  legacyGlobal,
  sharedGeo,
  testCtx,
} from "../harness/air-energy-kernel.js";
import type { RawGeo } from "../harness/air-energy-kernel.js";
import { messageFromFixture, readFixture } from "../harness/fixtures.js";
import { fakeHttpModule, httpResponse } from "../harness/kernel.js";
import type { SeenRequest } from "../harness/kernel.js";
import { assertEntitiesEqual } from "../harness/normalize.js";
import { runFunctionNode } from "../harness/vm-runner.js";
import type { FunctionNodeRun } from "../harness/vm-runner.js";

const NODE_ID = "udp-rt-be-fn";
const HOUR = 3_600_000;
/** Only the run time is neutralised; `dateObserved` is the counted day. */
const VOLATILE = { volatileKeys: ["observedAt"] };

async function runLegacy(
  payload: unknown,
  options: {
    readonly geo?: RawGeo;
    readonly flow?: Record<string, unknown>;
    readonly context?: Record<string, unknown>;
    readonly respond?: (request: SeenRequest) => HttpResponse | Error;
  } = {},
): Promise<FunctionNodeRun> {
  return runFunctionNode(NODE_ID, {
    msg: { ...messageFromFixture(readFixture("eco-bw")), payload: structuredClone(payload) },
    global: legacyGlobal(options.geo ?? fixtureGeo()),
    flow: options.flow ?? {},
    context: options.context ?? {},
    modules: { http: fakeHttpModule(options.respond ?? (() => new Error("no broker in this test"))) },
  });
}

async function entitiesAreIdentical(): Promise<void> {
  const payload = readFixture("eco-bw").payload;
  const legacy = await runLegacy(payload);
  const result = summarize(parse(payload), sharedGeo(fixtureGeo()).index(), new Date().toISOString());
  assert.deepEqual(legacy.warnings, []);
  assertEntitiesEqual(legacyEntities(legacy), result.entities, VOLATILE);
  assert.deepEqual(legacyChunkSizes(legacy), [result.entities.length]);

  // What the fixture exercises: sites inside the polygons, sums per municipality,
  // sites skipped for having no ALL channel, empty coordinates or no polygon.
  const sites = result.entities.filter((entity) => entity.id.includes(":bw-eco-"));
  const sums = result.entities.filter((entity) => entity.id.endsWith("-summary"));
  assert.ok(sites.length >= 30, `sites: ${String(sites.length)}`);
  assert.equal(sums.length, result.municipalities);
  assert.ok(sums.some((entity) => entity.id === "urn:ngsi-ld:TrafficFlowObserved:bw-08311000-summary"));
  assert.ok(
    !result.entities.some((entity) => entity.ags.value.startsWith("08416")),
    "Tuebingen has no polygon here",
  );
  assert.ok(sites.length < parse(payload).length, "some sites are skipped");
}

async function edgeCasesOfTheFeed(): Promise<void> {
  // Two days of ALL out of order, a site with only IN/OUT, one with empty
  // coordinates, one outside BW (Basel), counts of 0.
  const channel = (day: string, direction: string, counts: number): unknown => ({
    iso_timestamp: `2026-09-${day}T00:00:00+02:00`,
    direction,
    counts,
  });
  const payload = [
    {
      counter_site: "Wiwilí-Brücke",
      counter_site_id: 7,
      latitude: 47.9912,
      longitude: 7.8412,
      channels: [channel("26", "ALL", 5), channel("25", "ALL", 9)],
    },
    {
      counter_site: "Nur Richtungen",
      counter_site_id: 8,
      latitude: 47.99,
      longitude: 7.85,
      channels: [channel("26", "IN", 3)],
    },
    {
      counter_site: "Null",
      counter_site_id: 9,
      latitude: 47.995,
      longitude: 7.845,
      channels: [channel("24", "ALL", 0)],
    },
    {
      counter_site: "Basel",
      counter_site_id: 10,
      latitude: 47.5582,
      longitude: 7.5878,
      channels: [channel("26", "ALL", 1)],
    },
    { counter_site: "Leer", counter_site_id: 11, latitude: "", longitude: "", channels: [] },
  ];
  const legacy = await runLegacy(payload);
  const entities = build(parse(payload), sharedGeo(fixtureGeo()).index(), new Date().toISOString());
  assertEntitiesEqual(legacyEntities(legacy), entities, VOLATILE);
  const sum = entities.find((entity) => entity.id.endsWith("08311000-summary"));
  assert.ok(sum !== undefined);
  assert.equal(sum.dailyTotal.value, 5, "the newest day of each site, summed");
  assert.equal(sum.dateObserved.value["@value"], "2026-09-26T00:00:00Z", "the day of the first site");
}

async function aDriftedDayFails(): Promise<void> {
  const payload = readFixture("eco-bw").payload;
  const legacy = await runLegacy(payload);
  const drifted = build(parse(payload), sharedGeo(fixtureGeo()).index(), new Date().toISOString()).map(
    (entity, i) =>
      i === 0
        ? {
            ...entity,
            dateObserved: {
              type: "Property" as const,
              value: { "@type": "DateTime" as const, "@value": "2026-01-01T00:00:00Z" },
            },
          }
        : entity,
  );
  assert.throws(() => {
    assertEntitiesEqual(legacyEntities(legacy), drifted, VOLATILE);
  }, /\[0\]\.dateObserved\.value\.@value/);
}

function staleBroker(): Broker {
  const old = {
    type: "Property",
    value: { "@type": "DateTime", "@value": new Date(Date.now() - 5 * 24 * HOUR).toISOString() },
  };
  return new Broker([
    {
      id: "urn:ngsi-ld:TrafficFlowObserved:bw-eco-100000001",
      type: "TrafficFlowObserved",
      ags: { type: "Property", value: "08111000" },
      dateObserved: old,
    },
    {
      id: "urn:ngsi-ld:TrafficFlowObserved:bw-08436001-summary",
      type: "TrafficFlowObserved",
      ags: { type: "Property", value: "08436001" },
      dateObserved: old,
    },
    // Written by a municipal connector with a slug id: never ours.
    {
      id: "urn:ngsi-ld:TrafficFlowObserved:freiburg-zaehler-1",
      type: "TrafficFlowObserved",
      dateObserved: old,
    },
  ]);
}

async function dailyPruneMatchesTheOldNode(): Promise<void> {
  const geo = fullGeo();
  const payload = readFixture("eco-bw").payload;
  const rows = geo.municipalities;
  assert.ok(Array.isArray(rows));

  const legacyBroker = staleBroker();
  legacyBroker.municipalityCount = rows.length;
  let flow: Record<string, unknown> = {};
  let context: Record<string, unknown> = {};
  const legacyDeletes: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    const legacy = await runLegacy(payload, { geo, flow, context, respond: legacyBroker.respond });
    await sleep(150);
    flow = flowOf(legacy);
    context = Object.fromEntries(legacy.context);
    legacyDeletes.push(legacyBroker.deletes.flat().length);
  }

  const portBroker = staleBroker();
  portBroker.municipalityCount = rows.length;
  const respond = (request: SeenRequest): HttpResponse | Error =>
    request.url.href === SOURCE_URL
      ? httpResponse(200, JSON.stringify(payload))
      : portBroker.respond(request);
  const { ctx, log } = testCtx("eco-bw", sharedGeo(geo), respond);
  const portDeletes: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    await run(ctx);
    portDeletes.push(portBroker.deletes.flat().length);
  }

  assert.deepEqual(portDeletes, [0, 2], "armed in the first run, deleting in the second");
  assert.deepEqual(portDeletes, legacyDeletes);
  assert.deepEqual(portBroker.deletes.flat().sort(), legacyBroker.deletes.flat().sort());
  assert.ok(portBroker.entities.has("urn:ngsi-ld:TrafficFlowObserved:freiburg-zaehler-1"));
  assert.deepEqual(log.warnings(), []);
  assert.equal(ctx.intervalMs(), 86_400_000, "a cron connector counts as daily");
  // Every site and sum written in full, once: no gate.
  assert.equal(
    portBroker.upserts.flat().length,
    2 * summarize(parse(payload), sharedGeo(geo).index(), "x").entities.length,
  );
}

export {
  entitiesAreIdentical as "eco-bw: old node and ported build() agree on sites and municipal sums (dateObserved compared as data)",
  edgeCasesOfTheFeed as "eco-bw: newest ALL day, sites without ALL or polygon, zero counts agree",
  aDriftedDayFails as "eco-bw: a drifted counting day fails the comparison with its path",
  dailyPruneMatchesTheOldNode as "eco-bw: the daily prune arms and deletes as the old node did, foreign ids untouched",
};
