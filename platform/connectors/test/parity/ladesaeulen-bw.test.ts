/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: ladesaeulen-bw — the page fan-out (`udp-rt-bo-msgs`), FN_OC_WRAP
 * (`udp-rt-bo-wrap`), the build node (`udp-rt-bo-build`) and the commit node
 * (`udp-rt-bo-commit`) against the port.
 *
 * Pinned: all pages from `total_count` (and the cap of 60 with its warning),
 * the page completeness that decides everything else, `replace: complete` on
 * both gate tables (an incomplete run merges, a complete one drops what left
 * the source), the confirmation reset of an incomplete run, the deduplication
 * with the old `Object.keys` order, and a complete run's prunes, including the
 * `ocSig` signatures they forget.
 *
 * Fixtures: test/fixtures/ladesaeulen-bw-count.json and
 * ladesaeulen-bw-offset{10000,20000}.json (see their `note`s). A consistent
 * one-page world (`total_count` = the locations of both pages, all served at
 * offset 0) is derived from them for the complete runs — test input, not
 * fixture data.
 */

import assert from "node:assert/strict";
import {
  build,
  CONFIRM_KEYS,
  COUNT_URL,
  pageUrl,
  parse,
  run,
  STATION_GATE,
  SUMMARY_GATE,
  wrapPage,
} from "../../src/connectors/ladesaeulen-bw.js";
import { readFixture } from "../harness/fixtures.js";
import { fakeHttpModule, httpResponse } from "../harness/kernel.js";
import {
  arrayField,
  Broker,
  flowObject,
  flowTable,
  fullGeo,
  HOUR,
  jsonAnswer,
  legacyGlobal,
  mobilityCtx,
  tableObject,
} from "../harness/mobility.js";
import type { MobilityWorld } from "../harness/mobility.js";
import { assertEntitiesEqual, isRecord, normalize } from "../harness/normalize.js";
import { messagesOf, runFunctionNode } from "../harness/vm-runner.js";
import type { FunctionNodeRun } from "../harness/vm-runner.js";

const LIST_NODE = "udp-rt-bo-msgs";
const WRAP_NODE = "udp-rt-bo-wrap";
const BUILD_NODE = "udp-rt-bo-build";
const COMMIT_NODE = "udp-rt-bo-commit";

interface Answer {
  readonly statusCode: number;
  readonly payload: unknown;
}

function recorded(name: string): { url: string; payload: Record<string, unknown> } {
  const fixture = readFixture(name);
  const payload = structuredClone(fixture.payload);
  assert.ok(isRecord(payload));
  return { url: fixture.source, payload };
}

function items(payload: Record<string, unknown>): unknown[] {
  return Array.isArray(payload.items) ? payload.items : [];
}

/** The two recorded pages as one consistent page (test input). */
function onePageWorld(): { count: Record<string, unknown>; page: Record<string, unknown> } {
  const all = [
    ...items(recorded("ladesaeulen-bw-offset10000").payload),
    ...items(recorded("ladesaeulen-bw-offset20000").payload),
  ];
  return {
    count: { ...recorded("ladesaeulen-bw-count").payload, total_count: all.length },
    page: { items: all },
  };
}

/* ── the old nodes ───────────────────────────────────────────────────────── */

async function legacyPages(count: Answer): Promise<FunctionNodeRun> {
  return runFunctionNode(LIST_NODE, { msg: { _msgid: "parity", ...count } });
}

interface LegacyBuild {
  readonly run: FunctionNodeRun;
  readonly messages: unknown[];
  readonly entities: unknown[];
  readonly pending: unknown[];
}

/** Wrap node per page, then the build node on the joined parts. */
async function legacyBuild(
  pages: readonly Answer[],
  expected: number,
  total: number,
  flow: Readonly<Record<string, unknown>>,
  broker: Broker,
): Promise<LegacyBuild> {
  const parts: unknown[] = [];
  for (const page of pages) {
    const wrapped = await runFunctionNode(WRAP_NODE, {
      msg: { _msgid: "parity", ...page, ocSeiten: expected, ocGesamt: total },
    });
    parts.push(isRecord(wrapped.returned) ? wrapped.returned.payload : undefined);
  }
  const result = await runFunctionNode(BUILD_NODE, {
    msg: { _msgid: "parity", payload: parts },
    global: legacyGlobal(fullGeo()),
    flow,
    modules: { http: fakeHttpModule(broker.respond) },
  });
  const messages = messagesOf(result);
  return {
    run: result,
    messages,
    entities: messages.flatMap((message) => arrayField(message, "payload")),
    pending: messages.flatMap((message) => arrayField(message, "sigCommit")),
  };
}

