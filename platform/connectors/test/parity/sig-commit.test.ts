/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: commit of change signatures after an upsert — the old "Signaturen
 * bestätigen" node (SIG_COMMIT, here `udp-rt-bm-commit`) against
 * `Orion.upsert` with a pending plan.
 *
 * This is the fix for values frozen for weeks during Orion outages: a
 * signature stored before a lost write made the next run believe the value was
 * in the broker. So every broker answer is replayed on both sides — 2xx, the
 * forms of 207, errors, an unreadable body, a timeout — and the resulting
 * signature tables must be identical. On the new side the answer comes out of
 * a scripted fetcher; everything from chunking to commit is the real kernel.
 */

import assert from "node:assert/strict";
import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import type { SignatureScope } from "../../src/kernel/change-gate.js";
import { createOrion, describeAnswer, LOGGED_ERRORS } from "../../src/kernel/orion.js";
import type {
  EntityId,
  HttpResponse,
  NgsiEntity,
  PendingSignature,
  UpsertPlan,
} from "../../src/kernel/types.js";
import { httpResponse, recordingLog, scriptedFetcher } from "../harness/kernel.js";
import { normalize } from "../harness/normalize.js";
import { runFunctionNode } from "../harness/vm-runner.js";

const COMMIT_NODE_ID = "udp-rt-bm-commit";
const CONTEXT = "https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld";

const A: EntityId = "urn:ngsi-ld:Test:a";
const B: EntityId = "urn:ngsi-ld:Test:b";
const C: EntityId = "urn:ngsi-ld:Test:c";

const ENTITIES: readonly NgsiEntity[] = [A, B, C].map((id) => ({ id, type: "Test", "@context": CONTEXT }));

/** A table key with a prior state, so merge and removal are visible. */
const INITIAL: Readonly<Record<string, Readonly<Record<string, string | number>>>> = {
  sig: { [A]: "old-a", [B]: "old-b", "untouched-field": "keep" },
  zeroes: { "08311000": 4 },
};

/** Two tables and a removal (`value: null`), as `sharing-bw` committed a confirmed zero. */
const PENDING: readonly PendingSignature[] = [
  ["sig", A, "new-a", A],
  ["sig", B, "new-b", B],
  ["sig", C, 7, C],
  ["zeroes", "08311000", null, B],
];

interface Scenario {
  readonly name: string;
  /** What the old node sees as `msg.statusCode`; `undefined` = no response at all. */
  readonly statusCode: number | undefined;
  readonly body: string;
}

const SCENARIOS: readonly Scenario[] = [
  { name: "204 updated", statusCode: 204, body: "" },
  { name: "201 created", statusCode: 201, body: "" },
  { name: "207 with success ids", statusCode: 207, body: JSON.stringify({ success: [A, C], errors: [] }) },
  { name: "207 with success objects", statusCode: 207, body: JSON.stringify({ success: [{ entityId: B }] }) },
  {
    name: "207 with errors only",
    statusCode: 207,
    body: JSON.stringify({ errors: [{ entityId: A, error: { status: 400 } }] }),
  },
  { name: "207 without either list", statusCode: 207, body: JSON.stringify({ note: "?" }) },
  { name: "207 empty body", statusCode: 207, body: "" },
  { name: "207 null body", statusCode: 207, body: "null" },
  { name: "207 unreadable body", statusCode: 207, body: "<html>proxy error</html>" },
  { name: "400 bad request", statusCode: 400, body: '{"title":"Bad Request"}' },
  { name: "503 unavailable", statusCode: 503, body: "" },
  { name: "timeout / refused", statusCode: undefined, body: "" },
];

function tablesOf(store: SignatureScope): Record<string, Record<string, string | number>> {
  const out: Record<string, Record<string, string | number>> = {};
  for (const key of store.keys()) out[key] = Object.fromEntries(store.copy(key));
  return out;
}

