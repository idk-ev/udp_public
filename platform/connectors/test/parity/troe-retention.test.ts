/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: troe-retention — FN_TROE_RETENTION (`udp-rt-rt-fn`) against the
 * ported `run()`.
 *
 * The run is SQL from start to end, so the comparison is the conversation
 * with the database: both sides talk to the same scripted responder (the old
 * node through a fake `pg` module, the port through a scripted `Db`), keyed on
 * the PORT's statements, and the statement sequence must be identical byte for
 * byte — including how many batches the old-scheme loop sends before its cap,
 * and the ROLLBACK when the nightly totals fail. The warnings must carry the
 * same figures (the port words them in English), and the summary the same
 * counts.
 *
 * Parameters are compared as node-postgres puts them on the wire
 * (`prepareValue`); the id batch is a JavaScript array on both sides and
 * becomes the same Postgres array literal.
 *
 * No fixture file: the only input is row counts and entity ids, scripted per
 * scenario below. The ids are shaped like the old parken-bw scheme (slugged
 * site names) the step exists to clean up.
 *
 * Two DELIBERATE deviations (see the module header) are mapped out of the
 * comparison rather than hidden: the port never sends the old OffStreetParking
 * DELETE, and it asks SQL_LEGACY_OWN_IDS which candidates are parken-bw's own
 * before deleting. With every candidate owned, everything else is the old
 * conversation; the tests at the end pin the new behaviour.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  build,
  OLD_SCHEME_BATCH,
  OLD_SCHEME_CAP,
  parse,
  run,
  SQL_CLEAR_TYPE_STATS,
  SQL_CREATE_TYPE_STATS,
  SQL_DELETE_ATTRIBUTES_12M,
  LEGACY_CHECK_BATCH,
  LEGACY_PROVIDER,
  SQL_DELETE_BY_IDS,
  SQL_DELETE_SHORT_TIER,
  SQL_DELETE_SUBATTRIBUTES_12M,
  SQL_FILL_TYPE_STATS,
  SQL_INDEX_ATTRIBUTES_ENTITYID_TS,
  SQL_INDEX_ATTRIBUTES_TS,
  SQL_INDEX_SUBATTRIBUTES_TS,
  SQL_LEGACY_OWN_IDS,
  SQL_OLD_SCHEME_IDS,
} from "../../src/connectors/troe-retention.js";
import { isRecord, normalize } from "../harness/normalize.js";
import { testCtx } from "../harness/operations-ctx.js";
import type { TestCtx } from "../harness/operations-ctx.js";
import { fakePgModule, scriptedDb } from "../harness/operations-pg.js";
import type { FakePg, ScriptedDb, SqlAnswer, SqlCall, SqlResponder } from "../harness/operations-pg.js";
import { runFunctionNode } from "../harness/vm-runner.js";
import type { FunctionNodeRun } from "../harness/vm-runner.js";

const NODE_ID = "udp-rt-rt-fn";

/** The old node's OffStreetParking step, which the port no longer sends. */
const SQL_DELETE_ORPHANED = "DELETE FROM attributes WHERE entityid LIKE 'urn:ngsi-ld:OffStreetParking:%'";

/* ── node-postgres' own parameter serialisation ─────────────────────────────*/

type PrepareValue = (value: unknown) => unknown;

function isPrepareValue(value: unknown): value is PrepareValue {
  return typeof value === "function";
}

const pgUtils: unknown = createRequire(import.meta.url)("pg/lib/utils");
const prepareValue: PrepareValue = (() => {
  const candidate = isRecord(pgUtils) ? pgUtils.prepareValue : undefined;
  if (!isPrepareValue(candidate)) throw new Error("pg/lib/utils has no prepareValue");
  return candidate;
})();

/** What node-postgres puts on the wire for a parameter list. */
function wire(params: unknown): unknown {
  return Array.isArray(params) ? params.map((param) => prepareValue(param)) : params;
}

/* ── the scripted database ───────────────────────────────────────────────────*/