async function legacyCommit(legacy: LegacyBuild): Promise<Record<string, unknown>> {
  let flow = flowObject(legacy.run.flow);
  for (const message of legacy.messages) {
    if (!isRecord(message)) continue;
    const commit = await runFunctionNode(COMMIT_NODE, {
      msg: { ...message, statusCode: 204, payload: "" },
      flow,
    });
    flow = flowObject(commit.flow);
  }
  return flow;
}

function assertTables(flow: Readonly<Record<string, unknown>>, world: MobilityWorld, when: string): void {
  const map = new Map(Object.entries(flow));
  for (const key of [SUMMARY_GATE, STATION_GATE]) {
    assert.deepEqual(
      normalize(tableObject(world.store, key)),
      normalize(flowTable(map, key)),
      `${when}: ${key} differs`,
    );
  }
}

function wire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/* ── 1. pages from total_count ───────────────────────────────────────────── */

async function pagesFollowTotalCount(): Promise<void> {
  const count = recorded("ladesaeulen-bw-count");
  const legacy = await legacyPages({ statusCode: 200, payload: count.payload });
  const oldUrls = messagesOf(legacy).map((message) => (isRecord(message) ? message.url : undefined));
  assert.equal(oldUrls.length, 32);

  const world = mobilityCtx({ id: "ladesaeulen-bw", start: Date.now() });
  world.broker.sources.set(COUNT_URL, jsonAnswer(count.payload));
  await run(world.ctx);
  const requested = world.broker.requests
    .filter((request) => request.url.origin !== "http://orion-ld:1026" && request.url.href !== COUNT_URL)
    .map((request) => request.url.href);
  assert.deepEqual(requested, oldUrls, "page requests differ");
  assert.equal(count.url, COUNT_URL);

  // Cap: 99,000 locations -> 60 pages and a warning, on both sides.
  const capped = await legacyPages({ statusCode: 200, payload: { total_count: 99_000 } });
  assert.equal(messagesOf(capped).length, 60);
  const cappedWorld = mobilityCtx({ id: "ladesaeulen-bw", start: Date.now() });
  cappedWorld.broker.sources.set(COUNT_URL, jsonAnswer({ total_count: 99_000 }));
  await run(cappedWorld.ctx);
  assert.equal(
    cappedWorld.broker.requests.filter((request) => request.url.href.includes("limit=1000")).length,
    60,
  );
  assert.match(cappedWorld.log.warnings()[0] ?? "", /capped at 60/);
  assert.equal(capped.warnings.length, 1);

  // No readable count, or zero: skipped with a warning.
  for (const answer of [
    { statusCode: 503, payload: "" },
    { statusCode: 200, payload: { total_count: 0 } },
  ]) {
    const old = await legacyPages(answer);
    assert.equal(messagesOf(old).length, 0);
    assert.equal(old.warnings.length, 1);
    const skipped = mobilityCtx({ id: "ladesaeulen-bw", start: Date.now() });
    skipped.broker.sources.set(
      COUNT_URL,
      answer.statusCode === 200 ? jsonAnswer(answer.payload) : httpResponse(answer.statusCode, ""),
    );
    await run(skipped.ctx);
    assert.equal(skipped.log.warnings().length, 1);
    assert.equal(skipped.broker.requests.length, 1, "went on without a count");
  }
}

/* ── 2. incomplete run: merge, no prune, confirmations reset ─────────────── */

