/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: troe-stats — FN_TROE (`udp-rt-db-fn`) against the ported module,
 * with the row budget check as the part that must not be lost.
 *
 * Both sides talk to the same scripted database (test/harness/operations-pg.ts):
 * the old node through a fake `pg` module in its sandbox, the port through a
 * scripted `Db`. The responder is keyed on the PORT's SQL constants, so an old
 * statement that differs by a single byte gets no answer and fails the run;
 * the full statement sequence is compared as well. What is compared then:
 * statements and order, the client settings (application name and both
 * timeouts), that the connection is closed on every path, the entity that goes
 * to Orion, and the `[warn]` lines — the budget warning verbatim.
 *
 * The budget itself is pinned twice: the object the generator baked into the
 * old node must equal the kernel's `sumRowBudgets()` over the registry, and
 * the old warning expression is evaluated on budgets no registry has (0, a
 * type named `constructor`) against the port's `budgetWarning()`.
 *
 * Fixture: test/fixtures/troe-stats.json — SYNTHETIC query rows (no database
 * offline), shaped as node-postgres delivers them; see its `note`.
 *
 * The DELIBERATE deviation (module header): the row estimate comes from
 * `approximate_row_count('attributes')` instead of `pg_class.reltuples`, so the
 * port's SQL_BASE differs from the old node's. The old statement is answered
 * like the port's and mapped onto it in the comparison; the last test pins it.
 */

import assert from "node:assert/strict";
import {
  budgetWarning,
  build,
  parse,
  run,
  SESSION,
  SQL_BASE,
  SQL_BUSY,
  SQL_HAS_TOTALS,
  SQL_TOTALS,
  SQL_WINDOW,
} from "../../src/connectors/troe-stats.js";
import { createCtx, createKernel } from "../../src/kernel/context.js";
import { isArray } from "../../src/kernel/parse.js";
import { loadRegistry, resolveRegistryPath, sumRowBudgets } from "../../src/kernel/registry.js";
import type { RowBudget } from "../../src/kernel/types.js";
import { readFixture } from "../harness/fixtures.js";
import {
  assertClockStamps,
  assertEntitiesEqual,
  isRecord,
  normalize,
  openClock,
} from "../harness/normalize.js";
import { testCtx, upsertedEntities } from "../harness/operations-ctx.js";
import type { TestCtx } from "../harness/operations-ctx.js";
import { fakePgModule, scriptedDb } from "../harness/operations-pg.js";
import type { FakePg, ScriptedDb, SqlResponder } from "../harness/operations-pg.js";
import {
  evaluateSnippet,
  extractSnippet,
  loadFunctionNode,
  messagesOf,
  runFunctionNode,
} from "../harness/vm-runner.js";
import type { FunctionNodeRun } from "../harness/vm-runner.js";

const NODE_ID = "udp-rt-db-fn";
const FIXTURE = "troe-stats";

/** The old node's SQL_BASE, byte for byte: `reltuples` of the (plain) table. */
const LEGACY_SQL_BASE =
  "SELECT pg_database_size('orion') AS db, " +
  "(SELECT reltuples::bigint FROM pg_class WHERE oid = 'attributes'::regclass) AS rows, " +
  "(SELECT count(*) FROM attributes WHERE ts > (now() AT TIME ZONE 'utc') - interval '1 hour') AS r1";

/** The old statement as the port sends it (the one deliberate deviation). */
function asPorted(sql: string): string {
  return sql === LEGACY_SQL_BASE ? SQL_BASE : sql;
}

/* ── the scripted database ───────────────────────────────────────────────────*/

type Row = Record<string, unknown>;

interface Scenario {
  busy: number;
  base: Row;
  /** `udp_troe_type_stats` or null when the table does not exist yet. */
  hasTotals: string | null;
  window: Row[];
  totals: Row[];
  /** A statement whose query rejects. */
  failOn?: string;
}

function rows(value: unknown): Row[] {
  assert.ok(Array.isArray(value));
  return value.map((row: unknown) => {
    assert.ok(isRecord(row));
    return { ...row };
  });
}

/** The fixture as node-postgres would deliver it: timestamps as `Date`. */
function scenario(): Scenario {
  const payload = readFixture(FIXTURE).payload;
  assert.ok(isRecord(payload));
  assert.ok(isRecord(payload.base));
  assert.equal(typeof payload.busy, "number");
  assert.equal(typeof payload.hasTotals, "string");
  return {
    busy: Number(payload.busy),
    base: { ...payload.base },
    hasTotals: String(payload.hasTotals),
    window: rows(payload.window).map((row) => ({ ...row, hs: new Date(String(row.hs)) })),
    totals: rows(payload.totals).map((row) => ({ ...row, computed_at: new Date(String(row.computed_at)) })),
  };
}

