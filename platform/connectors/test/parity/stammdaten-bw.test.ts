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
import { build, parse, signatureOf } from "../../src/connectors/stammdaten-bw.js";
import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import type { SignatureScope } from "../../src/kernel/change-gate.js";
import { chunk } from "../../src/kernel/orion.js";
import type { NgsiEntity, UpsertPlan } from "../../src/kernel/types.js";
import { messageFromFixture, readFixture } from "../harness/fixtures.js";
import { recordingLog } from "../harness/kernel.js";
import { assertEntitiesEqual, isRecord, normalize } from "../harness/normalize.js";
import { messagesOf, runFunctionNode } from "../harness/vm-runner.js";
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

export {
  firstRunIsIdentical as "stammdaten-bw: old FN_MUNI and ported build() + change gate emit identical chunks, signatures and geo context",
  commitThenFreshnessOnly as "stammdaten-bw: commit after a confirmed upsert matches the old commit node, next run is freshness only",
  oneChangedMunicipality as "stammdaten-bw: one changed municipality is sent in full, the rest as freshness, on both sides",
  apostropheIsSwappedAsBefore as "stammdaten-bw: straight apostrophes are swapped exactly as in the old node",
};
