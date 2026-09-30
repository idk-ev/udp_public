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
 * The DELIBERATE deviations (see the module header) are mapped out of the
 * comparison rather than hidden: the port never sends the old OffStreetParking
 * DELETE, and it asks SQL_LEGACY_OWN_IDS which candidates are parken-bw's own
 * before deleting. It also asks which indexes exist and creates only the
 * missing ones instead of sending CREATE INDEX IF NOT EXISTS every night. With
 * every candidate owned, the retention session is otherwise the old
 * conversation. Around it the port opens two sessions the old node never had
 * — the overlap guard and the autovacuum thresholds before, the paced VACUUM
 * (ANALYZE) after — and the expected conversation pins those leading and
 * trailing statements explicitly. The tests at the end pin the new behaviour.
 *
 * Mapped the same way (module header, "attributes as a hypertable"): before
 * the 12-month cut the port asks whether `attributes` is a hypertable and then
 * sends drop_chunks instead of the DELETE; the old OR-ed 3-month DELETE is one
 * DELETE per prefix; the old nightly totals statement is the per-entity one.
 * The old statements are answered like the port's.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { ParseError } from "../../src/kernel/parse.js";
import type { Db, DbNotice } from "../../src/kernel/types.js";
import {
  autovacuumTuned,
  build,
  isLockTimeout,
  LOCK_TIMEOUT_MS,
  lockWarning,
  overlapReason,
  SQL_OVERLAP,
  SQL_PRESENT_INDEXES,
  SQL_VACUUM_PACING,
  TROE_INDEXES,
  VACUUM_LOCK_TIMEOUT_MS,
  vacuumNoticeWarning,
  OLD_SCHEME_BATCH,
  OLD_SCHEME_CAP,
  parse,
  parseReloptions,
  run,
  SESSION,
  SQL_RELOPTIONS,
  sqlAutovacuumTuning,
  sqlVacuum,
  TUNING_SESSION,
  tuningWarning,
  VACUUM_SESSION,
  VACUUMED_TABLES,
  vacuumWarning,
  SQL_CLEAR_TYPE_STATS,
  SQL_CREATE_TYPE_STATS,
  SQL_DELETE_ATTRIBUTES_12M,
  LEGACY_CHECK_BATCH,
  LEGACY_PROVIDER,
  SQL_DELETE_BY_IDS,
  SQL_DELETE_SHORT_TIER,
  SQL_DELETE_SUBATTRIBUTES_12M,
  SQL_DROP_CHUNKS_12M,
  SQL_FILL_TYPE_STATS,
  SQL_IS_HYPERTABLE,
  SHORT_TIER_PREFIXES,
  droppedChunksInfo,
  hypertableCheckWarning,
  shortTierWarning,
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

/** The old node's 3-month tier: one DELETE with OR-ed prefixes (the port sends one per prefix). */
const LEGACY_SQL_DELETE_SHORT_TIER =
  "DELETE FROM attributes WHERE ts < (now() AT TIME ZONE 'utc') - interval '3 months' " +
  "AND (entityid LIKE 'urn:ngsi-ld:EVChargingStation:%' " +
  "  OR entityid LIKE 'urn:ngsi-ld:CarSharingStation:%' " +
  "  OR entityid LIKE 'urn:ngsi-ld:AirQualityObserved:bw-sensor-%')";

/** The old node's nightly totals, with count(DISTINCT …) (the port counts per entity first). */
const LEGACY_SQL_FILL_TYPE_STATS =
  "INSERT INTO udp_troe_type_stats (typ, n, e, computed_at) " +
  "SELECT split_part(entityid, ':', 3), count(*), count(DISTINCT entityid), now() " +
  "FROM attributes GROUP BY 1";

/** The key a failure is scripted on: the port's statement for an old one. */
function portKey(sql: string): string {
  if (sql === LEGACY_SQL_FILL_TYPE_STATS) return SQL_FILL_TYPE_STATS;
  return sql;
}

/** The share of the scripted short-tier rows that the port's DELETE of prefix `index` reports. */
function shortTierShare(total: number, index: number): number {
  const third = Math.floor(total / 3);
  return index === 0 ? total - 2 * third : third;
}

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
  /** `pg_class.reloptions` per table; default `null` (nothing set, as after the TRoE setup). */
  reloptions?: Readonly<Record<string, readonly string[] | null>>;
  /** Indexes that exist; default all three (every night after the first). */
  presentIndexes?: readonly string[];
  /** Statements the server cancels with a lock timeout (SQLSTATE 55P03). */
  lockTimeoutOn?: readonly string[];
  /** What the overlap guard counts; default nothing. */
  overlap?: { readonly retention?: number; readonly vacuum?: number };
  /** Notices the server sends during a statement (the VACUUMs). */
  notices?: Readonly<Record<string, readonly DbNotice[]>>;
  /** `attributes` is a hypertable; default a plain table (the old node's world). */
  hypertable?: boolean;
  /** Makes the hypertable check fail. */
  hypertableCheckFails?: boolean;
  /** Chunks drop_chunks reports on a hypertable; default none. */
  droppedChunks?: number;
}

