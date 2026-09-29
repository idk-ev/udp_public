/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The kernel's state store (src/kernel/persistence.ts) against a fake
 * database: what survives a restart, what happens while the database is down
 * or a write fails, and what a second instance may do.
 *
 * Everything else is real — change gate, Orion client, pruner, geo, the run
 * wrapper. The fake keeps its rows as JSON text and parses them on load, so
 * the kernel narrows them exactly as it narrows what PostgreSQL returns. A
 * "restart" is a fresh kernel over the same fake database; a "crash" drops the
 * writer lock without the final write.
 */

import assert from "node:assert/strict";

import { SignatureStore } from "../../src/kernel/change-gate.js";
import { createCtx, runConnector } from "../../src/kernel/context.js";
import type { Kernel } from "../../src/kernel/context.js";
import { createDb } from "../../src/kernel/db.js";
import { createEnv } from "../../src/kernel/env.js";
import { createSharedGeo } from "../../src/kernel/geo.js";
import { createHttpServer } from "../../src/kernel/http.js";
import { isArray } from "../../src/kernel/parse.js";
import { Persistence } from "../../src/kernel/persistence.js";
import type { RetryTimer, StateBackend, StateWrite, StoredRows } from "../../src/kernel/persistence.js";
import { createRateLimiter } from "../../src/kernel/rate-limit.js";
import { createRegistry, parseRegistry } from "../../src/kernel/registry.js";
import { createScheduler } from "../../src/kernel/scheduler.js";
import { persisted, stateKey, StateStore } from "../../src/kernel/state.js";
import { NGSI_CONTEXT } from "../../src/kernel/types.js";
import type {
  BoundaryEntry,
  ConnectorRunner,
  Ctx,
  EntityId,
  HttpResponse,
  MunicipalityRow,
  NgsiEntity,
  RegistryEntry,
} from "../../src/kernel/types.js";
import { httpResponse, recordingLog, scriptedFetcher } from "../harness/kernel.js";
import type { RecordedLog, SeenRequest } from "../harness/kernel.js";

const ORION = "http://orion.test";
const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-28T06:00:00Z");

/* ── the fake database ───────────────────────────────────────────────────────*/

const SEP = "\u0000";

/** Rows as JSON text; one writer lock; switchable outages. */
class FakeDatabase {
  reachable = true;
  /** Fails the writes for which it answers `true` (after the lock check). */
  failWrite: (batch: StateWrite) => boolean = () => false;
  /** Fails the loads of the connectors for which it answers `true`. */
  failLoad: (connector: string) => boolean = () => false;
  /** Loads of these connectors wait until {@link release}. */
  readonly held = new Set<string>();
  /** Connector id of every load that reached the database. */
  readonly loads: string[] = [];
  readonly #waiting: (() => void)[] = [];
  lockHolder: FakeBackend | null = null;
  readonly signatures = new Map<string, string>();
  readonly prune = new Map<string, string>();
  readonly state = new Map<string, string>();
  readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  signature(connector: string, table: string, field: string): unknown {
    const text = this.signatures.get([connector, table, field].join(SEP));
    return text === undefined ? undefined : JSON.parse(text);
  }

  stateValue(connector: string, name: string): unknown {
    const text = this.state.get([connector, name].join(SEP));
    return text === undefined ? undefined : JSON.parse(text);
  }

  /** Resolves at once, or — for a held connector — on {@link release}. */
  gate(connector: string): Promise<void> {
    if (!this.held.has(connector)) return Promise.resolve();
    return new Promise((resolve) => {
      this.#waiting.push(resolve);
    });
  }

  /** Lets every held load go on. */
  release(): void {
    this.held.clear();
    for (const resolve of this.#waiting.splice(0)) resolve();
  }
}

function fromJson(text: string): unknown {
  return JSON.parse(text);
}

function refused(): Error {
  return new Error("connect ECONNREFUSED 127.0.0.1:5432");
}

class FakeBackend implements StateBackend {
  readonly description = "fake database";
  readonly #db: FakeDatabase;
  #locked = false;

  constructor(db: FakeDatabase) {
    this.#db = db;
  }

  get locked(): boolean {
    return this.#locked && this.#db.lockHolder === this;
  }

