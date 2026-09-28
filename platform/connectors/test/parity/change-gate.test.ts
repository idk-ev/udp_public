/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The change gate's contract beyond parity: per-connector namespaces, `retain`
 * as the only way to touch a table directly, and explicit ungated writes.
 */

import assert from "node:assert/strict";
import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import { createOrion } from "../../src/kernel/orion.js";
import type { EntityId, NgsiEntity } from "../../src/kernel/types.js";
import { httpResponse, recordingLog, scriptedFetcher } from "../harness/kernel.js";

const CONTEXT = "https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld";
const A: EntityId = "urn:ngsi-ld:T:a";
const B: EntityId = "urn:ngsi-ld:T:b";

function entity(id: EntityId, value: number): NgsiEntity {
  return { id, type: "T", level: { type: "Property", value }, "@context": CONTEXT };
}

const sigOf = (e: NgsiEntity): string => JSON.stringify(e.level);

async function tablesAreNamespacedPerConnector(): Promise<void> {
  const store = new SignatureStore();
  const pegel = store.scope("pegel-bw");
  const parken = store.scope("parken-bw");
  const log = recordingLog();
  const { fetcher } = scriptedFetcher(() => httpResponse(204));
  const pegelGate = createChangeGate(pegel, log);
  const parkenGate = createChangeGate(parken, log);

  await createOrion(log, fetcher, pegelGate, pegel).upsert(pegelGate.check("sig", [entity(A, 1)], sigOf));
  await createOrion(log, fetcher, parkenGate, parken).upsert(parkenGate.check("sig", [entity(B, 2)], sigOf));

  // Same key "sig", two tables that do not see each other.
  assert.deepEqual([...pegel.copy("sig").keys()], [A]);
  assert.deepEqual([...parken.copy("sig").keys()], [B]);
  assert.deepEqual(pegelGate.keys(), ["sig"]);
  // A prune's signatureKey in one connector cannot reach the other's table.
  parken.forget("sig", [A, B]);
  assert.deepEqual([...pegel.copy("sig").keys()], [A]);
  // …and the gate of one connector sees the other's entity as new.
  assert.equal(parkenGate.check("sig", [entity(A, 1)], sigOf).pending.length, 1);
}

function retainOnlyKeepsOrRemoves(): void {
  const store = new SignatureStore().scope("parken-bw");
  const gate = createChangeGate(store, recordingLog());
  store.replace(
    "parkStatik",
    new Map([
      [A, "s1"],
      [B, "s2"],
    ]),
  );

  gate.retain("parkStatik", (field) => field === A);
  assert.deepEqual([...gate.table("parkStatik")], [[A, "s1"]]);
  // The copy handed out is not the table: writing to it changes nothing.
  gate.table("parkStatik").set(B, "forged");
  assert.deepEqual([...gate.table("parkStatik")], [[A, "s1"]]);
  // A table left empty is dropped, as `flow.set(key, undefined)` did.
  gate.retain("parkStatik", () => false);
  assert.deepEqual(gate.keys(), []);
}

function ungatedIsAPlanWithoutSignatures(): void {
  const gate = createChangeGate(new SignatureStore().scope("baustellen-bw"), recordingLog());
  const plan = gate.ungated([entity(A, 1), entity(B, 2)]);
  assert.equal(plan.entities.length, 2);
  assert.deepEqual(plan.pending, []);
}

export {
  tablesAreNamespacedPerConnector as "change gate: signature tables are namespaced per connector",
  retainOnlyKeepsOrRemoves as "change gate: retain can only keep or drop confirmed entries, never write",
  ungatedIsAPlanWithoutSignatures as "change gate: ungated() makes an explicit plan without signatures",
};