async function legacyTables(scenario: Scenario): Promise<{ tables: unknown; warned: boolean }> {
  const run = await runFunctionNode(COMMIT_NODE_ID, {
    msg: {
      _msgid: "parity",
      statusCode: scenario.statusCode,
      payload: scenario.body,
      sigCommit: PENDING.map((pending) => [...pending]),
    },
    flow: structuredClone(INITIAL),
  });
  return {
    tables: normalize({ sig: run.flow.get("sig"), zeroes: run.flow.get("zeroes") }),
    warned: run.warnings.length > 0,
  };
}

async function portedTables(scenario: Scenario): Promise<{ tables: unknown; warned: boolean }> {
  const store = new SignatureStore().scope("test");
  for (const [key, table] of Object.entries(INITIAL)) store.replace(key, new Map(Object.entries(table)));
  const { fetcher, seen } = scriptedFetcher((): HttpResponse | Error =>
    scenario.statusCode === undefined
      ? new Error("connect ECONNREFUSED orion-ld:1026")
      : httpResponse(scenario.statusCode, scenario.body),
  );
  const log = recordingLog();
  const orion = createOrion(log, fetcher, createChangeGate(store, log), store, "http://orion-ld:1026");
  const plan: UpsertPlan = { entities: ENTITIES, pending: PENDING };
  await orion.upsert(plan);
  assert.equal(seen.length, 1, "one chunk, one request, no retry");
  return { tables: normalize(tablesOf(store)), warned: log.warnings().length > 0 };
}

async function everyBrokerAnswerCommitsTheSame(): Promise<void> {
  for (const scenario of SCENARIOS) {
    const legacy = await legacyTables(scenario);
    const ported = await portedTables(scenario);
    assert.deepEqual(ported.tables, legacy.tables, `${scenario.name}: committed tables differ`);
    assert.equal(ported.warned, legacy.warned, `${scenario.name}: one side warned, the other did not`);
  }
}

async function onlyTheChunksPendingIsCommitted(): Promise<void> {
  // Two chunks, the second one fails: the signatures riding on the first are
  // committed, those of the second are dropped — `sigsFor(chunk)` of the old
  // CHUNK_HELPER. A failed chunk must not cost the other chunk its commit.
  const store = new SignatureStore().scope("test");
  let call = 0;
  const { fetcher } = scriptedFetcher((): HttpResponse => {
    call += 1;
    return call === 1 ? httpResponse(204) : httpResponse(500, "boom");
  });
  const log = recordingLog();
  const orion = createOrion(log, fetcher, createChangeGate(store, log), store);
  const result = await orion.upsert({ entities: ENTITIES, pending: PENDING }, { chunkSize: 2 });
  assert.equal(result.chunks, 2);
  assert.equal(result.failedChunks, 1);
  assert.deepEqual([...result.confirmed], [A, B]);
  // `zeroes` exists but is empty: the confirmed removal ran on a table that did
  // not exist yet, which SIG_COMMIT answers with `flow.get(key) || {}` too.
  assert.deepEqual(tablesOf(store), { sig: { [A]: "new-a", [B]: "new-b" }, zeroes: {} });
  assert.equal(result.committed, 3);
  assert.equal(result.dropped, 1);
  assert.match(log.warnings()[0] ?? "", /^Upsert not confirmed \(500\): 1 change signatures dropped/);
}

/** Orion-LD 1.6.0's per-entity error for a `null` value, as recorded from the broker. */
function nullValueError(id: EntityId): Record<string, unknown> {
  return {
    entityId: id,
    error: {
      type: "https://uri.etsi.org/ngsi-ld/errors/BadRequestData",
      title: "The use of NULL value is not recommended for JSON-LD (the whole attribute gets ignored)",
      detail: "https://uri.etsi.org/ngsi-ld/default-context/avgDelayMinutes",
      status: 400,
    },
  };
}