  acquire(): Promise<boolean> {
    if (!this.#db.reachable) return Promise.reject(refused());
    if (this.#db.lockHolder !== null && this.#db.lockHolder !== this) return Promise.resolve(false);
    this.#db.lockHolder = this;
    this.#locked = true;
    return Promise.resolve(true);
  }

  stillHeld(): Promise<boolean> {
    return Promise.resolve(this.locked);
  }

  async load(connector: string): Promise<StoredRows> {
    if (!this.#db.reachable) throw refused();
    this.#db.loads.push(connector);
    await this.#db.gate(connector);
    if (this.#db.failLoad(connector)) throw new Error("load failed (injected)");
    const prefix = `${connector}${SEP}`;
    const signatures: Record<string, unknown>[] = [];
    for (const [key, text] of this.#db.signatures) {
      if (!key.startsWith(prefix)) continue;
      const [, table, field] = key.split(SEP);
      signatures.push({ table_key: table, field, value: JSON.parse(text) });
    }
    const state: Record<string, unknown>[] = [];
    for (const [key, text] of this.#db.state) {
      if (key.startsWith(prefix)) state.push({ name: key.slice(prefix.length), value: JSON.parse(text) });
    }
    const pruneText = this.#db.prune.get(connector);
    return {
      signatures,
      prune: pruneText === undefined ? null : fromJson(pruneText),
      state,
    };
  }

  write(connector: string, batch: StateWrite): Promise<void> {
    if (!this.#db.reachable) return Promise.reject(refused());
    if (!this.locked) return Promise.reject(new Error("writer lock not held"));
    if (this.#db.failWrite(batch)) return Promise.reject(new Error("write failed (injected)"));
    for (const { table, field, value } of batch.signatures) {
      const key = [connector, table, field].join(SEP);
      if (value === null) this.#db.signatures.delete(key);
      else this.#db.signatures.set(key, JSON.stringify(value));
      this.#db.events.push(`db ${value === null ? "delete" : "set"} ${field}`);
    }
    if (batch.prune !== null) this.#db.prune.set(connector, JSON.stringify(batch.prune));
    for (const [name, value] of batch.state)
      this.#db.state.set([connector, name].join(SEP), JSON.stringify(value));
    return Promise.resolve();
  }

  deleteSignatures(connector: string, table: string, fields: readonly string[]): Promise<void> {
    if (!this.#db.reachable) return Promise.reject(refused());
    if (!this.locked) return Promise.reject(new Error("writer lock not held"));
    for (const field of fields) {
      this.#db.signatures.delete([connector, table, field].join(SEP));
      this.#db.events.push(`db delete ${field}`);
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.crash();
    return Promise.resolve();
  }

  /** The process dies: the lock goes with its connection, nothing is written. */
  crash(): void {
    if (this.#db.lockHolder === this) this.#db.lockHolder = null;
    this.#locked = false;
  }

  /**
   * The database switches over (a CloudNativePG switchover on every release):
   * the lock connection drops, the process lives on and may take it again.
   */
  switchover(): void {
    this.crash();
  }
}

/** Retry timers, fired by hand. */
class ManualTimers {
  readonly pending: (() => void)[] = [];

  readonly timer: RetryTimer = (task) => {
    this.pending.push(task);
    return () => {
      const at = this.pending.indexOf(task);
      if (at >= 0) this.pending.splice(at, 1);
    };
  };

  fire(): void {
    for (const task of this.pending.splice(0)) task();
  }
}

/** Lets background work on the (immediate) fake database finish. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/* ── the fake broker ─────────────────────────────────────────────────────────*/

class Broker {
  upsertStatus = 204;
  readonly upserts: Record<string, unknown>[][] = [];
  readonly deletes: string[][] = [];
  /** Ids of `Thing` entities the broker holds, for the prune's listing. */
  readonly things = new Set<string>();
  countRequests = 0;
  readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  readonly respond = (request: SeenRequest): HttpResponse => {
    const path = request.url.pathname;
    if (path.endsWith("/entityOperations/upsert")) {
      const body: unknown = JSON.parse(request.body ?? "[]");
      const entities = isArray(body) ? body.filter(isObject) : [];
      this.upserts.push(entities);
      for (const entity of entities) this.events.push(`broker upsert ${idOf(entity)} ${fullOrFresh(entity)}`);
      if (this.upsertStatus < 300) for (const entity of entities) this.things.add(idOf(entity));
      return httpResponse(this.upsertStatus);
    }
    if (path.endsWith("/entityOperations/delete")) {
      const body: unknown = JSON.parse(request.body ?? "[]");
      const ids = isArray(body) ? body.filter((id): id is string => typeof id === "string") : [];
      this.deletes.push(ids);
      for (const id of ids) {
        this.things.delete(id);
        this.events.push(`broker delete ${id}`);
      }
      return httpResponse(204);
    }
    const type = request.url.searchParams.get("type");
    if (type === "Municipality") {
      this.countRequests += 1;
      return httpResponse(200, "[]", { "ngsild-results-count": "1000" });
    }
    if (type === "Thing") {
      const listed = [...this.things].map((id) => ({ id, type: "Thing" }));
      return httpResponse(200, JSON.stringify(listed), { "ngsild-results-count": String(listed.length) });
    }
    return httpResponse(404);
  };

  /** Entities of the last upsert sent in full (more than the freshness stamp). */
  lastFull(): string[] {
    return (this.upserts.at(-1) ?? []).filter((e) => fullOrFresh(e) === "full").map(idOf);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idOf(entity: Readonly<Record<string, unknown>>): string {
  return typeof entity.id === "string" ? entity.id : "";
}

function fullOrFresh(entity: Readonly<Record<string, unknown>>): "full" | "fresh" {
  const keys = Object.keys(entity).sort().join(",");
  return keys === "@context,dateObserved,id,type" ? "fresh" : "full";
}

/* ── the rig ─────────────────────────────────────────────────────────────────*/

const ENTRIES = parseRegistry({
  connectors: [
    { id: "gated", name: "Gated", scope: "land", intervalSeconds: 3600, runtime: "app" },
    { id: "plain", name: "Plain", scope: "land", intervalSeconds: 3600, runtime: "app" },
  ],
});

function entry(id: string): RegistryEntry {
  const found = ENTRIES.find((candidate) => candidate.id === id);
  assert.ok(found !== undefined);
  return found;
}

/** 1,000 municipalities with boundaries: plausible master data for the prune. */
function plausibleGeo(): { rows: MunicipalityRow[]; boundaries: Record<string, BoundaryEntry> } {
  const rows: MunicipalityRow[] = [];
  const boundaries: Record<string, BoundaryEntry> = {};
  for (let i = 0; i < 1000; i += 1) {
    const ags = `08${String(100000 + i)}`;
    rows.push([ags, `G ${String(i)}`, 48, 9, ags.slice(0, 5), "G", 1000, null, `g-${String(i)}`]);
    boundaries[ags] = {
      b: [0, 0, 1, 1],
      r: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    };
  }
  return { rows, boundaries };
}

interface Process {
  readonly kernel: Kernel;
  readonly backend: FakeBackend;
  readonly log: RecordedLog;
  readonly timers: ManualTimers;
  readonly gated: Ctx;
  readonly plain: Ctx;
}

/** One process of the service over `db`, talking to `broker`. */
function start(db: FakeDatabase, broker: Broker, clock: { now: number }): Process {
  const log = recordingLog();
  const env = createEnv();
  const backend = new FakeBackend(db);
  const timers = new ManualTimers();
  const geo = createSharedGeo(log);
  const master = plausibleGeo();
  geo.setMunicipalities(master.rows);
  geo.setBoundaries(master.boundaries, 0);
  const kernel: Kernel = {
    log,
    env,
    limiter: createRateLimiter(log),
    fetch: scriptedFetcher(broker.respond).fetcher,
    orionUrl: ORION,
    signatures: new SignatureStore(),
    state: new StateStore(),
    persistence: new Persistence(backend, log, () => clock.now, timers.timer),
    geo,
    registry: createRegistry(ENTRIES),
    publicHttp: createHttpServer(log),
    adminHttp: createHttpServer(log),
    scheduler: createScheduler(log),
    db: createDb(env),
    shutdown: new AbortController(),
    nowMs: () => clock.now,
  };
  return {
    kernel,
    backend,
    log,
    timers,
    gated: createCtx(kernel, entry("gated")),
    plain: createCtx(kernel, entry("plain")),
  };
}

/** A persisted counter and a process-lifetime cache. */
const RUNS = stateKey("runs", () => 0, persisted.number);
const CACHE = stateKey("cache", () => 0);

function thing(id: string, now: string): NgsiEntity {
  return {
    id: `urn:ngsi-ld:Thing:${id}`,
    type: "Thing",
    "@context": NGSI_CONTEXT,
    level: { type: "Property", value: 1 },
    dateObserved: { type: "Property", value: { "@type": "DateTime", "@value": now } },
  };
}

/**
 * A gated connector: counts its runs in persisted state, writes one entity
 * per entry of `values` through the change gate (signature = the value) and,
 * with `prune`, removes stale `Thing`s with a confirmation table.
 */
function gatedConnector(values: Map<string, number>, prune = false): ConnectorRunner {
  return {
    id: "gated",
    run: async (ctx) => {
      const runs = ctx.state.slot(RUNS);
      runs.set(runs.get() + 1);
      const cache = ctx.state.slot(CACHE);
      cache.set(cache.get() + 1);
      const now = ctx.now();
      const entities = [...values.keys()].map((id) => thing(id, now));
      const signatureOf = (entity: NgsiEntity): number =>
        values.get(entity.id.slice("urn:ngsi-ld:Thing:".length)) ?? -1;
      await ctx.orion.upsertChanged("thingSig", entities, signatureOf);
      if (!prune) return;
      await ctx.prune.stale({
        label: "Things",
        type: "Thing",
        pattern: "^urn:ngsi-ld:Thing:t-[0-9]+$",
        keep: new Set(entities.map((entity) => entity.id)),
        confirmKey: "thingGone",
        confirmMs: HOUR,
        signatureKey: "thingSig",
      });
    },
  };
}

/** Ungated: writes one entity in full every run, touches no state. */
const plainConnector: ConnectorRunner = {
  id: "plain",
  run: async (ctx) => {
    await ctx.orion.upsert(ctx.gate.ungated([thing("p-1", ctx.now())]));
  },
};

function warned(log: RecordedLog, text: string): number {
  return log.warnings().filter((line) => line.includes(text)).length;
}

const ID = (id: string): EntityId => `urn:ngsi-ld:Thing:${id}`;

/* ── tests ───────────────────────────────────────────────────────────────────*/

/** Restart = new kernel over the same database: the second run writes freshness only. */
export async function stateSurvivesRestart(): Promise<void> {
  const events: string[] = [];
  const db = new FakeDatabase(events);
  const broker = new Broker(events);
  const clock = { now: T0 };
  const values = new Map([
    ["t-0", 1],
    ["t-1", 2],
    ["t-2", 3],
  ]);

  const first = start(db, broker, clock);
  await first.kernel.persistence?.prepareAll();
  await runConnector(first.kernel, first.gated, gatedConnector(values));
  assert.deepEqual(
    broker.lastFull(),
    [ID("t-0"), ID("t-1"), ID("t-2")],
    "first ever run: everything in full",
  );
  assert.equal(db.signature("gated", "thingSig", ID("t-1")), 2, "committed signature persisted");
  assert.equal(db.stateValue("gated", "runs"), 1, "persisted state key written");
  assert.equal(db.stateValue("gated", "cache"), undefined, "a key without codec stays in memory");

  // Crash: no final write, the lock goes with the connection.
  first.backend.crash();
  clock.now += HOUR;
  const second = start(db, broker, clock);
  await second.kernel.persistence?.prepareAll();
  await runConnector(second.kernel, second.gated, gatedConnector(values));

  assert.equal(broker.upserts.length, 2);
  assert.deepEqual(broker.lastFull(), [], "after the restart: freshness only, no full rewrite");
  assert.equal(broker.upserts[1]?.length, 3, "every entity still refreshed");
  assert.equal(second.gated.state.slot(RUNS).get(), 2, "the counter continued");
  assert.equal(second.gated.state.slot(CACHE).get(), 1, "the cache started over");
  assert.ok(second.log.lines.some((line) => line.text.includes("state loaded: 3 signatures in 1 tables")));

  // A value that changes after the restart is still detected.
  values.set("t-2", 30);
  clock.now += HOUR;
  await runConnector(second.kernel, second.gated, gatedConnector(values));
  assert.deepEqual(broker.lastFull(), [ID("t-2")]);
  assert.equal(db.signature("gated", "thingSig", ID("t-2")), 30);

  const health = second.kernel.persistence?.health();
  assert.ok(health !== undefined);
  assert.equal(health.healthy, true);
  assert.deepEqual(health.loaded, ["gated", "plain"]);
}

/** Database down at start: gated connectors skip (and write nothing), ungated ones run. */
export async function databaseDownAtStart(): Promise<void> {
  const events: string[] = [];
  const db = new FakeDatabase(events);
  const broker = new Broker(events);
  const clock = { now: T0 };
  const values = new Map([
    ["t-0", 1],
    ["t-1", 2],
  ]);
  db.reachable = false;

  const service = start(db, broker, clock);
  await service.kernel.persistence?.prepareAll();
  assert.equal(warned(service.log, "state store unreachable"), 1);

  // First run: the service does not know yet that this connector needs its
  // state; it finds out at the first persisted key and ends the run there.
  await runConnector(service.kernel, service.gated, gatedConnector(values));
  assert.equal(broker.upserts.length, 0, "no write on empty tables");
  assert.equal(warned(service.log, "run skipped, state store not usable"), 1);

  await runConnector(service.kernel, service.plain, plainConnector);
  assert.equal(broker.upserts.length, 1, "the ungated connector runs");
  assert.deepEqual(broker.lastFull(), [ID("p-1")]);

  // Second run: skipped before it starts, no second connection attempt within 30 s.
  await runConnector(service.kernel, service.gated, gatedConnector(values));
  assert.equal(broker.upserts.length, 1);
  assert.equal(warned(service.log, "run skipped, state store not usable"), 2);
  assert.equal(warned(service.log, "state store unreachable"), 1, "one warning per outage");
  const down = service.kernel.persistence?.health();
  assert.ok(down !== undefined);
  assert.equal(down.healthy, false);
  assert.equal(down.writer, "unreachable");

  // The database is back: the next run loads and runs.
  db.reachable = true;
  clock.now += 31_000;
  await runConnector(service.kernel, service.gated, gatedConnector(values));
  assert.deepEqual(broker.lastFull(), [ID("t-0"), ID("t-1")]);
  assert.equal(db.signature("gated", "thingSig", ID("t-0")), 1);
  assert.equal(service.gated.state.slot(RUNS).get(), 1, "state starts from what the store held");
}

/**
 * Write failures: nothing the broker did not confirm is ever in the database,
 * the drop of an old signature reaches it BEFORE the new value is sent, and
 * what failed is written on the next attempt.
 */
export async function persistFailureKeepsTheRule(): Promise<void> {
  const events: string[] = [];
  const db = new FakeDatabase(events);
  const broker = new Broker(events);
  const clock = { now: T0 };
  const values = new Map([
    ["t-0", 1],
    ["t-1", 2],
  ]);
  const service = start(db, broker, clock);
  await service.kernel.persistence?.prepareAll();
  await runConnector(service.kernel, service.gated, gatedConnector(values));
  assert.equal(db.signature("gated", "thingSig", ID("t-0")), 1);

  // 1. The drop cannot be persisted: the gated upsert is not sent at all.
  //    The database keeps "1" — which is exactly what the broker still holds.
  values.set("t-0", 10);
  db.failWrite = () => true;
  const sentBefore = broker.upserts.length;
  await runConnector(service.kernel, service.gated, gatedConnector(values));
  assert.equal(broker.upserts.length, sentBefore, "no upsert without the persisted drop");
  assert.equal(warned(service.log, "Upsert not sent"), 1);
  assert.equal(db.signature("gated", "thingSig", ID("t-0")), 1);
  assert.equal(warned(service.log, "state not persisted"), 1);

  // 2. The broker refuses the write: the drop went out first, the new value
  //    is never persisted — the database holds no signature for t-0 at all.
  db.failWrite = () => false;
  broker.upsertStatus = 500;
  events.length = 0;
  await runConnector(service.kernel, service.gated, gatedConnector(values));
  assert.equal(db.signature("gated", "thingSig", ID("t-0")), undefined, "nothing unconfirmed persisted");
  assert.ok(
    events.indexOf(`db delete ${ID("t-0")}`) < events.indexOf(`broker upsert ${ID("t-0")} full`),
    `the drop reaches the database before the value is sent: ${events.join(" | ")}`,
  );
  assert.ok(service.log.lines.some((line) => line.text.startsWith("state persisted again")));

  // 3. The broker confirms, but writing the commit fails (twice: per chunk and
  //    after the upsert) — one warning, memory keeps the truth, the database
  //    stays without the signature (safe: missing = resend).
  broker.upsertStatus = 204;
  db.failWrite = (batch) => batch.signatures.some((row) => row.value !== null);
  const warningsBefore = warned(service.log, "state not persisted");
  await runConnector(service.kernel, service.gated, gatedConnector(values));
  assert.deepEqual(broker.lastFull(), [ID("t-0")]);
  assert.equal(db.signature("gated", "thingSig", ID("t-0")), undefined);
  assert.equal(
    warned(service.log, "state not persisted"),
    warningsBefore + 1,
    "one [warn] per failure streak",
  );

  // 4. The next write retries it: t-0 is unchanged now (freshness only), and
  //    its confirmed signature finally reaches the database.
  db.failWrite = () => false;
  await runConnector(service.kernel, service.gated, gatedConnector(values));
  assert.deepEqual(broker.lastFull(), [], "memory kept the committed signature");
  assert.equal(db.signature("gated", "thingSig", ID("t-0")), 10, "retried and written");
  assert.equal(service.kernel.persistence?.health().failing.length, 0);
}

/** Without the writer lock a second instance runs no gated connector; it takes over once the first is gone. */
export async function secondInstanceWithoutLock(): Promise<void> {
  const events: string[] = [];
  const db = new FakeDatabase(events);
  const broker = new Broker(events);
  const clock = { now: T0 };
  const values = new Map([["t-0", 1]]);

  const first = start(db, broker, clock);
  await first.kernel.persistence?.prepareAll();
  await runConnector(first.kernel, first.gated, gatedConnector(values));
  assert.equal(broker.upserts.length, 1);

  const second = start(db, broker, clock);
  await second.kernel.persistence?.prepareAll();
  assert.equal(warned(second.log, "another instance holds the writer lock"), 1);
  await runConnector(second.kernel, second.gated, gatedConnector(values));
  assert.equal(broker.upserts.length, 1, "no gated write without the lock");
  assert.equal(warned(second.log, "run skipped"), 1);
  await runConnector(second.kernel, second.plain, plainConnector);
  assert.equal(broker.upserts.length, 2, "ungated connectors still run");
  assert.equal(second.kernel.persistence?.health().writer, "standby");

  // The first instance shuts down (final write, lock released); the second
  // takes over on its next attempt and continues from the first one's state.
  await first.kernel.persistence?.close();
  clock.now += 31_000;
  await runConnector(second.kernel, second.gated, gatedConnector(values));
  assert.equal(broker.upserts.length, 3);
  assert.deepEqual(broker.lastFull(), [], "freshness only: the first instance's signatures were loaded");
  assert.equal(second.gated.state.slot(RUNS).get(), 2);
}

/**
 * Prune bookkeeping survives a restart: the first prune after it sees the
 * previous run (interval guard) and the candidate's earlier confirmation, and
 * the master data reference needs no new seed from Orion.
 */
export async function pruneBookkeepingSurvivesRestart(): Promise<void> {
  const events: string[] = [];
  const db = new FakeDatabase(events);
  const broker = new Broker(events);
  const clock = { now: T0 };
  const values = new Map([
    ["t-0", 1],
    ["t-1", 2],
    ["t-2", 3],
    ["t-9", 9],
  ]);

  const first = start(db, broker, clock);
  await first.kernel.persistence?.prepareAll();
  // Run 1: first prune ever — skipped quietly by the interval guard.
  await runConnector(first.kernel, first.gated, gatedConnector(values, true));
  assert.ok(first.log.lines.some((line) => line.text.includes("prune skipped, no successful run")));
  assert.equal(broker.countRequests, 1, "reference seeded from Orion once");
  assert.equal(db.signature("gated", "thingSig", ID("t-9")), 9);

  // Run 2: t-9 left the source — a candidate, seen once.
  values.delete("t-9");
  clock.now += HOUR;
  await runConnector(first.kernel, first.gated, gatedConnector(values, true));
  assert.equal(broker.deletes.length, 0, "one sighting is not enough");

  // Crash and restart.
  first.backend.crash();
  clock.now += HOUR;
  const second = start(db, broker, clock);
  await second.kernel.persistence?.prepareAll();
  await runConnector(second.kernel, second.gated, gatedConnector(values, true));

  assert.ok(
    !second.log.lines.some((line) => line.text.includes("no successful run")),
    "the interval guard saw the run before the restart",
  );
  assert.deepEqual(broker.deletes, [[ID("t-9")]], "second consecutive sighting after 2 h: deleted");
  assert.equal(broker.countRequests, 1, "the master data reference came from the store");
  assert.equal(db.signature("gated", "thingSig", ID("t-9")), undefined, "its signature left the store first");
  const dropped = events.indexOf(`db delete ${ID("t-9")}`);
  assert.ok(
    dropped >= 0 && dropped < events.indexOf(`broker delete ${ID("t-9")}`),
    `the signature left the store before the delete went out: ${events.join(" | ")}`,
  );
}

/** Before the state is loaded the prune is skipped, and not even the master data are seeded. */
export async function pruneSkipsWhileNotLoaded(): Promise<void> {
  const events: string[] = [];
  const db = new FakeDatabase(events);
  const broker = new Broker(events);
  const clock = { now: T0 };
  const service = start(db, broker, clock);
  const result = await service.gated.prune.stale({
    label: "Things",
    type: "Thing",
    pattern: "^urn:ngsi-ld:Thing:t-[0-9]+$",
  });
  assert.equal(result.skipped, "state store not loaded (not connected yet)");
  assert.equal(warned(service.log, "Things: prune skipped, state store not loaded"), 1);
  assert.equal(broker.countRequests, 0, "not even the master data seed");
  assert.equal(await service.gated.prune.masterDataPlausible(), false);
}

/**
 * The guard in front of Orion, on its own: a plan that carries pending
 * signatures is not sent while the state is not usable — whether it was
 * built by hand before any load or checked before the lock was lost.
 */
export async function gatedUpsertRefusedWhileNotUsable(): Promise<void> {
  const events: string[] = [];
  const db = new FakeDatabase(events);
  const broker = new Broker(events);
  const clock = { now: T0 };
  const service = start(db, broker, clock);
  const now = new Date(clock.now).toISOString();

  const handBuilt = await service.gated.orion.upsert({
    entities: [thing("t-5", now)],
    pending: [["thingSig", ID("t-5"), 5, ID("t-5")]],
  });
  assert.equal(broker.upserts.length, 0, "never loaded: not sent");
  assert.deepEqual([handBuilt.failedChunks, handBuilt.committed, handBuilt.dropped], [1, 0, 1]);

  await service.kernel.persistence?.prepareAll();
  const plan = service.gated.gate.check("thingSig", [thing("t-6", now)], () => 6);
  service.backend.crash();
  const afterLoss = await service.gated.orion.upsert(plan);
  assert.equal(broker.upserts.length, 0, "lock lost after the check: not sent");
  assert.equal(afterLoss.failedChunks, 1);
  assert.equal(warned(service.log, "Upsert not sent"), 2);
  assert.throws(() => service.gated.gate.check("thingSig", [], () => 0), /state store not usable/);

  // Ungated writes are not the store's business.
  await service.plain.orion.upsert(service.plain.gate.ungated([thing("p-1", now)]));
  assert.equal(broker.upserts.length, 1);
}

/** The first process of a lock-change test: one gated run, its signatures and counter in the store. */
async function afterOneGatedRun(): Promise<{
  db: FakeDatabase;
  broker: Broker;
  service: Process;
  values: Map<string, number>;
}> {
  const events: string[] = [];
  const db = new FakeDatabase(events);
  const broker = new Broker(events);
  const clock = { now: T0 };
  const values = new Map([
    ["t-0", 1],
    ["t-1", 2],
  ]);
  const service = start(db, broker, clock);
  await service.kernel.persistence?.prepareAll();
  await runConnector(service.kernel, service.gated, gatedConnector(values));
  assert.deepEqual(broker.lastFull(), [ID("t-0"), ID("t-1")]);
  return { db, broker, service, values };
}

/**
 * A database switchover takes the writer lock; the next run of ANY connector
 * takes it back, and every connector is reloaded at once — not each before
 * its own next run, which for some is twelve hours away (`healthy: false`
 * for hours after every release).
 */
export async function lockRegainedReloadsEveryConnector(): Promise<void> {
  const { db, broker, service, values } = await afterOneGatedRun();
  const persistence = service.kernel.persistence;
  assert.ok(persistence !== undefined);
  db.loads.length = 0;

  service.backend.switchover();
  const lost = persistence.health();
  assert.equal(lost.healthy, false);
  assert.equal(lost.reason, "writer lock lost");

  // Only the ungated connector runs; it notices the loss and takes the lock back.
  await runConnector(service.kernel, service.plain, plainConnector);
  await settle();
  assert.equal(warned(service.log, "writer lock lost — every connector's state is reloaded"), 1);
  assert.deepEqual([...db.loads].sort(), ["gated", "plain"], "both loaded, the gated one without a run");
  assert.equal(broker.upserts.length, 2, "the gated connector did not run");
  const health = persistence.health();
  assert.deepEqual(
    [health.healthy, health.reason, health.reloading, health.notLoaded, health.loadFailed],
    [true, null, false, [], []],
  );
  assert.deepEqual(health.loaded, ["gated", "plain"]);

  // Its next run finds its signatures: freshness only, and the counter goes on.
  await runConnector(service.kernel, service.gated, gatedConnector(values));
  assert.deepEqual(broker.lastFull(), []);
  assert.equal(service.gated.state.slot(RUNS).get(), 2);
  assert.equal(db.loads.filter((id) => id === "gated").length, 1, "loaded once, not again before the run");
}

/** A load failing in the eager reload is unhealthy with a reason, warned once, and retried until it works. */
export async function reloadFailureIsUnhealthyAndRetried(): Promise<void> {
  const { db, service } = await afterOneGatedRun();
  const persistence = service.kernel.persistence;
  assert.ok(persistence !== undefined);

  service.backend.switchover();
  db.failLoad = (connector) => connector === "gated";
  await runConnector(service.kernel, service.plain, plainConnector);
  await settle();

  const failed = persistence.health();
  assert.equal(failed.healthy, false);
  assert.equal(failed.reason, "state load failing: gated (load failed (injected))");
  assert.deepEqual([failed.loadFailed, failed.notLoaded, failed.loaded], [["gated"], ["gated"], ["plain"]]);
  assert.equal(warned(service.log, "state not loaded (load failed (injected))"), 1);
  assert.equal(service.timers.pending.length, 1, "one retry scheduled");

  // Still failing: retried again, no second warning.
  service.timers.fire();
  await settle();
  assert.equal(persistence.health().healthy, false);
  assert.equal(warned(service.log, "state not loaded"), 1, "one [warn] per failure streak");
  assert.equal(service.timers.pending.length, 1);

  // The database answers again: the retry loads it, without any run.
  db.failLoad = () => false;
  service.timers.fire();
  await settle();
  const healed = persistence.health();
  assert.deepEqual(
    [healed.healthy, healed.reason, healed.loadFailed, healed.notLoaded],
    [true, null, [], []],
  );
  assert.equal(service.timers.pending.length, 0);
}

/**
 * A run that races the eager reload waits for the load of its state (one
 * read, not two) and never runs on unloaded state; while the reload is merely
 * under way, the store counts as healthy.
 */
export async function runRacingTheReloadWaitsForItsState(): Promise<void> {
  const { db, broker, service, values } = await afterOneGatedRun();
  const persistence = service.kernel.persistence;
  assert.ok(persistence !== undefined);
  db.loads.length = 0;
  const sent = broker.upserts.length;

  service.backend.switchover();
  db.held.add("gated");
  await runConnector(service.kernel, service.plain, plainConnector);
  await settle();
  const queued = persistence.health();
  assert.deepEqual(
    [queued.healthy, queued.reason, queued.reloading, queued.notLoaded],
    [true, null, true, ["gated"]],
    "queued in the running reload: healthy",
  );

  const racing = runConnector(service.kernel, service.gated, gatedConnector(values));
  await settle();
  assert.equal(broker.upserts.length, sent + 1, "only the plain run wrote; the gated run waits");
  assert.equal(db.stateValue("gated", "runs"), 1, "not run on unloaded state");

  db.release();
  await racing;
  assert.deepEqual(broker.lastFull(), [], "ran on its loaded signatures: freshness only");
  assert.equal(service.gated.state.slot(RUNS).get(), 2);
  assert.equal(db.loads.filter((id) => id === "gated").length, 1, "the run waited for the reload's read");
  const done = persistence.health();
  assert.deepEqual([done.healthy, done.reloading, done.notLoaded], [true, false, []]);
}
