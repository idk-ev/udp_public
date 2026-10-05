/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: puls-bw — `udp-rt-bz-build` ("→ CityPulse je Gemeinde") and its
 * commit node against `run(ctx)` of the port, both reading the SAME scripted
 * Orion listings: the old node through a fake `node:http`, the port through
 * the kernel's paged `orion.list`. Compared are the entities written, the
 * warnings (verbatim), the listing queries (decoded), the committed
 * signatures, and the prune.
 *
 * The scoring must be byte-identical — `components` and `pulseIndex` are what
 * the change signature hashes — so besides old-against-new, one municipality
 * is scored by hand along docs/framework-dashboards.md.
 *
 * DELIBERATE DEVIATION (module header): the UBA index is scored on its real
 * 0–4 scale, only if current, and the worst station of a municipality counts.
 * The old node is therefore fed {@link legacyView} of the listings: only the
 * current, worst UBA station per municipality, its index raised by one — on
 * that input its `(5 − index) · 25` is exactly the port's `(4 − index) · 25`,
 * so everything else is still compared old against new.
 * {@link luftindexOnTheUbaScale} and {@link worstCurrentStationCounts} pin
 * the difference.
 *
 * Fixture: test/fixtures/puls-bw.json — SCRIPTED listings (the pulse reads
 * other connectors' entities, there is no source to record); ages are
 * materialised relative to the run time, see its note.
 */

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { GATE_KEY, run, summarize, UBA_MAX_AGE_MS } from "../../src/connectors/puls-bw.js";
import type { AirRecord, PulseListings } from "../../src/connectors/puls-bw.js";
import { SignatureStore } from "../../src/kernel/change-gate.js";
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
import { readFixture } from "../harness/fixtures.js";
import { fakeHttpModule, httpResponse } from "../harness/kernel.js";
import type { SeenRequest } from "../harness/kernel.js";
import type { ClockWindow } from "../harness/normalize.js";
import {
  assertClockStamps,
  assertEntitiesEqual,
  isRecord,
  normalize,
  openClock,
} from "../harness/normalize.js";
import { assertPruneSettings, legacyPruneSettings, recordPrunes } from "../harness/prune-settings.js";
import { messagesOf, runFunctionNode } from "../harness/vm-runner.js";
import type { FunctionNodeRun } from "../harness/vm-runner.js";

const NODE_ID = "udp-rt-bz-build";
const COMMIT_NODE_ID = "udp-rt-bz-commit";
const HOUR = 3_600_000;

type Mutation = (records: Map<string, Record<string, unknown>[]>) => void;

/** The fixture's listings with `ageHours` turned into a `dateObserved` relative to `nowMs`. */
function listings(nowMs: number, mutate?: Mutation): Map<string, Record<string, unknown>[]> {
  const payload = readFixture("puls-bw").payload;
  assert.ok(isRecord(payload));
  const out = new Map<string, Record<string, unknown>[]>();
  for (const [type, list] of Object.entries(payload)) {
    assert.ok(Array.isArray(list));
    out.set(
      type,
      list.map((raw: unknown) => {
        assert.ok(isRecord(raw));
        const { ageHours, dateForm, ...entity } = raw;
        if (typeof ageHours !== "number") return entity;
        const iso = new Date(nowMs - ageHours * HOUR).toISOString();
        return {
          ...entity,
          dateObserved: dateForm === "typed" ? { "@type": "DateTime", "@value": iso } : iso,
        };
      }),
    );
  }
  mutate?.(out);
  return out;
}

function broker(mutate?: Mutation): Broker {
  return new Broker([...listings(Date.now(), mutate).values()].flat());
}

/** `dateObserved` of a keyValues record in ms, either form; `null` without one. */
function observedMs(entity: Record<string, unknown>): number | null {
  const value = entity.dateObserved;
  const raw = isRecord(value) ? value["@value"] : value;
  return typeof raw === "string" ? Date.parse(raw) : null;
}

/**
 * The listings as the old node must see them to score like the port (see the
 * header): of the UBA stations only the current one with the highest index
 * per municipality, its index raised by one onto the old 1–5 reading. UBA
 * records without an index are kept as they are (both ignore them).
 */
function legacyView(source: Broker): void {
  const nowMs = Date.now();
  const worst = new Map<string, Record<string, unknown>>();
  for (const [id, entity] of source.entities) {
    if (!id.includes(":AirQualityObserved:bw-uba-") || typeof entity.airQualityIndex !== "number") continue;
    source.entities.delete(id);
    const at = observedMs(entity);
    if (at === null || nowMs - at > UBA_MAX_AGE_MS) continue;
    const ags = String(entity.ags);
    const before = worst.get(ags);
    if (before === undefined || Number(before.airQualityIndex) < entity.airQualityIndex)
      worst.set(ags, entity);
  }
  for (const entity of worst.values()) {
    source.add({ ...entity, airQualityIndex: Number(entity.airQualityIndex) + 1 });
  }
}

interface Sides {
  readonly legacy: FunctionNodeRun;
  readonly legacySeen: SeenRequest[];
  readonly portBroker: Broker;
  readonly portSeen: SeenRequest[];
  readonly portWarnings: string[];
  readonly portStatus: string[];
  readonly legacyWindow: ClockWindow;
  readonly portWindow: ClockWindow;
}

async function bothSides(
  source: Broker,
  options: {
    readonly geo?: RawGeo;
    readonly flow?: Record<string, unknown>;
    readonly store?: SignatureStore;
  } = {},
): Promise<Sides> {
  const geo = options.geo ?? fixtureGeo();
  const legacyBroker = source.clone();
  legacyView(legacyBroker);
  const legacySeen: SeenRequest[] = [];
  const legacyClock = openClock();
  const legacy = await runFunctionNode(NODE_ID, {
    msg: { _msgid: "parity", payload: Date.now() },
    global: legacyGlobal(geo),
    flow: options.flow ?? {},
    modules: {
      http: fakeHttpModule((request) => {
        legacySeen.push(request);
        return legacyBroker.respond(request);
      }),
    },
  });
  const legacyWindow = legacyClock.close();
  const portBroker = source.clone();
  const { ctx, log, seen } = testCtx(
    "puls-bw",
    sharedGeo(geo),
    portBroker.respond,
    options.store === undefined ? {} : { store: options.store },
  );
  const portClock = openClock();
  await run(ctx);
  const portWindow = portClock.close();
  return {
    legacy,
    legacySeen,
    portBroker,
    portSeen: seen,
    portWarnings: log.warnings(),
    portStatus: log.lines.filter((line) => line.level === "status").map((line) => line.text),
    legacyWindow,
    portWindow,
  };
}

function assertSame(sides: Sides, label: string): void {
  assert.deepEqual(sides.portWarnings, [...sides.legacy.warnings], `${label}: warnings differ`);
  assertEntitiesEqual(legacyEntities(sides.legacy), sides.portBroker.upserts.flat());
  if (legacyEntities(sides.legacy).length > 0) {
    assertClockStamps(legacyEntities(sides.legacy), sides.portBroker.upserts.flat(), {
      legacy: sides.legacyWindow,
      ported: sides.portWindow,
    });
  }
  assert.deepEqual(
    legacyChunkSizes(sides.legacy),
    sides.portBroker.upserts.map((body) => body.length),
    `${label}: chunking differs`,
  );
  // Same queries: the listing parameters, decoded (the kernel escapes the commas of `attrs`).
  const legacyQueries = Broker.listings(sides.legacySeen);
  assert.deepEqual(Broker.listings(sides.portSeen), legacyQueries, `${label}: queries differ`);
}

/** The old status line: `N Gemeinden mit Puls · M unter 3 Komponenten[ · Baustellen-Feed ohne aktuelle Daten]`. */
function legacyCounts(run: FunctionNodeRun): string {
  const last = normalize(run.status[run.status.length - 1]);
  const text = isRecord(last) && typeof last.text === "string" ? last.text : "";
  const match =
    /^(\d+) Gemeinden mit Puls · (\d+) unter 3 Komponenten( · Baustellen-Feed ohne aktuelle Daten)?$/.exec(
      text,
    );
  return match === null
    ? text
    : `${match[1] ?? ""}|${match[2] ?? ""}|${match[3] === undefined ? "live" : "stale"}`;
}

function portCounts(sides: Sides): string {
  const line = sides.portStatus.find((text) => text.includes("municipalities with pulse")) ?? "";
  const match =
    /^(\d+) municipalities with pulse · (\d+) below 3 components( · roadworks feed without current data)?$/.exec(
      line,
    );
  return match === null
    ? line
    : `${match[1] ?? ""}|${match[2] ?? ""}|${match[3] === undefined ? "live" : "stale"}`;
}

function componentsOf(sides: Sides, ags: string): unknown {
  const entity = sides.portBroker.upserts
    .flat()
    .find((e) => isRecord(e) && e.id === `urn:ngsi-ld:CityPulse:bw-${ags}`);
  return isRecord(entity) && isRecord(entity.components) ? normalize(entity.components.value) : undefined;
}

/** Whether a `components` value (normalised) names `component`. */
function hasComponent(components: unknown, component: string): boolean {
  if (!Array.isArray(components)) return false;
  return components.some((entry: unknown) => Array.isArray(entry) && entry[0] === component);
}

async function normalRunAndTheMethodByHand(): Promise<void> {
  const sides = await bothSides(broker());
  assertSame(sides, "normal run");
  assert.equal(portCounts(sides), legacyCounts(sides.legacy));
  assert.equal(portCounts(sides), "8|159|live");

  // Freiburg by hand, along the table in docs/framework-dashboards.md:
  //  feinstaub  100 − 6.3·4 = 74.8 → 75            ×0.3
  //  luftindex  (4 − 1)·25 = 75 (index 4 without dateObserved left out) ×0.2
  //  sharing    (412+380)/237,244·1000·20 → 67     ×0.1
  //  laden      45/120 → 37.5 → 38                 ×0.15
  //  baustellen 100 − 3·5 = 85 (svz ids only)      ×0.15
  //  oepnv      100 − 2.5·8 = 80                   ×0.2
  //  br         (30+7)/(120+40) → 23 (9 h old one left out) ×0.05
  //  warnungen  level 2 → 60                       ×0.2
  //  index      91.8 / 1.35 = 68.0 → 68
  assert.deepEqual(componentsOf(sides, "08311000"), [
    ["feinstaub", 75, 0.3],
    ["luftindex", 75, 0.2],
    ["sharing", 67, 0.1],
    ["laden", 38, 0.15],
    ["baustellen", 85, 0.15],
    ["oepnv", 80, 0.2],
    ["br", 23, 0.05],
    ["warnungen", 60, 0.2],
  ]);
  const freiburg = sides.portBroker.upserts
    .flat()
    .find((e) => isRecord(e) && e.id === "urn:ngsi-ld:CityPulse:bw-08311000");
  assert.ok(isRecord(freiburg) && isRecord(freiburg.pulseIndex));
  assert.equal(freiburg.pulseIndex.value, 68);
  // Mannheim: its median is 3 h old (no feinstaub), its 5 h old stop is ignored,
  // warning level 5 does not exist → 0. Of its UBA stations (3, 4 but 5 h old,
  // 1) the worst current one counts: (4 − 3)·25 = 25.
  assert.deepEqual(componentsOf(sides, "08222000"), [
    ["luftindex", 25, 0.2],
    ["sharing", 40, 0.1],
    ["laden", 86, 0.15],
    ["baustellen", 90, 0.15],
    ["oepnv", 68, 0.2],
    ["warnungen", 0, 0.2],
  ]);
  // Ulm: PM2.5 null falls back to PM10; two alerts, the higher counts.
  const ulm = componentsOf(sides, "08421000");
  assert.ok(Array.isArray(ulm));
  assert.deepEqual(ulm[0], ["feinstaub", 26, 0.3]);
  assert.deepEqual(ulm[ulm.length - 1], ["warnungen", 30, 0.2]);
  // Gutsbezirk Münsingen: no population → no sharing, still three components;
  // UBA index 0 ("sehr gut") → 100.
  assert.deepEqual(componentsOf(sides, "08415971"), [
    ["luftindex", 100, 0.2],
    ["laden", 100, 0.15],
    ["baustellen", 100, 0.15],
    ["warnungen", 100, 0.2],
  ]);
  // Offenburg: the median above 400 is dropped and the bike parking has no
  // capacity, leaving roadworks and delay — below the minimum. Rheinau (F):
  // sharing without population dropped → below the minimum too.
  assert.equal(componentsOf(sides, "08317096"), undefined);
  assert.equal(componentsOf(sides, "08317971"), undefined);
}

/** Freiburg with three other components and the given UBA records. */
function scoreFreiburg(aq: readonly AirRecord[], now: string): unknown {
  const ags = "08311000";
  const raw: PulseListings = {
    pt: [{ ags, observedMs: Date.parse(now), delay: 0 }],
    br: [],
    aq,
    sh: [{ ags, vehicles: 10 }],
    ch: [{ ags, live: 10, available: 5 }],
    rw: [],
    al: [],
  };
  const entity = summarize(raw, sharedGeo(fixtureGeo()).index(), now).entities.find(
    (e) => e.id === `urn:ngsi-ld:CityPulse:bw-${ags}`,
  );
  return entity?.components.value.find(([name]) => name === "luftindex")?.[1];
}

function uba(index: number | undefined, ageMs: number | null, nowMs: number): AirRecord {
  // observedMs 0 is what parse() makes of a record without dateObserved.
  return {
    ags: "08311000",
    observedMs: ageMs === null ? 0 : nowMs - ageMs,
    median: false,
    pm: undefined,
    index,
  };
}

function luftindexOnTheUbaScale(): void {
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  // Deliberate deviation: 0 (sehr gut) … 4 (sehr schlecht) → 100 … 0; the old
  // node scored (5 − index)·25 and gave 0 and 1 both 100.
  const scores = [0, 1, 2, 3, 4].map((index) => scoreFreiburg([uba(index, HOUR, nowMs)], now));
  assert.deepEqual(scores, [100, 75, 50, 25, 0]);
  // Current means at most UBA_MAX_AGE_MS old; without dateObserved (before
  // uba-bw wrote one) the component is left out, not scored and not an error.
  assert.equal(scoreFreiburg([uba(2, UBA_MAX_AGE_MS, nowMs)], now), 50);
  assert.equal(scoreFreiburg([uba(2, UBA_MAX_AGE_MS + 1, nowMs)], now), undefined);
  assert.equal(scoreFreiburg([uba(2, null, nowMs)], now), undefined);
  assert.equal(scoreFreiburg([uba(undefined, HOUR, nowMs)], now), undefined);
}

async function worstCurrentStationCounts(): Promise<void> {
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  // Order does not matter, the stale and the undated station do not count.
  const stations = [
    uba(1, HOUR, nowMs),
    uba(3, 2 * HOUR, nowMs),
    uba(4, 5 * HOUR, nowMs),
    uba(4, null, nowMs),
  ];
  assert.equal(scoreFreiburg(stations, now), 25);
  assert.equal(scoreFreiburg([...stations].reverse(), now), 25);

  // Against the old node on the UNADAPTED listings: it took the last
  // Mannheim station in the listing (index 1 → (5 − 1)·25 = 100), stale or not.
  const raw = broker();
  const legacy = await runFunctionNode(NODE_ID, {
    msg: { _msgid: "parity", payload: Date.now() },
    global: legacyGlobal(fixtureGeo()),
    flow: {},
    modules: { http: fakeHttpModule(raw.respond) },
  });
  const mannheim = legacyEntities(legacy).find(
    (entity) => isRecord(entity) && entity.id === "urn:ngsi-ld:CityPulse:bw-08222000",
  );
  assert.ok(isRecord(mannheim) && isRecord(mannheim.components));
  const components = normalize(mannheim.components.value);
  assert.ok(Array.isArray(components));
  assert.deepEqual(
    components[0],
    ["luftindex", 100, 0.2],
    "the old node's answer changed – revisit the deviation",
  );
  const sides = await bothSides(broker());
  const ported = componentsOf(sides, "08222000");
  assert.ok(Array.isArray(ported));
  assert.deepEqual(ported[0], ["luftindex", 25, 0.2]);
}

async function roadworksFeedStaleOrEmpty(): Promise<void> {
  const stale = await bothSides(
    broker((records) => {
      for (const record of records.get("RoadWork") ?? []) {
        record.dateObserved = new Date(Date.now() - 30 * HOUR).toISOString();
      }
    }),
  );
  assertSame(stale, "stale roadworks");
  assert.equal(portCounts(stale), legacyCounts(stale.legacy));
  assert.match(portCounts(stale), /\|stale$/);
  assert.ok(!hasComponent(componentsOf(stale, "08311000"), "baustellen"));

  const none = await bothSides(broker((records) => records.set("RoadWork", [])));
  assertSame(none, "no roadworks");
  assert.equal(portCounts(none), legacyCounts(none.legacy));
}

async function missingPopulation(): Promise<void> {
  const geo = fixtureGeo();
  const rows = structuredClone(geo.municipalities);
  assert.ok(Array.isArray(rows));
  const freiburg: unknown = rows.find((row: unknown) => Array.isArray(row) && row[0] === "08311000");
  assert.ok(Array.isArray(freiburg));
  freiburg[6] = null;
  const sides = await bothSides(broker(), { geo: { ...geo, municipalities: rows } });
  assertSame(sides, "no population");
  assert.ok(!hasComponent(componentsOf(sides, "08311000"), "sharing"));
}

async function noMunicipalityWithThreeComponents(): Promise<void> {
  const sides = await bothSides(
    broker((records) => {
      // Only roadworks and alerts left: one component per municipality at most.
      for (const type of records.keys()) if (type !== "RoadWork" && type !== "Alert") records.set(type, []);
    }),
  );
  assertSame(sides, "below the minimum everywhere");
  assert.deepEqual(sides.portWarnings, ["Puls-BW: no municipality with 3 components"]);
  assert.equal(sides.portBroker.upserts.length, 0);
}

function bikeParking(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `urn:ngsi-ld:BikeParking:bw-bulk-${String(i).padStart(4, "0")}`,
    type: "BikeParking",
    ags: "08421000",
    availableSpotNumber: 1,
    totalSpotNumber: 2,
    dateObserved: new Date(Date.now() - 20 * HOUR).toISOString(),
  }));
}

