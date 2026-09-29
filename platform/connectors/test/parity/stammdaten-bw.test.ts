/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: stammdaten-bw — FN_MUNI (`udp-rt-bm-fn`) and the signature commit
 * node behind its upsert (`udp-rt-bm-commit`) against the ported module plus
 * the kernel's change gate.
 *
 * Not only the entities are compared. This connector is the smallest complete
 * example of the two-phase gate, so the test pins the whole cycle against the
 * old flow: first run (everything changed, signatures pending), the commit of a
 * confirmed upsert, the second run (freshness only), and a run with one changed
 * municipality. It also checks what the node puts into the geo context
 * (`global.bwGemeinden`), because that is what twenty other connectors read.
 *
 * Fixture: test/fixtures/stammdaten-bw.json — 167 real rows of
 * gui/public/bw-gemeinden.json, trimmed as described in its `note`.
 */

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { build, DEFAULT_URL, parse, run, signatureOf } from "../../src/connectors/stammdaten-bw.js";
import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import type { SignatureScope } from "../../src/kernel/change-gate.js";
import { chunk } from "../../src/kernel/orion.js";
import type { MunicipalityRow, NgsiEntity, UpsertPlan } from "../../src/kernel/types.js";
import { messageFromFixture, readFixture } from "../harness/fixtures.js";
import { recordingLog } from "../harness/kernel.js";
import {
  assertClockStamps,
  assertEntitiesEqual,
  assertStampsWithin,
  isRecord,
  normalize,
  openClock,
} from "../harness/normalize.js";
import { loadFunctionNode, messagesOf, runFunctionNode } from "../harness/vm-runner.js";
import { jsonAnswer, upsertedBatches, weatherCtx, weatherFetcher } from "../harness/weather-ctx.js";
import type { ScriptedAnswer } from "../harness/weather-ctx.js";
import type { FunctionNodeRun } from "../harness/vm-runner.js";

const NODE_ID = "udp-rt-bm-fn";
const COMMIT_NODE_ID = "udp-rt-bm-commit";
const FIXTURE = "stammdaten-bw";
const GATE_KEY = "muniSig";
/** As FN_MUNI: `emitChunks(node, msg, geaendert, 150)`. */
const CHUNK_SIZE = 150;

interface Legacy {
  readonly run: FunctionNodeRun;
  readonly messages: unknown[];
  readonly entities: unknown[];
  readonly pending: unknown[];
}

function arrayField(message: unknown, key: string): unknown[] {
  if (!isRecord(message)) return [];
  const value = message[key];
  return Array.isArray(value) ? value : [];
}

async function runLegacy(payload: unknown, flow: Readonly<Record<string, unknown>> = {}): Promise<Legacy> {
  const fixture = readFixture(FIXTURE);
  const msg = { ...messageFromFixture(fixture), payload: structuredClone(payload) };
  const run = await runFunctionNode(NODE_ID, { msg, flow });
  const messages = messagesOf(run);
  return {
    run,
    messages,
    entities: messages.flatMap((message) => arrayField(message, "payload")),
    pending: messages.flatMap((message) => arrayField(message, "sigCommit")),
  };
}

/** The flow context as a plain object, for handing it to the next run. */
function flowObject(run: FunctionNodeRun): Record<string, unknown> {
  return Object.fromEntries(run.flow);
}

function assertPlanMatches(legacy: Legacy, plan: UpsertPlan): void {
  assertEntitiesEqual(legacy.entities, plan.entities);
  assert.deepEqual(normalize(legacy.pending), normalize(plan.pending), "pending signatures differ");
  assert.deepEqual(
    legacy.messages.map((message) => arrayField(message, "payload").length),
    chunk(plan.entities, CHUNK_SIZE).map((part) => part.length),
    "chunking differs",
  );
}

function ported(payload: unknown, gateStore: SignatureScope): UpsertPlan {
  const file = parse(payload);
  const entities = build(file, null, new Date().toISOString());
  const gate = createChangeGate(gateStore, recordingLog());
  return gate.check(GATE_KEY, entities, signatureOf);
}

/** Commits like a confirmed upsert of every chunk (HTTP 204) on both sides. */
async function commitAll(
  legacy: Legacy,
  plan: UpsertPlan,
  store: SignatureScope,
): Promise<Record<string, unknown>> {
  let flow = flowObject(legacy.run);
  for (const message of legacy.messages) {
    if (!isRecord(message)) continue;
    const commit = await runFunctionNode(COMMIT_NODE_ID, {
      msg: { ...message, statusCode: 204, payload: "" },
      flow,
    });
    assert.deepEqual(commit.warnings, [], "the old commit node warned on a confirmed upsert");
    flow = flowObject(commit);
  }
  store.commit(plan.pending, new Set(plan.entities.map((entity: NgsiEntity) => entity.id)));
  return flow;
}