interface Scenario {
  attributes12m: number;
  subattributes12m: number;
  shortTier: number;
  orphaned: number;
  oldIds: string[];
  /** Candidates that are NOT parken-bw's (municipal B+R stations); default none. */
  foreign?: readonly string[];
  /** Makes the ownership query fail. */
  ownershipFails?: boolean;
  /** rowCount of the n-th old-scheme batch. */
  perBatch: (batch: number) => number;
  failOn?: string;
}

function oldIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    i % 2 === 0
      ? `urn:ngsi-ld:ParkingSite:bw-parkhaus-am-markt-${String(i)}`
      : `urn:ngsi-ld:BikeParking:bw-radstation-hbf-${String(i)}`,
  );
}

const NIGHT: Scenario = {
  attributes12m: 1_250_000,
  subattributes12m: 0,
  shortTier: 380_000,
  orphaned: 0,
  oldIds: oldIds(12),
  perBatch: (batch) => [350_000, 348_000, 120_000][batch] ?? 0,
};

function responder(s: Scenario): SqlResponder {
  let batch = 0;
  const counted = (rowCount: number): SqlAnswer => ({ rows: [], rowCount });
  return (sql, params) => {
    if (sql === s.failOn) return new Error("could not extend file: No space left on device");
    switch (sql) {
      case SQL_INDEX_ATTRIBUTES_TS:
      case SQL_INDEX_SUBATTRIBUTES_TS:
      case SQL_INDEX_ATTRIBUTES_ENTITYID_TS:
      case SQL_CREATE_TYPE_STATS:
        return { rows: [], rowCount: null };
      case SQL_DELETE_ATTRIBUTES_12M:
        return counted(s.attributes12m);
      case SQL_DELETE_SUBATTRIBUTES_12M:
        return counted(s.subattributes12m);
      case SQL_DELETE_SHORT_TIER:
        return counted(s.shortTier);
      case SQL_DELETE_ORPHANED:
        return counted(s.orphaned);
      case SQL_OLD_SCHEME_IDS:
        return { rows: s.oldIds.map((id) => ({ id })), rowCount: s.oldIds.length };
      case SQL_LEGACY_OWN_IDS: {
        if (s.ownershipFails === true) return new Error('column "text" does not exist');
        const batch: unknown = Array.isArray(params) ? params[0] : undefined;
        const ids = Array.isArray(batch) ? batch.filter((id): id is string => typeof id === "string") : [];
        const own = ids.filter((id) => !(s.foreign ?? []).includes(id));
        return { rows: own.map((id) => ({ id })), rowCount: own.length };
      }
      case SQL_DELETE_BY_IDS:
        batch += 1;
        return counted(s.perBatch(batch - 1));
      case "BEGIN":
      case "COMMIT":
      case "ROLLBACK":
        return { rows: [], rowCount: null };
      case SQL_CLEAR_TYPE_STATS:
        return counted(24);
      case SQL_FILL_TYPE_STATS:
        return counted(25);
      default:
        return new Error(`the scripted database does not know this statement: ${sql}`);
    }
  };
}

/* ── both sides ──────────────────────────────────────────────────────────────*/

interface Legacy {
  readonly pg: FakePg;
  readonly run: FunctionNodeRun | null;
  readonly failure: string | null;
}

async function runLegacy(s: Scenario): Promise<Legacy> {
  const pg = fakePgModule(responder(s));
  try {
    const result = await runFunctionNode(NODE_ID, {
      msg: { _msgid: "parity", payload: Date.now() },
      modules: { pg: pg.module },
      env: { TROE_DB_PASSWORD: "parity" },
    });
    return { pg, run: result, failure: null };
  } catch (error) {
    return { pg, run: null, failure: error instanceof Error ? error.message : String(error) };
  }
}

interface Ported {
  readonly db: ScriptedDb;
  readonly t: TestCtx;
  readonly failure: string | null;
}