async function paginationCompleteAndIncomplete(): Promise<void> {
  // 1,256 BikeParking: two pages of 1,000 on both sides.
  const big = broker((records) =>
    records.set("BikeParking", [...(records.get("BikeParking") ?? []), ...bikeParking(1250)]),
  );
  const complete = await bothSides(big);
  assertSame(complete, "two pages");
  const pages = Broker.listings(complete.portSeen).filter((query) =>
    query.some(([key, value]) => key === "type" && value === "BikeParking"),
  );
  assert.equal(pages.length, 2);

  // Offset paging while others write: the second page repeats an id of the
  // first, one entity is never seen — deduplicated, the count check fails, and
  // both skip the whole run with the same warning.
  const shifted = big.clone();
  shifted.listAnswer.set("BikeParking", (request) => {
    if (request.url.searchParams.get("offset") !== "1000") return undefined;
    const all = [...shifted.entities.values()].filter((entity) => entity.type === "BikeParking");
    return httpResponse(200, JSON.stringify([all[999], ...all.slice(1001)]), {
      "ngsild-results-count": String(all.length),
    });
  });
  const incomplete = await bothSides(shifted);
  assertSame(incomplete, "incomplete listing");
  assert.deepEqual(incomplete.portWarnings, [
    "Puls-BW: query failed, run skipped (BikeParking: incomplete (1255/1256))",
  ]);
  assert.equal(incomplete.portBroker.upserts.length, 0);

  const failing = broker();
  failing.listAnswer.set("SharingSummary", () => httpResponse(503, "busy"));
  const failed = await bothSides(failing);
  assertSame(failed, "HTTP 503");
  assert.deepEqual(failed.portWarnings, ["Puls-BW: query failed, run skipped (SharingSummary: HTTP 503)"]);
}

