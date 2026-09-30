/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: mastr-bw — the rotation `udp-rt-bx-msgs`, the slimming node
 * `udp-rt-bx-wrap` and the aggregation `udp-rt-bx-build` against `plan`,
 * `slimPage` and `parse` + `build`, then two whole runs of `run(ctx)` against
 * the old chain over the same scripted source.
 *
 * The rotation state (`mastrPos`, `mastrCount`) was global context; its
 * effect — where the next night starts, how many pages a municipality gets —
 * is compared after every step.
 *
 * Fixture: test/fixtures/mastr-bw.json (page 1 for four municipalities).
 * Pages beyond the first are scripted as the source answers them: no rows,
 * same `Total`.
 */

import assert from "node:assert/strict";
import {
  build,
  COUNTS,
  countsOf,
  failedMunicipalities,
  pageFailed,
  parse,
  plan,
  POSITION,
  run,
  slimPage,
} from "../../src/connectors/mastr-bw.js";
import type { MastrRequest } from "../../src/connectors/mastr-bw.js";
import type { HttpResponse, MunicipalityRow } from "../../src/kernel/types.js";
import { Broker, fixtureGeo, legacyEntities, sharedGeo, testCtx } from "../harness/air-energy-kernel.js";
import { readFixture } from "../harness/fixtures.js";
import { httpResponse } from "../harness/kernel.js";
import type { SeenRequest } from "../harness/kernel.js";
import {
  assertClockStamps,
  assertEntitiesEqual,
  isRecord,
  normalize,
  openClock,
} from "../harness/normalize.js";
import { messagesOf, runFunctionNode } from "../harness/vm-runner.js";

const MSGS_NODE = "udp-rt-bx-msgs";
const WRAP_NODE = "udp-rt-bx-wrap";
const BUILD_NODE = "udp-rt-bx-build";

function rows(): readonly MunicipalityRow[] {
  return sharedGeo(fixtureGeo()).index().municipalities;
}

/** Recorded page 1 per municipality name. */
function recorded(): Map<string, unknown> {
  const payload = readFixture("mastr-bw").payload;
  assert.ok(Array.isArray(payload));
  const out = new Map<string, unknown>();
  for (const entry of payload) {
    assert.ok(isRecord(entry) && typeof entry.name === "string");
    out.set(entry.name, entry.payload);
  }
  return out;
}

/** The source: recorded page 1, empty further pages with the same Total, empty elsewhere. */
function source(request: { readonly name: string; readonly page: number }): unknown {
  const page = recorded().get(request.name);
  if (!isRecord(page)) return { Data: [], Total: 0, AggregateResults: [], Errors: null };
  return request.page === 1 ? page : { ...page, Data: [] };
}

/** `mastrCount` of the old global context as a map. */
function countsFrom(value: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (isRecord(value))
    for (const [ags, count] of Object.entries(value)) if (typeof count === "number") out.set(ags, count);
  return out;
}

async function legacyPlan(global: Record<string, unknown>) {
  const result = await runFunctionNode(MSGS_NODE, { msg: { _msgid: "parity", payload: 0 }, global });
  const requests = messagesOf(result).map((message) =>
    isRecord(message)
      ? { url: message.url, ags: message.ags, name: message.gemName, page: message.page }
      : null,
  );
  return { result, requests };
}