function responder(s: Scenario): SqlResponder {
  return (sql) => {
    if (sql === s.failOn) return new Error("canceling statement due to statement timeout");
    if (sql === SQL_BUSY) return { rows: [{ n: s.busy }], rowCount: 1 };
    if (sql === SQL_BASE || sql === LEGACY_SQL_BASE) return { rows: [s.base], rowCount: 1 };
    if (sql === SQL_WINDOW) return { rows: s.window, rowCount: s.window.length };
    if (sql === SQL_HAS_TOTALS) return { rows: [{ t: s.hasTotals }], rowCount: 1 };
    if (sql === SQL_TOTALS) return { rows: s.totals, rowCount: s.totals.length };
    return new Error(`the scripted database does not know this statement: ${sql}`);
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

/** The budget object the generator baked into the old node. */
function bakedBudget(): RowBudget {
  const baked = /const BUDGET = (\{[^\n]*\});/.exec(loadFunctionNode(NODE_ID).func);
  assert.ok(baked?.[1] !== undefined, "no BUDGET object in the old node");
  const parsed: unknown = JSON.parse(baked[1]);
  assert.ok(isRecord(parsed));
  const budget: Record<string, number> = {};
  for (const [type, rows] of Object.entries(parsed)) if (typeof rows === "number") budget[type] = rows;
  return budget;
}

/**
 * Budgets deliberately changed since the generator baked its object: the
 * charging and car sharing stations write partial updates now, and the
 * budgets follow the new estimate (docs/betrieb.md, "Zeilenbudget").
 */
const CHANGED_BUDGETS: RowBudget = {
  EVChargingStation: 460_000,
  ChargingSummary: 95_000,
  CarSharingStation: 180_000,
};

async function runPorted(s: Scenario): Promise<Ported> {
  const db = scriptedDb(responder(s));
  const created = testCtx({ id: "troe-stats", db: db.db });
  // Same budget on both sides: the check is compared, not the registry's numbers.
  const t = { ...created, ctx: { ...created.ctx, rowBudget: bakedBudget() } };
  try {
    await run(t.ctx);
    return { db, t, failure: null };
  } catch (error) {
    return { db, t, failure: error instanceof Error ? error.message : String(error) };
  }
}

/** Statements, their order and the connection lifecycle must be the same on both sides. */
function assertSameConversation(legacy: Legacy, ported: Ported): void {
  assert.deepEqual(
    ported.db.calls.map((call) => call.sql),
    legacy.pg.calls.map((call) => asPorted(call.sql)),
    "the statement sequence differs",
  );
  assert.deepEqual(
    normalize(ported.db.calls.map((call) => call.params)),
    normalize(legacy.pg.calls.map((call) => call.params)),
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

function legacyEntities(legacy: Legacy): unknown[] {
  assert.ok(legacy.run !== null, legacy.failure ?? "");
  return messagesOf(legacy.run).flatMap((message) =>
    isRecord(message) && isArray(message.payload) ? message.payload : [],
  );
}

/* ── tests ───────────────────────────────────────────────────────────────────*/

async function fixtureRunIsIdentical(): Promise<void> {
  const s = scenario();
  const legacyClock = openClock();
  const legacy = await runLegacy(s);
  const legacyWindow = legacyClock.close();
  const portClock = openClock();
  const ported = await runPorted(s);
  const portWindow = portClock.close();
  assert.equal(ported.failure, null);
  assertSameConversation(legacy, ported);
  assert.equal(ported.db.calls.length, 5, "busy, base, window, to_regclass, totals");

  const old = legacyEntities(legacy);
  assert.equal(old.length, 1);
  // What reached Orion (after JSON) against what the old node handed its upsert node.
  assertEntitiesEqual(JSON.parse(JSON.stringify(old)), upsertedEntities(ported.t.seen));
  assertClockStamps(old, upsertedEntities(ported.t.seen), { legacy: legacyWindow, ported: portWindow });
  // And the pure build() before serialisation.
  const input = parse({
    base: s.base,
    window: s.window,
    totals: s.totals,
    budget: ported.t.ctx.rowBudget,
  });
  assertEntitiesEqual(old, [build(input, null, new Date().toISOString()).entity]);

  // THE row budget: the fixture's full write of charging points is over budget.
  assert.ok(legacy.run !== null);
  assert.equal(legacy.run.warnings.length, 1);
  assert.match(
    legacy.run.warnings[0] ?? "",
    /^TRoE-Zeilenbudget \(24 h\) überschritten — EVChargingStation: \d+ statt max\. 170000$/,
  );
  assert.deepEqual(ported.t.log.warnings(), legacy.run.warnings, "the budget warning differs");
}

function budgetIsTheRegistrySum(): void {
  const old = { ...bakedBudget(), ...CHANGED_BUDGETS };
  const registry = loadRegistry(resolveRegistryPath());
  assert.deepEqual(
    normalize(sumRowBudgets(registry.entries)),
    normalize(old),
    "kernel sum differs from the generator's",
  );
  // What the kernel hands the connector: ctx.rowBudget of a real ctx.
  const entry = registry.byId("troe-stats");
  assert.ok(entry !== undefined);
  assert.deepEqual(normalize(createCtx(createKernel(registry), entry).rowBudget), normalize(old));
  // Not vacuous: the registry does carry budgets, and not on every connector.
  assert.ok(Object.keys(sumRowBudgets(registry.entries)).length >= 5);
  assert.ok(registry.entries.some((entry) => entry.rowBudget24h === null));
}

/** Rows of one hour for a scripted window. */
function hourRows(counts: Readonly<Record<string, number>>): Row[] {
  const hs = new Date("2026-09-28T08:00:00.000Z");
  return Object.entries(counts).map(([typ, n]) => ({ h: "08", hs, typ, n: String(n) }));
}

async function budgetBranchesMatch(): Promise<void> {
  const cases: Readonly<Record<string, number>>[] = [
    // Under every budget: silent.
    { ParkingSite: 6000, EVChargingStation: 80000, WeatherObserved: 900000 },
    // Exactly at the budget is not over it; a type without budget is never flagged,
    // however large; several over budget are listed in order of first appearance.
    {
      ParkingSummary: 25000,
      WeatherObserved: 5_000_000,
      ParkingSite: 1_040_000,
      BikeParking: 8001,
      CityPulse: 100001,
    },
  ];
  for (const counts of cases) {
    const s = { ...scenario(), window: hourRows(counts) };
    const legacy = await runLegacy(s);
    const ported = await runPorted(s);
    assertSameConversation(legacy, ported);
    assertEntitiesEqual(JSON.parse(JSON.stringify(legacyEntities(legacy))), upsertedEntities(ported.t.seen));
    assert.ok(legacy.run !== null);
    assert.deepEqual(ported.t.log.warnings(), legacy.run.warnings);
  }
  const s = { ...scenario(), window: hourRows(cases[1] ?? {}) };
  const ported = await runPorted(s);
  assert.deepEqual(ported.t.log.warnings(), [
    "TRoE-Zeilenbudget (24 h) überschritten — ParkingSite: 1040000 statt max. 25000 · " +
      "BikeParking: 8001 statt max. 8000 · CityPulse: 100001 statt max. 100000",
  ]);
}

/**
 * The old check, cut out of the node, on budgets no registry carries: a budget
 * of 0 (falsy — no check), a type named like an Object.prototype member.
 */
function budgetExpressionMatches(): void {
  const snippet = extractSnippet(
    NODE_ID,
    "const ueberzogen = ",
    ".map(([t, n]) => t + ': ' + n + ' statt max. ' + BUDGET[t]);",
  );
  const budgets: RowBudget[] = [{ ParkingSite: 0, CityPulse: 10 }, { constructor: 5, toString: 1 }, {}];
  const windows: ReadonlyMap<string, number>[] = [
    new Map([
      ["ParkingSite", 99],
      ["CityPulse", 11],
      ["constructor", 7],
      ["toString", 1],
      ["hasOwnProperty", 3],
    ]),
    new Map([["CityPulse", 10]]),
  ];
  for (const budget of budgets) {
    for (const n24 of windows) {
      const old = normalize(evaluateSnippet(snippet, { n24, BUDGET: { ...budget } }, "ueberzogen"));
      assert.ok(Array.isArray(old));
      const expected =
        old.length === 0 ? null : `TRoE-Zeilenbudget (24 h) überschritten — ${old.join(" · ")}`;
      assert.equal(budgetWarning(n24, budget), expected, JSON.stringify(budget));
    }
  }
}

async function busyRunIsSkipped(): Promise<void> {
  const s = { ...scenario(), busy: 1 };
  const legacy = await runLegacy(s);
  const ported = await runPorted(s);
  assertSameConversation(legacy, ported);
  assert.equal(ported.db.calls.length, 1, "only the busy check");
  assert.deepEqual(legacyEntities(legacy), []);
  assert.equal(ported.t.seen.length, 0, "nothing may be written");
  assert.deepEqual(ported.t.log.warnings(), []);
}

async function withoutNightlyTableAndOnEmptyWindow(): Promise<void> {
  const variants: Scenario[] = [
    // Before the first retention night: no totals table — -1 markers, no troeEntities/asOf.
    { ...scenario(), hasTotals: null },
    // A fresh database: nothing written in 24 h.
    { ...scenario(), window: [] },
    // Both, and the planner estimate still -1 (never analysed).
    { ...scenario(), hasTotals: null, window: [], base: { db: "8126464", rows: "-1", r1: "0" } },
  ];
  for (const s of variants) {
    const legacy = await runLegacy(s);
    const ported = await runPorted(s);
    assertSameConversation(legacy, ported);
    assertEntitiesEqual(JSON.parse(JSON.stringify(legacyEntities(legacy))), upsertedEntities(ported.t.seen));
    assert.ok(legacy.run !== null);
    assert.deepEqual(ported.t.log.warnings(), legacy.run.warnings);
  }
  const bare = await runPorted(variants[2] ?? scenario());
  const entity = upsertedEntities(bare.t.seen)[0];
  assert.ok(isRecord(entity));
  assert.equal("troeEntities" in entity, false);
  assert.equal("rowsByTypeAsOf" in entity, false);
}

async function failingQueryClosesAndWritesNothing(): Promise<void> {
  const s = { ...scenario(), failOn: SQL_WINDOW };
  const legacy = await runLegacy(s);
  const ported = await runPorted(s);
  assert.match(legacy.failure ?? "", /statement timeout/);
  assert.match(ported.failure ?? "", /statement timeout/);
  assertSameConversation(legacy, ported);
  assert.equal(ported.t.seen.length, 0, "nothing may be written");
}

function sessionIsTheOldClient(): void {
  // The settings the old node passed to new Client(…), as text: they are the
  // reason the statistics no longer pile up (server-side cancel below the client's).
  const func = loadFunctionNode(NODE_ID).func;
  assert.match(func, /application_name: 'udp-troe-stats'/);
  assert.match(func, /connectionTimeoutMillis: 10000, statement_timeout: 50000, query_timeout: 60000/);
  assert.equal(SESSION.applicationName, "udp-troe-stats");
  assert.ok(SESSION.statementTimeoutMs < SESSION.queryTimeoutMs);
  // The busy check looks for exactly this application name.
  assert.ok(SQL_BUSY.includes(`application_name = '${SESSION.applicationName}'`));
}

function rowEstimateWorksOnAHypertable(): void {
  // DELIBERATE DEVIATION (module header): on a hypertable reltuples of the
  // parent stays 0; approximate_row_count() sums the chunks and equals
  // reltuples on a plain table. Everything else in SQL_BASE is the old text.
  assert.ok(
    loadFunctionNode(NODE_ID).func.includes(
      "reltuples::bigint FROM pg_class WHERE oid = 'attributes'::regclass",
    ),
  );
  assert.match(SQL_BASE, /approximate_row_count\('attributes'\) AS rows, /);
  assert.equal(SQL_BASE.includes("reltuples"), false);
  assert.equal(
    SQL_BASE.replace("approximate_row_count('attributes') AS rows, ", ""),
    LEGACY_SQL_BASE.replace(
      "(SELECT reltuples::bigint FROM pg_class WHERE oid = 'attributes'::regclass) AS rows, ",
      "",
    ),
  );
}

export {
  fixtureRunIsIdentical as "troe-stats: same statements, same PlatformStatus:udp-troe, same budget [warn] as the old node on the fixture",
  budgetIsTheRegistrySum as "troe-stats: the budget is the kernel's sumRowBudgets() — equal to the object the generator baked into the old node",
  budgetBranchesMatch as "troe-stats: under, at and over budget, types without budget — warnings identical to the old node",
  budgetExpressionMatches as "troe-stats: budget 0 and Object.prototype names behave as the old BUDGET[t] expression",
  busyRunIsSkipped as "troe-stats: a previous run still active skips the run on both sides, nothing written",
  withoutNightlyTableAndOnEmptyWindow as "troe-stats: no nightly table, empty window, unanalysed table — identical entities",
  failingQueryClosesAndWritesNothing as "troe-stats: a failing query fails the run, closes the connection and writes nothing",
  sessionIsTheOldClient as "troe-stats: session settings are the old client's (udp-troe-stats, 50 s server / 60 s client)",
  rowEstimateWorksOnAHypertable as "troe-stats: the row estimate is approximate_row_count() — also right on a hypertable (deliberate)",
};