async function gateCycleWithReplace(): Promise<void> {
  const store = new SignatureStore();
  const source = broker();
  const first = await bothSides(source, { store });
  const table = (): unknown => normalize(Object.fromEntries(store.scope("puls-bw").copy(GATE_KEY)));
  let flow = await legacyCommit(first.legacy);
  assert.deepEqual(table(), normalize(flow[GATE_KEY]), "committed signatures differ");

  // Same data: freshness only, on both sides.
  const second = await bothSides(source, { store, flow });
  assertSame(second, "unchanged");
  assert.ok(
    second.portBroker.upserts.flat().every((entity) => isRecord(entity) && Object.keys(entity).length === 4),
  );
  flow = await legacyCommit(second.legacy);

  // Freiburg loses its data (below the minimum): replace drops its signature.
  const shrunk = broker((records) => {
    for (const [type, list] of records) {
      if (type !== "RoadWork")
        records.set(
          type,
          list.filter((entity) => entity.ags !== "08311000"),
        );
    }
  });
  const third = await bothSides(shrunk, { store, flow });
  assertSame(third, "shrunk");
  flow = await legacyCommit(third.legacy);
  assert.deepEqual(table(), normalize(flow[GATE_KEY]));
  const after = table();
  assert.ok(isRecord(after) && Object.keys(after).length === 7);
  assert.ok(!Object.hasOwn(after, "urn:ngsi-ld:CityPulse:bw-08311000"));
}