async function runPorted(s: Scenario): Promise<Ported> {
  const db = scriptedDb(responder(s));
  const t = testCtx({ id: "troe-retention", db: db.db });
  try {
    await run(t.ctx);
    return { db, t, failure: null };
  } catch (error) {
    return { db, t, failure: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The old conversation with the two deliberate deviations applied: no
 * OffStreetParking DELETE, and the port's ownership queries right after the
 * candidate query (checked on their own in {@link assertOwnershipQueries}).
 */
function expectedCalls(legacy: Legacy, ported: Ported): SqlCall[] {
  const ownership = ported.db.calls.filter((call) => call.sql === SQL_LEGACY_OWN_IDS);
  const out: SqlCall[] = [];
  for (const call of legacy.pg.calls) {
    if (call.sql === SQL_DELETE_ORPHANED) continue;
    out.push(call);
    if (call.sql === SQL_OLD_SCHEME_IDS) out.push(...ownership);
  }
  return out;
}

/** One query per LEGACY_CHECK_BATCH candidates, in order, with parken-bw's provider. */
function assertOwnershipQueries(ported: Ported, candidates: readonly string[]): void {
  const queries = ported.db.calls.filter((call) => call.sql === SQL_LEGACY_OWN_IDS);
  const expected: unknown[] = [];
  for (let at = 0; at < candidates.length; at += LEGACY_CHECK_BATCH) {
    expected.push([candidates.slice(at, at + LEGACY_CHECK_BATCH), LEGACY_PROVIDER]);
  }
  assert.deepEqual(
    queries.map((call) => call.params),
    expected,
    "ownership queries differ",
  );
}

function assertSameConversation(legacy: Legacy, ported: Ported): void {
  const expected = expectedCalls(legacy, ported);
  assert.deepEqual(
    ported.db.calls.map((call) => call.sql),
    expected.map((call) => call.sql),
    "the statement sequence differs",
  );
  assert.deepEqual(
    normalize(ported.db.calls.map((call) => wire(call.params))),
    normalize(expected.map((call) => wire(call.params))),
    "the parameters differ on the wire",
  );
  assert.deepEqual(legacy.pg.events, ["connect", "end"], "the old node left its connection open");
  assert.deepEqual(ported.db.events, ["connect", "end"], "the port left its connection open");

  const config = normalize(legacy.pg.configs[0]);
  assert.ok(isRecord(config));
  const session = ported.db.sessions[0];
  assert.ok(session !== undefined);
  assert.equal(session.applicationName, config.application_name);
  assert.equal(session.statementTimeoutMs, config.statement_timeout);
  assert.equal(session.queryTimeoutMs, config.query_timeout);
  assert.equal(session.connectionTimeoutMs, config.connectionTimeoutMillis);
}

/** The old German warnings, worded as the port words them — same figures, same condition. */
const WORDING: readonly [RegExp, (m: RegExpExecArray) => string][] = [
  [
    /^Retention: (\d+) Zeilen aus Einzelstandorten \(3-Monats-Staffel\)$/,
    (m) => `Retention: ${m[1] ?? ""} rows of single sites removed (3-month tier)`,
  ],
  [
    /^Retention: (\d+) verwaiste OffStreetParking-Zeilen entfernt$/,
    (m) => `Retention: ${m[1] ?? ""} orphaned OffStreetParking rows removed`,
  ],
  [
    /^Retention: (\d+) Zeilen von (\d+)\/(\d+) Parkanlagen im Alt-ID-Schema entfernt( \(Deckel erreicht, Rest folgt morgen\))?$/,
    (m) =>
      `Retention: ${m[1] ?? ""} rows of ${m[2] ?? ""}/${m[3] ?? ""} parking sites in the old id scheme removed` +
      (m[4] === undefined ? "" : " (cap reached, the rest follows tomorrow)"),
  ],
];

/** The old warnings the port still gives: all but the dropped OffStreetParking step's. */
function portedWarnings(old: readonly string[]): string[] {
  return old.map(reworded).filter((line) => !line.includes("OffStreetParking"));
}

function reworded(old: string): string {
  for (const [pattern, word] of WORDING) {
    const match = pattern.exec(old);
    if (match !== null) return word(match);
  }
  throw new Error(`old warning without a counterpart: ${old}`);
}

async function assertParity(s: Scenario): Promise<{ legacy: Legacy; ported: Ported }> {
  const legacy = await runLegacy(s);
  const ported = await runPorted(s);
  assertSameConversation(legacy, ported);
  assertOwnershipQueries(ported, s.oldIds);
  assert.equal(
    ported.failure === null,
    legacy.failure === null,
    `${String(legacy.failure)} / ${String(ported.failure)}`,
  );
  // A node that threw hands no warnings out of the harness; that case is
  // checked against the same night without the failure instead.
  if (legacy.run !== null) {
    assert.deepEqual(ported.t.log.warnings(), portedWarnings(legacy.run.warnings), "the warnings differ");
  }
  assert.equal(ported.t.seen.length, 0, "the retention never writes to Orion");
  return { legacy, ported };
}

/**
 * `msg.payload` of the old node against `build()` and the summary line of
 * `run()`; `orphaned` rows are those only the old node deleted.
 */
function assertSameSummary(legacy: Legacy, ported: Ported, orphaned = 0): void {
  assert.ok(legacy.run !== null);
  const returned = normalize(legacy.run.returned);
  assert.ok(isRecord(returned) && isRecord(returned.payload));
  const { deletedAttributes, deletedSubattributes, at } = returned.payload;
  assert.equal(typeof deletedAttributes, "number");
  assert.equal(typeof deletedSubattributes, "number");
  assert.equal(typeof at, "string");
  const summary = build(
    parse({ attributes: deletedAttributes, subattributes: deletedSubattributes }),
    null,
    String(at),
  );
  assert.deepEqual(normalize(summary), returned.payload);
  const info = ported.t.log.lines.filter((line) => line.level === "info").map((line) => line.text);
  assert.deepEqual(info, [
    `deleted: ${String(Number(deletedAttributes) - orphaned)} attributes / ${String(deletedSubattributes)} subattributes`,
  ]);
}

/* ── tests ───────────────────────────────────────────────────────────────────*/

async function typicalNight(): Promise<void> {
  const { legacy, ported } = await assertParity(NIGHT);
  assertSameSummary(legacy, ported);
  // Not vacuous: 12 ids are three batches, both warnings fire, the totals commit.
  assert.equal(ported.db.calls.filter((call) => call.sql === SQL_DELETE_BY_IDS).length, 3);
  assert.equal(ported.t.log.warnings().length, 2);
  assert.deepEqual(
    ported.db.calls.slice(-4).map((call) => call.sql),
    ["BEGIN", SQL_CLEAR_TYPE_STATS, SQL_FILL_TYPE_STATS, "COMMIT"],
  );
  assert.equal(
    ported.t.log.lines.find((line) => line.level === "info")?.text,
    `deleted: ${String(1_250_000 + 380_000 + 818_000)} attributes / 0 subattributes`,
  );
}

async function capStopsTheOldSchemeLoop(): Promise<void> {
  // ~70,000 rows per site on the reference cluster, 1.2 M per batch here: the
  // cap of 5 M is reached after five batches; 60 ids would have been twelve.
  const s: Scenario = { ...NIGHT, oldIds: oldIds(60), perBatch: () => 1_200_000 };
  const { legacy, ported } = await assertParity(s);
  assertSameSummary(legacy, ported);
  assert.equal(ported.db.calls.filter((call) => call.sql === SQL_DELETE_BY_IDS).length, 5);
  assert.ok(
    ported.t.log.warnings().some((line) => line.endsWith("(cap reached, the rest follows tomorrow)")),
  );
  assert.ok(5 * 1_200_000 >= OLD_SCHEME_CAP);
}

async function idleNightAndOrphans(): Promise<void> {
  // Nothing to do: no warnings at all, the same statements.
  const idle: Scenario = {
    attributes12m: 0,
    subattributes12m: 0,
    shortTier: 0,
    orphaned: 0,
    oldIds: [],
    perBatch: () => 0,
  };
  const quiet = await assertParity(idle);
  assertSameSummary(quiet.legacy, quiet.ported);
  assert.deepEqual(quiet.ported.t.log.warnings(), []);

  // Orphans of the retired Reutlingen pipeline, subattributes, and old ids whose
  // rows are already gone (0 rows: no warning, the loop still walks all ids).
  // DELIBERATE: the port no longer deletes OffStreetParking rows at all — the
  // old node removed and reported 4200 of them, the port neither.
  const orphans: Scenario = { ...idle, orphaned: 4200, subattributes12m: 17, oldIds: oldIds(7) };
  const busy = await assertParity(orphans);
  assertSameSummary(busy.legacy, busy.ported, 4200);
  assert.deepEqual(busy.legacy.run?.warnings, ["Retention: 4200 verwaiste OffStreetParking-Zeilen entfernt"]);
  assert.deepEqual(busy.ported.t.log.warnings(), []);
  assert.equal(busy.ported.db.calls.filter((call) => call.sql === SQL_DELETE_BY_IDS).length, 2);
}

async function failedTotalsRollBack(): Promise<void> {
  const s: Scenario = { ...NIGHT, failOn: SQL_FILL_TYPE_STATS };
  const { legacy, ported } = await assertParity(s);
  assert.match(legacy.failure ?? "", /No space left on device/);
  assert.match(ported.failure ?? "", /No space left on device/);
  assert.deepEqual(
    ported.db.calls.slice(-4).map((call) => call.sql),
    ["BEGIN", SQL_CLEAR_TYPE_STATS, SQL_FILL_TYPE_STATS, "ROLLBACK"],
  );
  // The warnings of the steps done before the failure are not lost: the same
  // two the old node logged on this night without the failure.
  const clean = await runLegacy(NIGHT);
  assert.ok(clean.run !== null);
  assert.deepEqual(ported.t.log.warnings(), portedWarnings(clean.run.warnings));
}

async function batchIsBoundAsAnArray(): Promise<void> {
  const awkward = [
    "urn:ngsi-ld:ParkingSite:bw-plain",
    'urn:ngsi-ld:ParkingSite:bw-"quoted"',
    "urn:ngsi-ld:ParkingSite:bw-back\\slash",
    "urn:ngsi-ld:ParkingSite:bw-comma,brace{}",
    "urn:ngsi-ld:ParkingSite:bw-space and ümlaut",
    "urn:ngsi-ld:ParkingSite:bw-NULL",
  ];
  const scenario: Scenario = { ...NIGHT, oldIds: awkward };
  const ported = await runPorted(scenario);
  const legacy = await runLegacy(scenario);
  assert.equal(ported.failure, null);
  const portedBatches = ported.db.calls.filter((call) => call.sql === SQL_DELETE_BY_IDS);
  const legacyBatches = legacy.pg.calls.filter((call) => call.sql === SQL_DELETE_BY_IDS);
  // The port hands node-postgres the arrays themselves (SqlParam takes
  // string[]), as the old node did — no hand-built literal any more.
  assert.deepEqual(
    portedBatches.map((call) => call.params),
    [[awkward.slice(0, OLD_SCHEME_BATCH)], [awkward.slice(OLD_SCHEME_BATCH)]],
  );
  // And on the wire it is node-postgres' own array serialisation, byte for
  // byte what the old node sent.
  const expected =
    '{"urn:ngsi-ld:ParkingSite:bw-plain","urn:ngsi-ld:ParkingSite:bw-\\"quoted\\"",' +
    '"urn:ngsi-ld:ParkingSite:bw-back\\\\slash","urn:ngsi-ld:ParkingSite:bw-comma,brace{}",' +
    '"urn:ngsi-ld:ParkingSite:bw-space and ümlaut"}';
  assert.deepEqual(wire(portedBatches[0]?.params), [expected]);
  // normalize(): the old side's arrays come from the vm realm.
  assert.deepEqual(
    normalize(portedBatches.map((call) => wire(call.params))),
    normalize(legacyBatches.map((call) => wire(call.params))),
  );
}

async function municipalStationsKeepTheirHistory(): Promise<void> {
  // DELIBERATE DEVIATION (data review): the old node deleted the whole TRoE
  // history of every non-parkapi ParkingSite/BikeParking — the municipal B+R
  // stations included. The port deletes only candidates that carried
  // parken-bw's dataProvider before the id switch.
  const municipal = [
    "urn:ngsi-ld:BikeParking:stuttgart-br-hbf",
    "urn:ngsi-ld:ParkingSite:reutlingen-p-r-sued",
  ];
  const own = oldIds(4);
  const s: Scenario = {
    ...NIGHT,
    oldIds: [municipal[0] ?? "", ...own, municipal[1] ?? ""],
    foreign: municipal,
  };
  const legacy = await runLegacy(s);
  const ported = await runPorted(s);
  assert.equal(ported.failure, null);
  const deletedBy = (calls: readonly SqlCall[]): unknown =>
    normalize(calls.filter((call) => call.sql === SQL_DELETE_BY_IDS).map((call) => call.params));
  const oldDeleted = JSON.stringify(deletedBy(legacy.pg.calls));
  for (const id of municipal) assert.ok(oldDeleted.includes(id), `the old node deleted ${id}`);
  assert.deepEqual(deletedBy(ported.db.calls), [[own]], "only parken-bw's own legacy ids are deleted");
  assert.equal(
    ported.db.calls.some((call) => call.sql.includes("OffStreetParking")),
    false,
    "no OffStreetParking step any more",
  );
  // The ownership rule itself: provider, dataProvider row, written before the switch.
  assert.match(SQL_LEGACY_OWN_IDS, /entityid = ANY\(\$1::text\[\]\)/);
  assert.match(SQL_LEGACY_OWN_IDS, /ts < timestamp '2026-08-25 01:28:11'/);
  assert.match(SQL_LEGACY_OWN_IDS, /id LIKE '%dataProvider' AND text = \$2/);
  assert.equal(LEGACY_PROVIDER, "MobiData BW ParkAPI");
}

async function failedOwnershipCheckDeletesNothing(): Promise<void> {
  const s: Scenario = { ...NIGHT, ownershipFails: true };
  const ported = await runPorted(s);
  assert.equal(ported.failure, null, "the night goes on");
  assert.equal(ported.db.calls.filter((call) => call.sql === SQL_DELETE_BY_IDS).length, 0);
  assert.ok(
    ported.t.log
      .warnings()
      .some((line) => line.includes("ownership check of the old-scheme parking ids failed")),
  );
  assert.deepEqual(
    ported.db.calls.slice(-4).map((call) => call.sql),
    ["BEGIN", SQL_CLEAR_TYPE_STATS, SQL_FILL_TYPE_STATS, "COMMIT"],
    "the totals are refreshed anyway",
  );
}

async function ownershipIsCheckedInBatches(): Promise<void> {
  const s: Scenario = { ...NIGHT, oldIds: oldIds(LEGACY_CHECK_BATCH + 7), perBatch: () => 0 };
  const ported = await runPorted(s);
  assert.equal(ported.failure, null);
  assertOwnershipQueries(ported, s.oldIds);
  assert.equal(ported.db.calls.filter((call) => call.sql === SQL_LEGACY_OWN_IDS).length, 2);
}

export {
  typicalNight as "troe-retention: a typical night — same statements, batches, warnings and summary as the old node",
  capStopsTheOldSchemeLoop as "troe-retention: the old-scheme loop stops at the 5 M cap after the same batch on both sides",
  idleNightAndOrphans as "troe-retention: idle night and orphaned rows — identical conversation and warnings",
  failedTotalsRollBack as "troe-retention: a failing totals refill rolls back, fails the run and closes the connection",
  batchIsBoundAsAnArray as "troe-retention: the id batch is bound as an array and serialised byte-identically by node-postgres",
  municipalStationsKeepTheirHistory as "troe-retention: only parken-bw's own legacy ids lose their history, municipal B+R stations and OffStreetParking stay (deliberate)",
  failedOwnershipCheckDeletesNothing as "troe-retention: a failing ownership check skips the legacy cleanup with a warning, the night goes on",
  ownershipIsCheckedInBatches as "troe-retention: ownership is asked per batch of candidates, with parken-bw's provider",
};