async function firstRunIsIdentical(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const legacy = await runLegacy(fixture.payload);
  const store = new SignatureStore().scope("test");
  const plan = ported(fixture.payload, store);

  assert.deepEqual(legacy.run.warnings, []);
  assert.equal(plan.entities.length, 167);
  assert.equal(legacy.messages.length, 2, "167 municipalities are two chunks of at most 150");
  assertPlanMatches(legacy, plan);

  // What the geo context receives: the rows as they came, all nine columns.
  assert.deepEqual(
    normalize(legacy.run.global.get("bwGemeinden")),
    normalize(parse(fixture.payload).gemeinden),
    "global bwGemeinden differs from the parsed rows",
  );
  // Merge mode on an empty table: nothing is stored before the commit.
  assert.deepEqual(normalize(legacy.run.flow.get(GATE_KEY)), {});
  assert.equal(store.copy(GATE_KEY).size, 0);
}

async function commitThenFreshnessOnly(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const first = await runLegacy(fixture.payload);
  const store = new SignatureStore().scope("test");
  const firstPlan = ported(fixture.payload, store);
  const flow = await commitAll(first, firstPlan, store);

  assert.deepEqual(
    normalize(flow[GATE_KEY]),
    normalize(Object.fromEntries(store.copy(GATE_KEY))),
    "committed signature tables differ",
  );
  assert.equal(store.copy(GATE_KEY).size, 167);

  // Second run on the committed table: every municipality unchanged, so only
  // `{ id, type, dateObserved, @context }` goes out, and nothing is pending.
  const second = await runLegacy(fixture.payload, flow);
  const secondPlan = ported(fixture.payload, store);
  assertPlanMatches(second, secondPlan);
  assert.equal(secondPlan.pending.length, 0);
  assert.deepEqual(Object.keys(secondPlan.entities[0] ?? {}).sort(), [
    "@context",
    "dateObserved",
    "id",
    "type",
  ]);
}

async function oneChangedMunicipality(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const first = await runLegacy(fixture.payload);
  const store = new SignatureStore().scope("test");
  const flow = await commitAll(first, ported(fixture.payload, store), store);

  // Same input, one population figure changed — a test input, not fixture data.
  const changed = structuredClone(fixture.payload);
  const rows = isRecord(changed) ? changed.gemeinden : undefined;
  const row: unknown = Array.isArray(rows) ? rows[3] : undefined;
  assert.ok(Array.isArray(row) && typeof row[6] === "number", "fixture row 3 has a population");
  row[6] = row[6] + 1;

  const legacy = await runLegacy(changed, flow);
  const plan = ported(changed, store);
  assertPlanMatches(legacy, plan);
  assert.equal(plan.pending.length, 1);
  assert.equal(plan.entities.filter((entity) => "population" in entity).length, 1);
}

async function apostropheIsSwappedAsBefore(): Promise<void> {
  // The real file has no straight apostrophe in any name; the swap is pinned on
  // a modified copy of the input instead.
  const fixture = readFixture(FIXTURE);
  const input = structuredClone(fixture.payload);
  const rows = isRecord(input) ? input.gemeinden : undefined;
  const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
  assert.ok(Array.isArray(row));
  row[1] = "L'Isle-sur-Test";

  const legacy = await runLegacy(input);
  const plan = ported(input, new SignatureStore().scope("test"));
  assertPlanMatches(legacy, plan);
  const name = plan.entities[0]?.name;
  assert.ok(isRecord(name));
  assert.equal(name.value, "L’Isle-sur-Test");
}

/**
 * The chunk size FN_MUNI hands `emitChunks` — read out of the old node itself,
 * so a drifted constant on either side cannot agree with a copy in this file.
 */
function oldChunkSize(): number {
  const match = /emitChunks\(node, msg, geaendert, (\d+)\)/.exec(loadFunctionNode(NODE_ID).func);
  const size = match?.[1];
  assert.ok(size !== undefined, "FN_MUNI calls emitChunks(node, msg, geaendert, <size>)");
  return Number(size);
}

function sizesOf(batches: readonly (readonly unknown[])[]): number[] {
  return batches.map((batch) => batch.length);
}