async function incompleteRunMergesAndResets(): Promise<void> {
  const count = recorded("ladesaeulen-bw-count");
  const served = [recorded("ladesaeulen-bw-offset10000"), recorded("ladesaeulen-bw-offset20000")];
  const total = Number(count.payload.total_count);
  const pages = Math.ceil(total / 1000);
  const answers: Answer[] = [];
  for (let page = 0; page < pages; page += 1) {
    const hit = served.find((fixture) => fixture.url === pageUrl(page));
    answers.push(
      hit === undefined ? { statusCode: 404, payload: "" } : { statusCode: 200, payload: hit.payload },
    );
  }

  const world = mobilityCtx({ id: "ladesaeulen-bw", start: Date.now() });
  world.broker.sources.set(COUNT_URL, jsonAnswer(count.payload));
  for (const fixture of served) world.broker.sources.set(fixture.url, jsonAnswer(fixture.payload));
  // Signatures of a station on a page that failed this time: merge keeps them.
  const elsewhere = "urn:ngsi-ld:EVChargingStation:ulm-ocpdb-1";
  world.store.replace(STATION_GATE, new Map([[elsewhere, "2|0|0|0|0"]]));
  const oldBroker = new Broker(0);

  let flow: Record<string, unknown> = { [STATION_GATE]: { [elsewhere]: "2|0|0|0|0" } };
  for (const round of [1, 2]) {
    world.broker.upserts.length = 0;
    const legacy = await legacyBuild(answers, pages, total, flow, oldBroker);
    await run(world.ctx);
    assert.deepEqual(
      normalize(world.broker.upserts),
      normalize(legacy.messages.map((message) => wire(arrayField(message, "payload")))),
      `round ${String(round)}: upserts differ`,
    );
    assert.ok(legacy.run.warnings.some((line) => line.includes("incomplete run")));
    assert.match(
      world.log.warnings().at(-1) ?? "",
      /^OCPDB: incomplete run \(2\/32 pages, 28\/31461 locations\) — no prune$/,
    );
    for (const key of CONFIRM_KEYS) assert.deepEqual(flowTable(legacy.run.flow, key), {}, key);
    flow = await legacyCommit(legacy);
    assertTables(flow, world, `round ${String(round)}`);
  }
  assert.ok(world.store.copy(STATION_GATE).has(elsewhere), "an incomplete run replaced the table");
  assert.deepEqual(
    world.pruneCalls.map((call) => `${call.kind}:${call.key}`),
    [...CONFIRM_KEYS, ...CONFIRM_KEYS].map((key) => `reset:${key}`),
  );
  assert.deepEqual(world.broker.listings(), [], "an incomplete run listed for a prune");
}

/* ── 3. dedupe and the Object.keys order ─────────────────────────────────── */

async function dedupeKeepsTheOldOrder(): Promise<void> {
  // Test input: the later page first (insertion order != numeric order), and
  // one location repeated on the second page with a changed name — the later
  // row wins, in the position of the first.
  const late = recorded("ladesaeulen-bw-offset20000").payload;
  const early = recorded("ladesaeulen-bw-offset10000").payload;
  const repeated = items(late)
    .filter(isRecord)
    .find((item) => {
      const at = isRecord(item.coordinates) ? item.coordinates : {};
      return fullGeo().index.municipalityAt(Number(at.latitude), Number(at.longitude)) !== null;
    });
  assert.ok(repeated !== undefined);
  early.items = [...items(early), { ...repeated, name: "Wiederholt" }];
  const answers: Answer[] = [
    { statusCode: 200, payload: late },
    { statusCode: 200, payload: early },
  ];
  const total = items(late).length + items(early).length;
  const now = new Date().toISOString();
  const legacy = await legacyBuild(answers, 2, total, {}, new Broker(0));
  const ported = build(parse({ expectedPages: 2, announced: total, pages: answers }), fullGeo().index, now);
  assert.ok(ported.complete);
  assertEntitiesEqual(legacy.entities, [...ported.summaries, ...ported.stations], {
    labels: { left: "old (Node-RED function node)", right: "new (build)" },
  });
  assert.ok(ported.stations.some((station) => station.name.value === "Wiederholt"));
  // wrapPage on a failed page is the old "kopf": marked, not dropped.
  assert.deepEqual(wrapPage(503, ""), { ok: false, items: 0, rows: [] });
}

/* ── 4. complete runs: replace, prune ────────────────────────────────────── */

const STALE_STATION = "urn:ngsi-ld:EVChargingStation:ulm-ocpdb-999999";
const STALE_SUMMARY = "urn:ngsi-ld:ChargingSummary:bw-08000000";

function seed(broker: Broker): void {
  broker.entities.set(STALE_STATION, { id: STALE_STATION, type: "EVChargingStation" });
  broker.entities.set(STALE_SUMMARY, { id: STALE_SUMMARY, type: "ChargingSummary" });
}