/** The old commit node over every emitted chunk, as after a confirmed (204) upsert. */
async function legacyCommit(legacy: FunctionNodeRun): Promise<Record<string, unknown>> {
  let flow = flowOf(legacy);
  for (const message of messagesOf(legacy)) {
    if (!isRecord(message)) continue;
    flow = flowOf(
      await runFunctionNode(COMMIT_NODE_ID, { msg: { ...message, statusCode: 204, payload: "" }, flow }),
    );
  }
  return flow;
}

async function aDriftedComponentFails(): Promise<void> {
  const sides = await bothSides(broker());
  const drifted = sides.portBroker.upserts
    .flat()
    .map((entity, i) =>
      i === 0 && isRecord(entity) ? { ...entity, pulseIndex: { type: "Property", value: 0 } } : entity,
    );
  assert.throws(() => {
    assertEntitiesEqual(legacyEntities(sides.legacy), drifted);
  }, /\[0\]\.pulseIndex/);
}

async function pruneOfDroppedPulses(): Promise<void> {
  const geo = fullGeo();
  const rows = geo.municipalities;
  assert.ok(Array.isArray(rows));
  const old = {
    type: "Property",
    value: { "@type": "DateTime", "@value": new Date(Date.now() - 30 * HOUR).toISOString() },
  };
  const source = broker();
  source.municipalityCount = rows.length;
  for (const ags of ["08111000", "08212000", "08317971"]) {
    source.add({
      id: `urn:ngsi-ld:CityPulse:bw-${ags}`,
      type: "CityPulse",
      ags: { type: "Property", value: ags },
      dateObserved: old,
    });
  }
  // Same type, stale, written by someone else: the broker ignores idPattern
  // on a prune's listing, so only the local id re-check keeps it.
  const foreign = "urn:ngsi-ld:CityPulse:reutlingen-puls";
  source.add({ id: foreign, type: "CityPulse", dateObserved: old });

  const legacyBroker = source.clone();
  let flow: Record<string, unknown> = {};
  let context: Record<string, unknown> = {};
  const legacyDeletes: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    const legacy = await runFunctionNode(NODE_ID, {
      msg: { _msgid: "parity", payload: Date.now() },
      global: legacyGlobal(geo),
      flow,
      context,
      modules: { http: fakeHttpModule(legacyBroker.respond) },
    });
    await sleep(150);
    flow = flowOf(legacy);
    context = Object.fromEntries(legacy.context);
    legacyDeletes.push(legacyBroker.deletes.flat().length);
  }

  const portBroker = source.clone();
  const port = testCtx("puls-bw", sharedGeo(geo), portBroker.respond);
  const { log } = port;
  const recorded = recordPrunes(port.ctx);
  const { ctx } = recorded;
  const portDeletes: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    await run(ctx);
    portDeletes.push(portBroker.deletes.flat().length);
  }
  assert.deepEqual(portDeletes, [0, 3], "armed in the first run, deleting in the second");
  assertPruneSettings("puls-bw", legacyPruneSettings(NODE_ID), recorded.calls, ctx);
  assert.deepEqual(portDeletes, legacyDeletes);
  assert.deepEqual(portBroker.deletes.flat().sort(), legacyBroker.deletes.flat().sort());
  assert.deepEqual(log.warnings(), []);
  assert.ok(portBroker.entities.has("urn:ngsi-ld:CityPulse:bw-08311000"), "a pulse of this run was deleted");
  assert.ok(portBroker.entities.has(foreign), "port: a foreign pulse was deleted");
  assert.ok(legacyBroker.entities.has(foreign), "old: a foreign pulse was deleted");
}