async function runFillsTheGeoContextAndUpsertsTheOldChunks(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const size = oldChunkSize();
  const legacyClock = openClock();
  const first = await runLegacy(fixture.payload);
  const legacyWindow = legacyClock.close();
  assert.ok(first.entities.length > size, "the fixture crosses the chunk boundary");

  let answer: ScriptedAnswer = jsonAnswer(200, fixture.payload);
  const network = weatherFetcher((call) => {
    if (call.method === "POST") return { response: { status: 204, ok: true, headers: {}, body: "" } };
    if (call.url === DEFAULT_URL) return answer;
    return { response: new Error(`unexpected call ${call.method} ${call.url}`) };
  });
  const { ctx, kernel, log } = weatherCtx("stammdaten-bw", network.fetcher);
  // Read through a function: a narrowing assert on the getter would stick.
  const context = (): readonly MunicipalityRow[] | null => kernel.geo.municipalities;
  assert.equal(context(), null);

  // Run 1: the geo context is filled — with what the old node put into
  // global.bwGemeinden — and every municipality goes out in the old chunks.
  const portClock = openClock();
  await run(ctx);
  const portWindow = portClock.close();
  assert.deepEqual(log.warnings(), []);
  assert.deepEqual(
    normalize(context()),
    normalize(first.run.global.get("bwGemeinden")),
    "geo context differs from the old global bwGemeinden",
  );
  const firstBatches = upsertedBatches(network.seen);
  assertEntitiesEqual(first.entities, firstBatches.flat());
  assertClockStamps(first.entities, firstBatches.flat(), { legacy: legacyWindow, ported: portWindow });
  assert.deepEqual(
    sizesOf(firstBatches),
    sizesOf(first.messages.map((message) => arrayField(message, "payload"))),
    "upsert chunks differ from the old node's",
  );
  assert.deepEqual(sizesOf(firstBatches), sizesOf(chunk(first.entities, size)), `chunks of ${String(size)}`);

  // Run 2: confirmed by 204, nothing changed — freshness only, in the same
  // chunks, stamped with the clock of that run; the geo context is set again.
  const store = new SignatureStore().scope("test");
  const flow = await commitAll(first, ported(fixture.payload, store), store);
  const second = await runLegacy(fixture.payload, flow);
  await sleep(5);
  const secondClock = openClock();
  await run(ctx);
  const secondWindow = secondClock.close();
  const secondBatches = upsertedBatches(network.seen).slice(firstBatches.length);
  assertEntitiesEqual(second.entities, secondBatches.flat());
  assert.deepEqual(
    sizesOf(secondBatches),
    sizesOf(second.messages.map((message) => arrayField(message, "payload"))),
    "freshness chunks differ from the old node's",
  );
  for (const entity of secondBatches.flat()) {
    assert.deepEqual(Object.keys(isRecord(entity) ? entity : {}).sort(), [
      "@context",
      "dateObserved",
      "id",
      "type",
    ]);
  }
  assertStampsWithin(secondBatches.flat(), secondWindow, first.entities);
  assert.equal(context()?.length, first.entities.length);

  // Run 3: HTTP 404 — warned, nothing written, the previous context stays.
  const previous = context();
  answer = jsonAnswer(404, "not found");
  const upsertsBefore = upsertedBatches(network.seen).length;
  await run(ctx);
  assert.equal(context(), previous, "a 404 replaced the geo context");
  assert.equal(upsertedBatches(network.seen).length, upsertsBefore);
  assert.match(log.warnings().at(-1) ?? "", /bw-gemeinden\.json not loadable \(HTTP 404\)/);
  const legacy404 = await runFunctionNode(NODE_ID, {
    msg: { ...messageFromFixture(fixture), statusCode: 404, payload: "not found" },
    global: { bwGemeinden: "previous" },
  });
  assert.equal(legacy404.warnings.length, 1);
  assert.equal(legacy404.global.get("bwGemeinden"), "previous", "the old node kept its context too");
}

export {
  runFillsTheGeoContextAndUpsertsTheOldChunks as "stammdaten-bw: run() fills the geo context, upserts the old chunks, then freshness only; a 404 keeps the context",
  firstRunIsIdentical as "stammdaten-bw: old FN_MUNI and ported build() + change gate emit identical chunks, signatures and geo context",
  commitThenFreshnessOnly as "stammdaten-bw: commit after a confirmed upsert matches the old commit node, next run is freshness only",
  oneChangedMunicipality as "stammdaten-bw: one changed municipality is sent in full, the rest as freshness, on both sides",
  apostropheIsSwappedAsBefore as "stammdaten-bw: straight apostrophes are swapped exactly as in the old node",
};