async function completeRunReplacesAndPrunes(): Promise<void> {
  const world1 = onePageWorld();
  const now = Date.now();

  // Old: one complete run, prune state seeded as if the previous runs had happened.
  const oldBroker = new Broker(fullGeo().municipalities.length);
  seed(oldBroker);
  const total = items(world1.page).length;
  const legacy = await legacyBuild(
    [{ statusCode: 200, payload: world1.page }],
    1,
    total,
    {
      [STATION_GATE]: { [STALE_STATION]: "1|0|0|0|0" },
      pruneLastRun_OCPDB_EVChargingStation: now - HOUR,
      pruneLastRun_OCPDB_ChargingSummary: now - HOUR,
      ocPruneStation: { [STALE_STATION]: [now - 25 * HOUR, 1] },
      ocPruneSummary: { [STALE_SUMMARY]: [now - 25 * HOUR, 1] },
    },
    oldBroker,
  );
  await oldBroker.idle();
  assert.deepEqual(legacy.run.warnings, [], `old: ${legacy.run.warnings.join(" | ")}`);

  // Port: hourly runs from cold for 26 h.
  const world = mobilityCtx({ id: "ladesaeulen-bw", start: now - 26 * HOUR });
  seed(world.broker);
  world.broker.sources.set(COUNT_URL, jsonAnswer(world1.count));
  world.broker.sources.set(pageUrl(0), jsonAnswer(world1.page));
  world.store.replace(STATION_GATE, new Map([[STALE_STATION, "1|0|0|0|0"]]));
  for (let hour = 0; hour <= 26; hour += 1) {
    world.clock.now = now - 26 * HOUR + hour * HOUR;
    await run(world.ctx);
  }
  assert.deepEqual(
    world.log.warnings().filter((line) => !line.startsWith("Upsert")),
    [],
  );
  assert.deepEqual(world.broker.deletes.flat().sort(), oldBroker.deletes.flat().sort(), "pruned ids differ");
  assert.deepEqual(oldBroker.deletes.flat().sort(), [STALE_SUMMARY, STALE_STATION].sort());
  assert.deepEqual(
    [...new Set(world.broker.listings())].sort(),
    [...new Set(oldBroker.listings())].sort(),
    "prune listings differ",
  );
  const oldSig = legacy.run.flow.get(STATION_GATE);
  assert.ok(isRecord(oldSig) && !(STALE_STATION in oldSig), "old: signature of the pruned station kept");
  assert.ok(!world.store.copy(STATION_GATE).has(STALE_STATION), "port: signature of the pruned station kept");
}

async function completeRunReplacesTheTables(): Promise<void> {
  // Two complete runs; in the second one a live location left the source.
  const first = onePageWorld();
  const second = onePageWorld();
  // The only location of its municipality, so its sum leaves as well.
  const agsOf = (item: Record<string, unknown>): string | undefined => {
    const at = isRecord(item.coordinates) ? item.coordinates : {};
    return fullGeo().index.agsAt(Number(at.latitude), Number(at.longitude)) ?? undefined;
  };
  const located = items(second.page).filter(isRecord);
  const gone = located.find((item) => {
    const ags = agsOf(item);
    return ags !== undefined && located.filter((other) => agsOf(other) === ags).length === 1;
  });
  assert.ok(gone !== undefined);
  second.page.items = items(second.page).filter((item) => item !== gone);
  second.count.total_count = items(second.page).length;

  const oldBroker = new Broker(0);
  const world = mobilityCtx({ id: "ladesaeulen-bw", start: Date.now() });
  let flow: Record<string, unknown> = {};
  for (const [round, input] of [first, second].entries()) {
    world.broker.sources.set(COUNT_URL, jsonAnswer(input.count));
    world.broker.sources.set(pageUrl(0), jsonAnswer(input.page));
    world.broker.upserts.length = 0;
    const total = items(input.page).length;
    const legacy = await legacyBuild([{ statusCode: 200, payload: input.page }], 1, total, flow, oldBroker);
    await run(world.ctx);
    assert.deepEqual(
      normalize(world.broker.upserts),
      normalize(legacy.messages.map((message) => wire(arrayField(message, "payload")))),
      `run ${String(round + 1)}: upserts differ`,
    );
    flow = await legacyCommit(legacy);
    assertTables(flow, world, `run ${String(round + 1)} after commit`);
  }
  const goneId = [...world.store.copy(STATION_GATE).keys()].find((id) =>
    id.endsWith(`-ocpdb-${String(gone.id)}`),
  );
  assert.equal(goneId, undefined, "the vanished location keeps its signature (replace not applied)");
  const goneSum = `urn:ngsi-ld:ChargingSummary:bw-${agsOf(gone) ?? ""}`;
  assert.ok(!world.store.copy(SUMMARY_GATE).has(goneSum), "the vanished sum keeps its signature");
}

export {
  pagesFollowTotalCount as "ladesaeulen-bw: all pages from total_count, the cap of 60 and the skips match the old fan-out",
  incompleteRunMergesAndResets as "ladesaeulen-bw: an incomplete run writes the old chunks, merges the tables, resets the confirmations",
  dedupeKeepsTheOldOrder as "ladesaeulen-bw: deduplication and Object.keys order of the old build node",
  completeRunReplacesAndPrunes as "ladesaeulen-bw: a complete run prunes the same stations and sums and forgets their ocSig",
  completeRunReplacesTheTables as "ladesaeulen-bw: complete runs replace ocSumSig/ocSig, a vanished location loses its signature",
};