async function warningNamesTheErrorsFirst(): Promise<void> {
  // The shape of the efa-abfahrten warning that never showed its errors: a
  // long success list first, the errors behind it, the body cut at 200 chars.
  const ids: EntityId[] = Array.from(
    { length: 23 },
    (_, n): EntityId => `urn:ngsi-ld:PublicTransportStop:bw-stop-${String(n)}`,
  );
  const refused = ids.slice(16);
  const body = JSON.stringify({ success: ids.slice(0, 16), errors: refused.map(nullValueError) });
  const store = new SignatureStore().scope("test");
  const { fetcher } = scriptedFetcher((): HttpResponse => httpResponse(207, body));
  const log = recordingLog();
  const orion = createOrion(log, fetcher, createChangeGate(store, log), store);
  const entities = ids.map((id) => ({ id, type: "PublicTransportStop", "@context": CONTEXT }));
  const pending: PendingSignature[] = ids.map((id) => [`sig:${id}`, "departures", "x", id]);
  const result = await orion.upsert({ entities, pending });
  assert.equal(result.dropped, 7);
  assert.equal(log.warnings().length, 1);
  const [warning = ""] = log.warnings();
  assert.ok(
    warning.startsWith(
      "Upsert not confirmed (207): 7 change signatures dropped, entities will be sent again — 7 refused, 16 ok: " +
        `${refused[0] ?? ""}: The use of NULL value is not recommended for JSON-LD (the whole attribute gets ignored)` +
        " — https://uri.etsi.org/ngsi-ld/default-context/avgDelayMinutes; ",
    ),
    warning,
  );
  assert.ok(warning.endsWith(" (+4 more)"), warning);
  assert.ok(!warning.includes(`${ids[0] ?? "-"}:`), "the success list is counted, not listed");
}

async function refusedUngatedEntitiesWarn(): Promise<void> {
  // No pending signatures (an ungated write): nothing is dropped, but a 207
  // with refused entities is still worth a warning — it used to pass silently.
  const store = new SignatureStore().scope("test");
  const body = JSON.stringify({ success: [A, C], errors: [nullValueError(B)] });
  const log = recordingLog();
  const orion = createOrion(
    log,
    scriptedFetcher((): HttpResponse => httpResponse(207, body)).fetcher,
    createChangeGate(store, log),
    store,
  );
  const result = await orion.upsert({ entities: ENTITIES, pending: [] });
  assert.deepEqual([...result.confirmed], [A, C]);
  assert.equal(result.failedChunks, 0);
  assert.match(
    log.warnings()[0] ?? "",
    /^orion upsert: 1 of 3 entities not confirmed \(207\) — 1 refused, 2 ok: urn:ngsi-ld:Test:b: The use of NULL value/,
  );
  // A fully confirmed 207 stays quiet.
  const quiet = recordingLog();
  const all = JSON.stringify({ success: [A, B, C], errors: [] });
  const ok = createOrion(
    quiet,
    scriptedFetcher((): HttpResponse => httpResponse(207, all)).fetcher,
    createChangeGate(store, quiet),
    store,
  );
  await ok.upsert({ entities: ENTITIES, pending: [] });
  assert.deepEqual(quiet.warnings(), []);
}

function brokerAnswersAreSummarised(): void {
  assert.equal(describeAnswer(""), "");
  assert.equal(
    describeAnswer(JSON.stringify({ type: "x", title: "Bad Request", detail: "no entities" })),
    "Bad Request — no entities",
  );
  assert.equal(describeAnswer("<html>proxy error</html>"), "<html>proxy error</html>");
  assert.equal(describeAnswer("x".repeat(1000)).length, 300);
  // An error without problem details still names its entity.
  assert.equal(
    describeAnswer(JSON.stringify({ errors: [{ entityId: A }] })),
    `1 refused: ${A}: {"entityId":"${A}"}`,
  );
  assert.equal(LOGGED_ERRORS, 3);
}

export {
  everyBrokerAnswerCommitsTheSame as "signature commit: old SIG_COMMIT node and Orion.upsert commit identically for every broker answer",
  onlyTheChunksPendingIsCommitted as "signature commit: each chunk commits only its own pending signatures",
  warningNamesTheErrorsFirst as "signature commit: a 207 warning names the refused entities and their errors, and counts the rest",
  refusedUngatedEntitiesWarn as "signature commit: a 207 with refused entities warns without pending signatures too",
  brokerAnswersAreSummarised as "signature commit: broker answers are summarised for the log (problem details, clipped bodies)",
};