async function rotationIsIdentical(): Promise<void> {
  const gemeinden = fixtureGeo().municipalities;
  const cases: [label: string, position: number, counts: Record<string, number>][] = [
    ["first night, nothing known: ten pages each", 0, {}],
    [
      "wrapping around the end, counts known",
      100,
      { "08336010": 14, "08336106": 1999, "08315130": 2001, "08222000": 25_000, "08421000": 0 },
    ],
  ];
  for (const [label, position, counts] of cases) {
    const legacy = await legacyPlan({ bwGemeinden: gemeinden, mastrPos: position, mastrCount: counts });
    const ported = plan(rows(), position, new Map(Object.entries(counts)));
    assert.deepEqual(normalize(legacy.requests), normalize(ported.requests), `${label}: requests differ`);
    assert.equal(
      legacy.result.global.get("mastrPos"),
      ported.nextPosition,
      `${label}: next position differs`,
    );
  }
  const first = plan(rows(), 0, new Map());
  assert.equal(first.requests.length, 1500);
  assert.equal(first.nextPosition, 150);
  const wrapped = plan(rows(), 100, new Map([["08222000", 25_000]]));
  assert.equal(wrapped.nextPosition, (100 + 150) % 167);
  assert.ok(
    first.requests.some((request) => request.url.includes("M%C3%BCnstertal%2FSchwarzwald")),
    "names are URI-encoded, slash included",
  );
}

async function slimmingIsIdentical(): Promise<void> {
  const request: MastrRequest = { url: "x", ags: "08315130", name: "Münstertal/Schwarzwald", page: 1 };
  const cases: [status: number, payload: unknown][] = [
    ...[...recorded().values()].map((payload): [number, unknown] => [200, payload]),
    [500, { Data: [{ Bruttoleistung: 1 }], Total: 1 }],
    [200, { Data: null, Total: 4 }],
    [200, "<html>maintenance</html>"],
    [
      200,
      {
        Data: [
          { Bruttoleistung: 3.5, InbetriebnahmeDatum: "/Date(631152000000)/" },
          { InbetriebnahmeDatum: null },
        ],
      },
    ],
  ];
  for (const [status, payload] of cases) {
    const legacy = await runFunctionNode(WRAP_NODE, {
      msg: {
        _msgid: "parity",
        ags: request.ags,
        page: request.page,
        statusCode: status,
        payload: structuredClone(payload),
      },
    });
    const message = messagesOf(legacy)[0];
    assert.deepEqual(
      normalize(isRecord(message) ? message.payload : undefined),
      normalize(slimPage(request, status, payload)),
      `slimmed page differs (HTTP ${String(status)})`,
    );
  }
}

/** Page 1 of the four recorded municipalities, wherever they sit in the rotation. */
function recordedRequests(): MastrRequest[] {
  return rows()
    .filter((row) => recorded().has(row[1]))
    .map((row) => ({ url: "", ags: row[0], name: row[1], page: 1 }));
}

/** Old wrap over every request, joined in request order — the build node's input. */
async function legacyJoined(requests: readonly MastrRequest[]): Promise<unknown[]> {
  const joined: unknown[] = [];
  for (const request of requests) {
    const wrapped = await runFunctionNode(WRAP_NODE, {
      msg: {
        _msgid: "parity",
        ags: request.ags,
        page: request.page,
        statusCode: 200,
        payload: source(request),
      },
    });
    const message = messagesOf(wrapped)[0];
    joined.push(isRecord(message) ? message.payload : undefined);
  }
  return joined;
}

async function aggregationIsIdentical(): Promise<void> {
  const requests = recordedRequests();
  const joined: unknown[] = await legacyJoined(requests);
  // A hole (a part the join never got), and a synthetic page with plants from
  // before 2000, an unknown date and an unparseable one.
  joined.splice(3, 0, undefined);
  joined.push({
    ags: "08336010",
    page: 2,
    total: 20,
    rows: [
      [2.5, 1995],
      [1.25, 1999],
      [4, 0],
      [7, Number.NaN],
    ],
  });
  const legacy = await runFunctionNode(BUILD_NODE, {
    msg: { _msgid: "parity", payload: structuredClone(joined) },
    global: {},
  });
  const pages = parse(joined);
  const ported = build(pages, null, new Date().toISOString());
  assertEntitiesEqual(legacyEntities(legacy), ported);
  assert.deepEqual(
    normalize(legacy.global.get("mastrCount")),
    normalize(Object.fromEntries(countsOf(pages))),
    "cached plant counts differ",
  );
  assert.equal(ported.length, 4);
  const boellen = ported.find((entity) => entity.id.endsWith("08336010"));
  assert.ok(boellen !== undefined);
  assert.equal(boellen.additionsByYear.value[0]?.[0], 1999, "years before 2000 pooled as 1999");
  assert.equal(boellen.complete.value, false, "18 of 20 plants seen");
}