async function unknownResponseForRouting(): Promise<void> {
  // The broker answers unknown routes with 404; a sanity check that the port
  // only ever talks to the entities and upsert endpoints in a normal run.
  const sides = await bothSides(broker());
  const paths = new Set(sides.portSeen.map((request) => `${request.method} ${request.url.pathname}`));
  assert.deepEqual([...paths].sort(), [
    "GET /ngsi-ld/v1/entities",
    "POST /ngsi-ld/v1/entityOperations/upsert",
  ]);
  const response: HttpResponse | Error = sides.portBroker.respond({
    method: "GET",
    url: new URL("http://orion-ld:1026/x"),
    target: "/x",
    body: undefined,
  });
  assert.ok(!(response instanceof Error) && response.status === 404);
}

export {
  normalRunAndTheMethodByHand as "puls-bw: old node and run(ctx) write identical pulses; Freiburg scored by hand along the documented method",
  luftindexOnTheUbaScale as "puls-bw: luftindex on the UBA's 0–4 scale (0 → 100, 4 → 0), only from a current index (deliberate deviation)",
  worstCurrentStationCounts as "puls-bw: the worst current UBA station of a municipality counts, not the last one listed (deliberate deviation)",
  roadworksFeedStaleOrEmpty as "puls-bw: a stale or empty roadworks feed drops the component everywhere, on both sides",
  missingPopulation as "puls-bw: without a population figure there is no sharing component, on both sides",
  noMunicipalityWithThreeComponents as "puls-bw: fewer than three components everywhere warns and writes nothing, as before",
  paginationCompleteAndIncomplete as "puls-bw: two pages complete; a shifted page or an HTTP 503 skips the run with the same warning",
  gateCycleWithReplace as "puls-bw: gate in replace mode — commit, freshness-only rerun and a dropped pulse match the old tables",
  aDriftedComponentFails as "puls-bw: a drifted pulse index fails the comparison with its path",
  pruneOfDroppedPulses as "puls-bw: dropped pulses are pruned on the second run exactly as by the old node",
  unknownResponseForRouting as "puls-bw: a normal run only lists entities and upserts",
};