/** The thresholds as Postgres stores them after the port's ALTER TABLE. */
const TUNED = ["autovacuum_vacuum_insert_scale_factor=0.01", "autovacuum_analyze_scale_factor=0.01"];

/** The statements only the port sends besides SQL_RELOPTIONS: the ALTERs, the pacing and the VACUUMs. */
const PORT_ONLY = new Set([
  SQL_VACUUM_PACING,
  ...VACUUMED_TABLES.flatMap((table) => [sqlAutovacuumTuning(table), sqlVacuum(table)]),
]);

const INDEX_NAMES = TROE_INDEXES.map(([name]) => name);
const INDEX_STATEMENTS = new Set<string>(TROE_INDEXES.map(([, sql]) => sql));

/** What node-postgres rejects with when `lock_timeout` cancels a statement. */
function lockTimeout(): Error {
  return Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
}

/** Failures injected into the port-only statements: the old side never sees them. */
const PORT_ONLY_FAILURES = new Set([SQL_RELOPTIONS, ...PORT_ONLY]);

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
    if (portKey(sql) === s.failOn) return new Error("could not extend file: No space left on device");
    if (s.lockTimeoutOn?.includes(sql) === true) return lockTimeout();
    if (PORT_ONLY.has(sql)) return { rows: [], rowCount: null, notices: s.notices?.[sql] ?? [] };
    const prefix = SQL_DELETE_SHORT_TIER.indexOf(sql);
    if (prefix >= 0) return counted(shortTierShare(s.shortTier, prefix));
    switch (sql) {
      case SQL_IS_HYPERTABLE:
        if (s.hypertableCheckFails === true) {
          return new Error('relation "timescaledb_information.hypertables" does not exist');
        }
        return { rows: [{ n: s.hypertable === true ? 1 : 0 }], rowCount: 1 };
      case SQL_DROP_CHUNKS_12M:
        return { rows: [{ chunks: s.droppedChunks ?? 0 }], rowCount: 1 };
      case SQL_OVERLAP:
        return {
          rows: [{ retention: s.overlap?.retention ?? 0, vacuum: s.overlap?.vacuum ?? 0 }],
          rowCount: 1,
        };
      case SQL_PRESENT_INDEXES: {
        const present = s.presentIndexes ?? INDEX_NAMES;
        return { rows: present.map((name) => ({ name })), rowCount: present.length };
      }
      case SQL_RELOPTIONS: {
        const table: unknown = Array.isArray(params) ? params[0] : undefined;
        const reloptions = typeof table === "string" ? (s.reloptions?.[table] ?? null) : null;
        return { rows: [{ reloptions }], rowCount: 1 };
      }
      case SQL_INDEX_ATTRIBUTES_TS:
      case SQL_INDEX_SUBATTRIBUTES_TS:
      case SQL_INDEX_ATTRIBUTES_ENTITYID_TS:
      case SQL_CREATE_TYPE_STATS:
        return { rows: [], rowCount: null };
      case SQL_DELETE_ATTRIBUTES_12M:
        return counted(s.attributes12m);
      case SQL_DELETE_SUBATTRIBUTES_12M:
        return counted(s.subattributes12m);
      case LEGACY_SQL_DELETE_SHORT_TIER:
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
      case LEGACY_SQL_FILL_TYPE_STATS:
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

/** @param wrap Stands between the port and the scripted database (a session that cannot connect). */
async function runPorted(s: Scenario, wrap: (db: Db) => Db = (db) => db): Promise<Ported> {
  const db = scriptedDb(responder(s));
  const t = testCtx({ id: "troe-retention", db: wrap(db.db) });
  try {
    await run(t.ctx);
    return { db, t, failure: null };
  } catch (error) {
    return { db, t, failure: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The old conversation with the deliberate deviations applied: the three
 * CREATE INDEX become one look-up of the existing indexes and a CREATE only
 * for the missing ones (in the old order), no OffStreetParking DELETE, and the
 * port's ownership queries right after the candidate query (checked on their
 * own in {@link assertOwnershipQueries}). The 12-month cut of attributes is
 * preceded by the hypertable check and becomes drop_chunks on a hypertable;
 * the 3-month tier is one DELETE per prefix; the totals the per-entity count.
 */
function expectedCalls(legacy: Legacy, ported: Ported, s: Scenario): SqlCall[] {
  const ownership = ported.db.calls.filter((call) => call.sql === SQL_LEGACY_OWN_IDS);
  const present = s.presentIndexes ?? INDEX_NAMES;
  const out: SqlCall[] = [];
  for (const call of legacy.pg.calls) {
    if (call.sql === SQL_DELETE_ORPHANED) continue;
    if (INDEX_STATEMENTS.has(call.sql)) {
      if (call.sql !== SQL_INDEX_ATTRIBUTES_TS) continue;
      out.push({ sql: SQL_PRESENT_INDEXES, params: [INDEX_NAMES] });
      for (const [name, sql] of TROE_INDEXES) {
        if (!present.includes(name)) out.push({ sql, params: undefined });
      }
      continue;
    }
    if (call.sql === SQL_DELETE_ATTRIBUTES_12M) {
      out.push({ sql: SQL_IS_HYPERTABLE, params: undefined });
      const dropChunks = s.hypertable === true && s.hypertableCheckFails !== true;
      out.push(dropChunks ? { sql: SQL_DROP_CHUNKS_12M, params: undefined } : call);
      continue;
    }
    if (call.sql === LEGACY_SQL_DELETE_SHORT_TIER) {
      out.push(...SQL_DELETE_SHORT_TIER.map((sql) => ({ sql, params: undefined })));
      continue;
    }
    if (call.sql === LEGACY_SQL_FILL_TYPE_STATS) {
      out.push({ sql: SQL_FILL_TYPE_STATS, params: call.params });
      continue;
    }
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

/**
 * DELIBERATE (not in the old node): the leading statements — the overlap
 * guard, then per table the reloptions read and an ALTER TABLE only where the
 * thresholds are not in place; a failure ends the tuning session.
 */
function tuningCalls(s: Scenario): SqlCall[] {
  const out: SqlCall[] = [{ sql: SQL_OVERLAP, params: undefined }];
  for (const table of VACUUMED_TABLES) {
    out.push({ sql: SQL_RELOPTIONS, params: [table] });
    if (s.failOn === SQL_RELOPTIONS) return out;
    const options = s.reloptions?.[table] ?? null;
    if (options !== null && TUNED.every((entry) => options.includes(entry))) continue;
    const alter = sqlAutovacuumTuning(table);
    out.push({ sql: alter, params: undefined });
    if (s.failOn === alter) return out;
  }
  return out;
}

/** DELIBERATE (not in the old node): the paced trailing VACUUMs, both tables, after a successful night only. */
function vacuumCalls(): SqlCall[] {
  return [
    { sql: SQL_VACUUM_PACING, params: undefined },
    ...VACUUMED_TABLES.map((table) => ({ sql: sqlVacuum(table), params: undefined })),
  ];
}

/** The statements of the vacuum session. */
const VACUUM_TAIL = vacuumCalls().length;

function assertSameConversation(legacy: Legacy, ported: Ported, s: Scenario): void {
  const succeeded = legacy.failure === null;
  const expected = [
    ...tuningCalls(s),
    ...expectedCalls(legacy, ported, s),
    ...(succeeded ? vacuumCalls() : []),
  ];
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
  // Tuning, retention and — after a successful night — vacuum: one connection each, all closed.
  const sessions = succeeded ? [TUNING_SESSION, SESSION, VACUUM_SESSION] : [TUNING_SESSION, SESSION];
  assert.deepEqual(ported.db.sessions, sessions);
  assert.deepEqual(
    ported.db.events,
    sessions.flatMap(() => ["connect", "end"]),
    "the port left a connection open",
  );

  const config = normalize(legacy.pg.configs[0]);
  assert.ok(isRecord(config));
  const session = ported.db.sessions[1];
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

/** Warnings of the port-only steps (autovacuum thresholds, VACUUM, lock timeouts); pinned by their own tests. */
const PORT_ONLY_WARNING =
  /^Retention: (autovacuum thresholds|VACUUM \(ANALYZE\)|the server warned during VACUUM|.* skipped, lock not granted)/;

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
  assertSameConversation(legacy, ported, s);
  assertOwnershipQueries(ported, s.oldIds);
  assert.equal(
    ported.failure === null,
    legacy.failure === null,
    `${String(legacy.failure)} / ${String(ported.failure)}`,
  );
  const warnings = ported.t.log.warnings();
  // A node that threw hands no warnings out of the harness; that case is
  // checked against the same night without the failure instead.
  if (legacy.run !== null) {
    assert.deepEqual(
      warnings.filter((line) => !PORT_ONLY_WARNING.test(line)),
      portedWarnings(legacy.run.warnings),
      "the warnings differ",
    );
  }
  // The port-only steps are silent unless one of their statements fails.
  if (s.failOn === undefined || !PORT_ONLY_FAILURES.has(s.failOn)) {
    assert.deepEqual(
      warnings.filter((line) => PORT_ONLY_WARNING.test(line)),
      [],
    );
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
    ported.db.calls.slice(-(4 + VACUUM_TAIL)).map((call) => call.sql),
    ["BEGIN", SQL_CLEAR_TYPE_STATS, SQL_FILL_TYPE_STATS, "COMMIT", ...vacuumCalls().map((call) => call.sql)],
  );
  // Every index exists on a normal night: not a single CREATE INDEX.
  assert.equal(
    ported.db.calls.some((call) => INDEX_STATEMENTS.has(call.sql)),
    false,
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
  assert.equal(
    ported.db.calls.some((call) => call.sql.startsWith("VACUUM")),
    false,
    "a failed night is not vacuumed",
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
    ported.db.calls.slice(-(4 + VACUUM_TAIL), -VACUUM_TAIL).map((call) => call.sql),
    ["BEGIN", SQL_CLEAR_TYPE_STATS, SQL_FILL_TYPE_STATS, "COMMIT"],
    "the totals are refreshed anyway",
  );
}

async function autovacuumThresholdsOnlyWhereTheyDiffer(): Promise<void> {
  // DELIBERATE DEVIATION (finding in a production installation, module header): the old node
  // never touched the autovacuum settings.
  assert.equal(
    sqlAutovacuumTuning("attributes"),
    "ALTER TABLE attributes SET (autovacuum_vacuum_insert_scale_factor = 0.01, autovacuum_analyze_scale_factor = 0.01)",
  );
  assert.equal(SQL_RELOPTIONS, "SELECT reloptions FROM pg_class WHERE oid = $1::regclass");
  assert.ok(TUNING_SESSION.statementTimeoutMs < TUNING_SESSION.queryTimeoutMs);

  // Nothing set yet: after the overlap guard, read and ALTER both tables,
  // before the retention session.
  const fresh = await assertParity(NIGHT);
  assert.deepEqual(fresh.ported.db.calls.slice(0, 5), [
    { sql: SQL_OVERLAP, params: undefined },
    { sql: SQL_RELOPTIONS, params: ["attributes"] },
    { sql: sqlAutovacuumTuning("attributes"), params: undefined },
    { sql: SQL_RELOPTIONS, params: ["subattributes"] },
    { sql: sqlAutovacuumTuning("subattributes"), params: undefined },
  ]);
  assert.equal(fresh.ported.db.calls[5]?.sql, SQL_PRESENT_INDEXES);
  assert.deepEqual(fresh.ported.db.sessions[0], TUNING_SESSION);

  // attributes already tuned (among other options), subattributes half: one ALTER.
  const half: Scenario = {
    ...NIGHT,
    reloptions: {
      attributes: ["fillfactor=100", ...TUNED],
      subattributes: ["autovacuum_analyze_scale_factor=0.01"],
    },
  };
  const partly = await assertParity(half);
  assert.deepEqual(
    partly.ported.db.calls.filter((call) => call.sql.startsWith("ALTER TABLE")).map((call) => call.sql),
    [sqlAutovacuumTuning("subattributes")],
  );

  // Both in place: no ALTER TABLE at all, night after night.
  const done = await assertParity({ ...NIGHT, reloptions: { attributes: TUNED, subattributes: TUNED } });
  assert.equal(
    done.ported.db.calls.some((call) => call.sql.startsWith("ALTER TABLE")),
    false,
  );

  // The comparison is numeric, the parse strict.
  assert.equal(
    autovacuumTuned(
      parseReloptions(
        ["autovacuum_vacuum_insert_scale_factor=0.010", "autovacuum_analyze_scale_factor=1e-2"],
        "r",
      ),
    ),
    true,
  );
  assert.equal(
    autovacuumTuned(
      parseReloptions(
        ["autovacuum_vacuum_insert_scale_factor=0.2", "autovacuum_analyze_scale_factor=0.01"],
        "r",
      ),
    ),
    false,
  );
  assert.equal(autovacuumTuned(parseReloptions(null, "r")), false);
  assert.throws(() => parseReloptions("autovacuum_analyze_scale_factor=0.01", "r"), ParseError);
  assert.throws(() => parseReloptions(["=0.01"], "r"), ParseError);
}

async function failedTuningOnlyWarns(): Promise<void> {
  // The read fails: one warning first, no ALTER, the night is the old one.
  const readFails = await assertParity({ ...NIGHT, failOn: SQL_RELOPTIONS });
  assertSameSummary(readFails.legacy, readFails.ported);
  assert.equal(readFails.ported.failure, null);
  assert.equal(
    readFails.ported.t.log.warnings()[0],
    tuningWarning(new Error("could not extend file: No space left on device")),
  );
  assert.equal(readFails.ported.t.log.warnings().filter((line) => PORT_ONLY_WARNING.test(line)).length, 1);
  assert.equal(
    readFails.ported.db.calls.some((call) => call.sql.startsWith("ALTER TABLE")),
    false,
  );
  assert.deepEqual(readFails.ported.db.calls.slice(-VACUUM_TAIL), vacuumCalls(), "the vacuum still runs");

  // The ALTER fails (a lock wait cut short): one warning, the tuning session ends there.
  const alterFails = await assertParity({ ...NIGHT, failOn: sqlAutovacuumTuning("attributes") });
  assertSameSummary(alterFails.legacy, alterFails.ported);
  assert.equal(alterFails.ported.t.log.warnings().filter((line) => PORT_ONLY_WARNING.test(line)).length, 1);
}

async function vacuumRunsLastInItsOwnSession(): Promise<void> {
  // DELIBERATE DEVIATION (finding in a production installation, module header): the old node
  // never vacuumed. Both tables, after the committed totals, in a session of
  // their own — no BEGIN in it, 45 min on the server, the client longer.
  const { ported } = await assertParity(NIGHT);
  assert.deepEqual(
    vacuumCalls().map((call) => call.sql),
    ["SET vacuum_cost_delay = '2ms'", "VACUUM (ANALYZE) attributes", "VACUUM (ANALYZE) subattributes"],
  );
  const lastCommit = ported.db.calls.map((call) => call.sql).lastIndexOf("COMMIT");
  assert.deepEqual(ported.db.calls.slice(lastCommit + 1), vacuumCalls());
  assert.deepEqual(ported.db.sessions[2], VACUUM_SESSION);
  assert.equal(VACUUM_SESSION.statementTimeoutMs, 45 * 60_000);
  assert.ok(VACUUM_SESSION.statementTimeoutMs < VACUUM_SESSION.queryTimeoutMs);
  assert.ok(VACUUM_SESSION.statementTimeoutMs > SESSION.statementTimeoutMs);
  // Every session has a lock timeout; a waiting VACUUM blocks no insert, so its own is longer.
  assert.equal(SESSION.lockTimeoutMs, LOCK_TIMEOUT_MS);
  assert.equal(TUNING_SESSION.lockTimeoutMs, LOCK_TIMEOUT_MS);
  assert.equal(LOCK_TIMEOUT_MS, 5_000);
  assert.equal(VACUUM_SESSION.lockTimeoutMs, VACUUM_LOCK_TIMEOUT_MS);
  assert.equal(VACUUM_LOCK_TIMEOUT_MS, 60_000);
  assert.deepEqual(ported.db.events, ["connect", "end", "connect", "end", "connect", "end"]);
}

async function failedVacuumOnlyWarns(): Promise<void> {
  // attributes times out: one warning, subattributes is still vacuumed, the
  // run succeeds and everything before is the old night.
  const s: Scenario = { ...NIGHT, failOn: sqlVacuum("attributes") };
  const { legacy, ported } = await assertParity(s);
  assertSameSummary(legacy, ported);
  assert.equal(ported.failure, null);
  assert.deepEqual(ported.db.calls.slice(-VACUUM_TAIL), vacuumCalls());
  const warnings = ported.t.log.warnings();
  assert.deepEqual(
    warnings.filter((line) => PORT_ONLY_WARNING.test(line)),
    [vacuumWarning(["attributes: could not extend file: No space left on device"])],
  );
  assert.equal(
    warnings.at(-1),
    vacuumWarning(["attributes: could not extend file: No space left on device"]),
  );

  // The vacuum session cannot even connect: one warning, the run still succeeds.
  const refusing = (db: Db): Db => ({
    session: (options, work) =>
      options === VACUUM_SESSION
        ? Promise.reject(new Error("connect ECONNREFUSED"))
        : db.session(options, work),
  });
  const cut = await runPorted(NIGHT, refusing);
  assert.equal(cut.failure, null);
  assert.deepEqual(
    cut.t.log.warnings().filter((line) => PORT_ONLY_WARNING.test(line)),
    [vacuumWarning(["connect ECONNREFUSED"])],
  );
  assert.equal(
    cut.t.log.lines.filter((line) => line.level === "info").length,
    1,
    "the summary is logged regardless",
  );
}

async function ownershipIsCheckedInBatches(): Promise<void> {
  const s: Scenario = { ...NIGHT, oldIds: oldIds(LEGACY_CHECK_BATCH + 7), perBatch: () => 0 };
  const ported = await runPorted(s);
  assert.equal(ported.failure, null);
  assertOwnershipQueries(ported, s.oldIds);
  assert.equal(ported.db.calls.filter((call) => call.sql === SQL_LEGACY_OWN_IDS).length, 2);
}

async function indexesAreCreatedOnlyWhenMissing(): Promise<void> {
  // DELIBERATE (module header): CREATE INDEX IF NOT EXISTS takes its ShareLock
  // before it notices the index exists and would queue every Orion-LD insert
  // behind a running VACUUM. The port looks first and creates only what is
  // missing — in the old order.
  assert.equal(
    SQL_PRESENT_INDEXES,
    "SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(name) IS NOT NULL",
  );
  assert.deepEqual(INDEX_NAMES, ["attributes_ts_idx", "subattributes_ts_idx", "attributes_entityid_ts_idx"]);

  const all = await assertParity(NIGHT);
  const created = (ported: Ported): string[] =>
    ported.db.calls.filter((call) => INDEX_STATEMENTS.has(call.sql)).map((call) => call.sql);
  assert.deepEqual(created(all.ported), [], "every index present: no CREATE INDEX");
  assert.deepEqual(all.ported.db.calls.find((call) => call.sql === SQL_PRESENT_INDEXES)?.params, [
    INDEX_NAMES,
  ]);

  const one = await assertParity({ ...NIGHT, presentIndexes: ["subattributes_ts_idx"] });
  assert.deepEqual(created(one.ported), [SQL_INDEX_ATTRIBUTES_TS, SQL_INDEX_ATTRIBUTES_ENTITYID_TS]);

  const none = await assertParity({ ...NIGHT, presentIndexes: [] });
  assert.deepEqual(created(none.ported), [
    SQL_INDEX_ATTRIBUTES_TS,
    SQL_INDEX_SUBATTRIBUTES_TS,
    SQL_INDEX_ATTRIBUTES_ENTITYID_TS,
  ]);
}

async function lockTimeoutSkipsTheStepAndTheNightGoesOn(): Promise<void> {
  assert.equal(isLockTimeout(lockTimeout()), true);
  assert.equal(isLockTimeout(new Error("canceling statement due to statement timeout")), false);

  // The 12-month cut waits behind a lock: one [warn], nothing counted for it,
  // every later step runs, the night succeeds and is vacuumed.
  const cut = await runPorted({ ...NIGHT, lockTimeoutOn: [SQL_DELETE_ATTRIBUTES_12M] });
  assert.equal(cut.failure, null);
  const warned = cut.t.log.warnings().filter((line) => line.includes("lock not granted"));
  assert.deepEqual(warned, [lockWarning("12-month cut of attributes", lockTimeout())]);
  assert.match(warned[0] ?? "", /within 5 s .* the night goes on$/);
  const sent = cut.db.calls.map((call) => call.sql);
  for (const later of [SQL_DELETE_SUBATTRIBUTES_12M, ...SQL_DELETE_SHORT_TIER, SQL_DELETE_BY_IDS, "COMMIT"]) {
    assert.ok(sent.includes(later), `${later} was not sent after the lock timeout`);
  }
  assert.deepEqual(cut.db.calls.slice(-VACUUM_TAIL), vacuumCalls(), "the night is still vacuumed");
  assert.equal(
    cut.t.log.lines.find((line) => line.level === "info")?.text,
    `deleted: ${String(380_000 + 818_000)} attributes / 0 subattributes`,
  );

  // A missing index whose CREATE cannot get its lock: skipped, the next one is still created.
  const index = await runPorted({ ...NIGHT, presentIndexes: [], lockTimeoutOn: [SQL_INDEX_ATTRIBUTES_TS] });
  assert.equal(index.failure, null);
  assert.deepEqual(
    index.t.log.warnings().filter((line) => line.includes("lock not granted")),
    [lockWarning("CREATE INDEX attributes_ts_idx", lockTimeout())],
  );
  assert.ok(index.db.calls.some((call) => call.sql === SQL_INDEX_ATTRIBUTES_ENTITYID_TS));

  // The totals: rolled back (yesterday's figures stay), one [warn], the run succeeds.
  const totals = await runPorted({ ...NIGHT, lockTimeoutOn: [SQL_FILL_TYPE_STATS] });
  assert.equal(totals.failure, null);
  assert.deepEqual(
    totals.db.calls.slice(-(4 + VACUUM_TAIL), -VACUUM_TAIL).map((call) => call.sql),
    ["BEGIN", SQL_CLEAR_TYPE_STATS, SQL_FILL_TYPE_STATS, "ROLLBACK"],
  );
  assert.deepEqual(
    totals.t.log.warnings().filter((line) => line.includes("lock not granted")),
    [lockWarning("nightly totals", lockTimeout())],
  );

  // A batch of the old-scheme cleanup: the loop stops there, the night goes on.
  const batches = await runPorted({ ...NIGHT, lockTimeoutOn: [SQL_DELETE_BY_IDS] });
  assert.equal(batches.failure, null);
  assert.equal(batches.db.calls.filter((call) => call.sql === SQL_DELETE_BY_IDS).length, 1);
  assert.ok(batches.db.calls.some((call) => call.sql === "COMMIT"));

  // Any other error still ends the night, as the old node's did.
  const other = await runPorted({ ...NIGHT, failOn: SQL_DELETE_ATTRIBUTES_12M });
  assert.match(other.failure ?? "", /No space left on device/);
}

async function overlappingWorkSkipsTheNight(): Promise<void> {
  assert.match(
    SQL_OVERLAP,
    /application_name LIKE 'udp-troe-retention%' AND state <> 'idle' AND pid <> pg_backend_pid\(\)/,
  );
  assert.match(SQL_OVERLAP, /FROM pg_stat_progress_vacuum p/);
  assert.match(SQL_OVERLAP, /to_regclass\('attributes'\), to_regclass\('subattributes'\)/);
  assert.match(
    SQL_OVERLAP,
    /backend_type IS DISTINCT FROM 'autovacuum worker' OR a\.query LIKE '%to prevent wraparound%'/,
  );
  assert.equal(overlapReason(0, 0), null);

  for (const overlap of [{ retention: 1 }, { vacuum: 1 }, { retention: 2, vacuum: 1 }]) {
    const busy = await runPorted({ ...NIGHT, overlap });
    assert.equal(busy.failure, null);
    assert.deepEqual(
      busy.db.calls.map((call) => call.sql),
      [SQL_OVERLAP],
      "nothing but the guard is sent",
    );
    assert.deepEqual(busy.db.sessions, [TUNING_SESSION]);
    assert.deepEqual(busy.db.events, ["connect", "end"]);
    assert.deepEqual(busy.t.log.warnings(), []);
    const info = busy.t.log.lines.filter((line) => line.level === "info").map((line) => line.text);
    const retention = "retention" in overlap ? overlap.retention : 0;
    const vacuum = "vacuum" in overlap ? overlap.vacuum : 0;
    assert.deepEqual(info, [overlapReason(retention, vacuum)]);
  }

  // A guard that cannot be asked fails the run rather than risking the night.
  const broken = await runPorted({ ...NIGHT, failOn: SQL_OVERLAP });
  assert.match(broken.failure ?? "", /No space left on device/);
  assert.deepEqual(
    broken.db.calls.map((call) => call.sql),
    [SQL_OVERLAP],
  );
}

async function vacuumWarningsOfTheServerAreReported(): Promise<void> {
  // PostgreSQL 16 skips a table the user does not own with a WARNING and
  // reports success: one [warn] naming the owner requirement, the run succeeds.
  const denied = (table: string): DbNotice => ({
    severity: "WARNING",
    message: `permission denied to vacuum "${table}", skipping it`,
  });
  const s: Scenario = {
    ...NIGHT,
    notices: {
      [sqlVacuum("attributes")]: [denied("attributes"), { severity: "NOTICE", message: "ignored" }],
      [sqlVacuum("subattributes")]: [denied("subattributes")],
    },
  };
  const ported = await runPorted(s);
  assert.equal(ported.failure, null);
  const expected = vacuumNoticeWarning([
    'permission denied to vacuum "attributes", skipping it',
    'permission denied to vacuum "subattributes", skipping it',
  ]);
  assert.deepEqual(
    ported.t.log.warnings().filter((line) => line.includes("VACUUM")),
    [expected],
  );
  assert.match(expected, /TROE_DB_USER must own attributes\/subattributes$/);
  assert.equal(vacuumNoticeWarning(["oldest xmin is far in the past"]).includes("TROE_DB_USER"), false);

  // Pacing first, in the vacuum session.
  assert.equal(ported.db.calls.slice(-VACUUM_TAIL)[0]?.sql, "SET vacuum_cost_delay = '2ms'");
}

async function hypertableDropsChunksInsteadOfDeleting(): Promise<void> {
  // DELIBERATE DEVIATION (module header): on a hypertable the 12-month tier
  // drops whole chunks; subattributes (a plain table) keeps its DELETE.
  assert.equal(
    SQL_IS_HYPERTABLE,
    "SELECT count(*)::int AS n FROM timescaledb_information.hypertables" +
      " WHERE hypertable_schema = current_schema() AND hypertable_name = 'attributes'",
  );
  assert.equal(
    SQL_DROP_CHUNKS_12M,
    "SELECT count(*)::int AS chunks FROM drop_chunks('attributes', " +
      "older_than => (now() AT TIME ZONE 'utc') - interval '12 months')",
  );
  const s: Scenario = { ...NIGHT, hypertable: true, droppedChunks: 2 };
  const { ported } = await assertParity(s);
  const sent = ported.db.calls.map((call) => call.sql);
  assert.equal(sent.includes(SQL_DELETE_ATTRIBUTES_12M), false, "no row DELETE on a hypertable");
  assert.deepEqual(sent.slice(sent.indexOf(SQL_IS_HYPERTABLE), sent.indexOf(SQL_IS_HYPERTABLE) + 3), [
    SQL_IS_HYPERTABLE,
    SQL_DROP_CHUNKS_12M,
    SQL_DELETE_SUBATTRIBUTES_12M,
  ]);
  // Dropped chunks are not counted as rows; their count is an info line.
  assert.deepEqual(
    ported.t.log.lines.filter((line) => line.level === "info").map((line) => line.text),
    [droppedChunksInfo(2), `deleted: ${String(380_000 + 818_000)} attributes / 0 subattributes`],
  );
  assert.equal(droppedChunksInfo(0), null);

  // Nothing old enough: no info line about chunks.
  const idle = await runPorted({ ...NIGHT, hypertable: true });
  assert.equal(idle.failure, null);
  assert.equal(
    idle.t.log.lines.some((line) => line.text.includes("chunks")),
    false,
  );

  // drop_chunks waits for a lock (a Mintaka query on an old chunk): one
  // [warn], the night goes on.
  const locked = await runPorted({ ...s, lockTimeoutOn: [SQL_DROP_CHUNKS_12M] });
  assert.equal(locked.failure, null);
  assert.deepEqual(
    locked.t.log.warnings().filter((line) => line.includes("lock not granted")),
    [lockWarning("12-month drop_chunks of attributes", lockTimeout())],
  );
  assert.ok(locked.db.calls.some((call) => call.sql === SQL_DELETE_SUBATTRIBUTES_12M));
}

async function failedHypertableCheckFallsBackToDelete(): Promise<void> {
  // The DELETE is correct on both kinds of table: a check that cannot be made
  // is one [warn] and the old statement.
  const ported = await runPorted({ ...NIGHT, hypertable: true, hypertableCheckFails: true });
  assert.equal(ported.failure, null);
  const sent = ported.db.calls.map((call) => call.sql);
  assert.equal(sent[sent.indexOf(SQL_IS_HYPERTABLE) + 1], SQL_DELETE_ATTRIBUTES_12M);
  assert.equal(sent.includes(SQL_DROP_CHUNKS_12M), false);
  assert.deepEqual(
    ported.t.log.warnings().filter((line) => line.includes("hypertable")),
    [hypertableCheckWarning(new Error('relation "timescaledb_information.hypertables" does not exist'))],
  );
}

async function shortTierIsOneDeletePerPrefix(): Promise<void> {
  // DELIBERATE DEVIATION (module header): the old OR-ed LIKEs, one statement
  // per prefix — same prefixes, same order, same cut-off.
  const oldPrefixes = [...LEGACY_SQL_DELETE_SHORT_TIER.matchAll(/entityid LIKE '([^%']*)%'/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(oldPrefixes, [...SHORT_TIER_PREFIXES]);
  assert.deepEqual(
    [...SQL_DELETE_SHORT_TIER],
    SHORT_TIER_PREFIXES.map(
      (prefix) =>
        `DELETE FROM attributes WHERE ts < (now() AT TIME ZONE 'utc') - interval '3 months' AND entityid LIKE '${prefix}%'`,
    ),
  );
  // One statement's lock wait skips only that prefix; the warning carries the rest.
  const middle = SQL_DELETE_SHORT_TIER[1] ?? "";
  const ported = await runPorted({ ...NIGHT, lockTimeoutOn: [middle] });
  assert.equal(ported.failure, null);
  const sent = ported.db.calls.map((call) => call.sql);
  for (const sql of SQL_DELETE_SHORT_TIER) assert.ok(sent.includes(sql), `${sql} was not sent`);
  const kept = shortTierShare(NIGHT.shortTier, 0) + shortTierShare(NIGHT.shortTier, 2);
  assert.ok(ported.t.log.warnings().includes(shortTierWarning(kept) ?? ""));
  assert.ok(
    ported.t.log.warnings().includes(lockWarning(`3-month tier (${SHORT_TIER_PREFIXES[1]})`, lockTimeout())),
  );
}

function totalsCountPerEntityFirst(): void {
  // DELIBERATE DEVIATION (module header): same columns and figures, without
  // count(DISTINCT …) over the whole table.
  assert.equal(
    SQL_FILL_TYPE_STATS,
    "INSERT INTO udp_troe_type_stats (typ, n, e, computed_at) " +
      "SELECT split_part(entityid, ':', 3), sum(n), count(*), now() " +
      "FROM (SELECT entityid, count(*) AS n FROM attributes GROUP BY entityid) s GROUP BY 1",
  );
  assert.equal(/count\(DISTINCT/i.test(SQL_FILL_TYPE_STATS), false);
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
  autovacuumThresholdsOnlyWhereTheyDiffer as "troe-retention: autovacuum thresholds are set first, only on tables whose reloptions differ (deliberate)",
  failedTuningOnlyWarns as "troe-retention: a failing autovacuum check or ALTER only warns, the night runs as the old node's",
  vacuumRunsLastInItsOwnSession as "troe-retention: VACUUM (ANALYZE) of attributes and subattributes runs last, in its own 45-min session (deliberate)",
  failedVacuumOnlyWarns as "troe-retention: a failing or unreachable VACUUM is one warning, the night's deletes, totals and summary stand",
  indexesAreCreatedOnlyWhenMissing as "troe-retention: an existing index gets no CREATE INDEX, a missing one is created (deliberate)",
  lockTimeoutSkipsTheStepAndTheNightGoesOn as "troe-retention: a lock timeout is one warning and skips only that step, the night goes on (deliberate)",
  overlappingWorkSkipsTheNight as "troe-retention: another retention session or a non-yielding VACUUM skips the night with one info line (deliberate)",
  vacuumWarningsOfTheServerAreReported as "troe-retention: VACUUM runs paced, and the server's WARNINGs (table not owned) become one warning",
  hypertableDropsChunksInsteadOfDeleting as "troe-retention: on a hypertable the 12-month tier is drop_chunks, subattributes keeps its DELETE (deliberate)",
  failedHypertableCheckFallsBackToDelete as "troe-retention: a failing hypertable check is one warning and the old DELETE (deliberate)",
  shortTierIsOneDeletePerPrefix as "troe-retention: the 3-month tier is one DELETE per prefix, a lock wait skips only its prefix (deliberate)",
  totalsCountPerEntityFirst as "troe-retention: the nightly totals count per entity first, without count(DISTINCT) (deliberate)",
};