async function aDriftedCapacityFails(): Promise<void> {
  const requests = recordedRequests();
  const joined = await legacyJoined(requests);
  const legacy = await runFunctionNode(BUILD_NODE, {
    msg: { _msgid: "parity", payload: joined },
    global: {},
  });
  const drifted = build(parse(joined), null, new Date().toISOString()).map((entity, i) =>
    i === 1
      ? {
          ...entity,
          installedCapacityKw: { ...entity.installedCapacityKw, value: entity.installedCapacityKw.value + 1 },
        }
      : entity,
  );
  assert.throws(() => {
    assertEntitiesEqual(legacyEntities(legacy), drifted);
  }, /\[1\]\.installedCapacityKw\.value/);
}

async function twoNightsLikeTheOldChain(): Promise<void> {
  const geo = fixtureGeo();
  const broker = new Broker();
  const respond = (request: SeenRequest): HttpResponse | Error => {
    if (request.url.host !== "www.marktstammdatenregister.de") return broker.respond(request);
    const filter = request.url.searchParams.get("filter") ?? "";
    const name = /Gemeinde~eq~'(.*)'~and~Betriebs/.exec(filter)?.[1] ?? "";
    const page = Number(request.url.searchParams.get("page"));
    return httpResponse(200, JSON.stringify(source({ name, page })));
  };
  const { ctx, log, seen } = testCtx("mastr-bw", sharedGeo(geo), respond);

  let global: Record<string, unknown> = { bwGemeinden: geo.municipalities };
  for (const night of [1, 2]) {
    const before = seen.length;
    const upsertsBefore = broker.upserts.length;
    const portClock = openClock();
    await run(ctx);
    const portWindow = portClock.close();
    const legacy = await legacyPlan(global);
    const requests = plan(rows(), Number(global.mastrPos ?? 0), countsFrom(global.mastrCount)).requests;
    const joined = await legacyJoined(requests);
    const legacyClock = openClock();
    const built = await runFunctionNode(BUILD_NODE, {
      msg: { _msgid: "parity", payload: joined },
      global: Object.fromEntries(legacy.result.global),
    });
    const legacyWindow = legacyClock.close();
    global = Object.fromEntries(built.global);

    const upserts = broker.upserts.length - upsertsBefore;
    assert.equal(
      seen.length - before - upserts,
      legacy.requests.length,
      `night ${String(night)}: page requests differ`,
    );
    // The requests themselves, in order — not only their number.
    assert.deepEqual(
      seen
        .slice(before)
        .filter((request) => request.url.host === "www.marktstammdatenregister.de")
        .map((request) => request.url.href),
      legacy.requests.map((request) => (request === null ? null : request.url)),
      `night ${String(night)}: the list of page requests differs`,
    );
    assertEntitiesEqual(legacyEntities(built), broker.upserts.slice(upsertsBefore).flat());
    assertClockStamps(legacyEntities(built), broker.upserts.slice(upsertsBefore).flat(), {
      legacy: legacyWindow,
      ported: portWindow,
    });
    assert.equal(
      ctx.state.slot(POSITION).get(),
      global.mastrPos,
      `night ${String(night)}: rotation position differs`,
    );
    assert.deepEqual(
      normalize(Object.fromEntries(ctx.state.slot(COUNTS).get())),
      normalize(global.mastrCount),
      `night ${String(night)}: cached counts differ`,
    );
  }
  // Night 1: 150 municipalities × 10 pages. Night 2 wraps around the 167 rows:
  // the 17 not yet seen get ten pages, the 133 cached ones (all below 2,000
  // plants, most with none) one page each.
  assert.equal(
    seen.filter((request) => request.url.host === "www.marktstammdatenregister.de").length,
    1500 + 17 * 10 + 133,
  );
  assert.deepEqual(log.warnings(), []);
}

async function failedPagesKeepTheLastValue(): Promise<void> {
  // DELIBERATE DEVIATION (data review): the old chain wrote a municipality
  // with a failed page as 0 plants, 0 kW, complete — and cached the count 0.
  // Now it is left out: no entity, no cache update, one [warn] per run.
  assert.equal(pageFailed(500, { Data: [] }), true);
  assert.equal(pageFailed(null, null), true);
  assert.equal(pageFailed(200, { Total: 3 }), true, "no Data array");
  assert.equal(pageFailed(200, "maintenance"), true);
  assert.equal(pageFailed(200, { Data: [], Total: 0 }), false, "an empty page is an answer");
  const requests: MastrRequest[] = [
    { url: "", ags: "08000001", name: "A", page: 1 },
    { url: "", ags: "08000001", name: "A", page: 2 },
    { url: "", ags: "08000002", name: "B", page: 1 },
    { url: "", ags: "08000003", name: "C", page: 1 },
  ];
  assert.deepEqual(
    [...failedMunicipalities(requests, [false, true, false, undefined])],
    ["08000001", "08000003"],
    "a failed page and a page never requested (aborted run) both count",
  );

  const geo = fixtureGeo();
  const broker = new Broker();
  // Münstertal (446 plants): page 1 answers, page 2 of the ten fails.
  // Sölden: every page answers.
  const failing = "Münstertal/Schwarzwald";
  const respond = (request: SeenRequest): HttpResponse | Error => {
    if (request.url.host !== "www.marktstammdatenregister.de") return broker.respond(request);
    const filter = request.url.searchParams.get("filter") ?? "";
    const name = /Gemeinde~eq~'(.*)'~and~Betriebs/.exec(filter)?.[1] ?? "";
    const page = Number(request.url.searchParams.get("page"));
    if (name === failing && page === 2) return httpResponse(503, "<html>busy</html>");
    return httpResponse(200, JSON.stringify(source({ name, page })));
  };
  const { ctx, log } = testCtx("mastr-bw", sharedGeo(geo), respond);
  const failingAgs = rows().find((row) => row[1] === failing)?.[0];
  const fineAgs = rows().find((row) => row[1] === "Sölden")?.[0];
  assert.ok(failingAgs !== undefined && fineAgs !== undefined);
  await run(ctx);

  const written = new Set(broker.upserts.flat().map((entity) => (isRecord(entity) ? String(entity.id) : "")));
  assert.equal(written.has(`urn:ngsi-ld:EnergyMonitor:bw-${failingAgs}`), false, "no zeros written");
  assert.equal(written.has(`urn:ngsi-ld:EnergyMonitor:bw-${fineAgs}`), true);
  const counts = ctx.state.slot(COUNTS).get();
  assert.equal(counts.has(failingAgs), false, "no page count cached from a failed municipality");
  assert.equal(counts.get(fineAgs), 203);
  assert.deepEqual(log.warnings(), [
    "MaStR-BW: 1 municipalities with failed pages skipped — they keep their last value and page count",
  ]);
}

export {
  rotationIsIdentical as "mastr-bw: old rotation node and plan() request the same pages and move on alike",
  slimmingIsIdentical as "mastr-bw: old slimming node and slimPage() agree on real, failed and odd pages",
  aggregationIsIdentical as "mastr-bw: old aggregation and ported build() agree, incl. holes, pre-2000 and unknown years",
  aDriftedCapacityFails as "mastr-bw: a drifted capacity fails the comparison with its path",
  twoNightsLikeTheOldChain as "mastr-bw: two nights of run(ctx) match the old chain — pages, entities, rotation, cached counts",
  failedPagesKeepTheLastValue as "mastr-bw: a municipality with a failed page is skipped, not written as zero, count not cached (deliberate)",
};
