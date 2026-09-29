/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The kernel's state store: change signatures, prune bookkeeping and the
 * persisted `ctx.state` keys of every connector, kept in PostgreSQL so that a
 * restart does not reset them.
 *
 * ## Why
 *
 * Under Compose Node-RED kept its flow context on a volume, so a restart
 * rewrote almost nothing. A process that forgets its signature tables writes
 * EVERY gated entity in full on its first run: ~400k TRoE rows per restart,
 * `parken-bw` alone ~230k against a budget of 25k a day. Every cutover group
 * of phase 4 needs a restart, and a crash loop multiplies it — the territory
 * of the ParkAPI incident. The MaStR rotation would start at 0 each time.
 *
 * ## Where
 *
 * The TimescaleDB the SQL connectors use (same settings as `ctx.db`, database
 * `orion`), in a schema of its own — `udp_connectors`, never Orion's TRoE
 * tables. See src/kernel/persistence-pg.ts for the tables. Everything is
 * scoped by connector id.
 *
 * ## The rules
 *
 *  * **Load before the first run.** Every bound connector is loaded as soon
 *    as the writer lock is held — at startup and again, eagerly and in the
 *    background, whenever the lock was lost and taken again (a database
 *    switchover): {@link Persistence.reloadAll}. A load that fails is retried
 *    after 30 s. Before every run the connector's own load is checked once
 *    more (the safety net: a run never proceeds on unloaded state, it waits
 *    for a load in flight or loads itself). While a connector's state is not
 *    loaded, everything that would act on it refuses: the change gate and
 *    persisted `ctx.state` keys throw {@link StateUnavailableError} (the run
 *    is skipped with a `[warn]`), prunes are skipped, and a gated upsert is
 *    not sent. Running on empty tables is exactly the flood this exists to
 *    prevent. Connectors that use none of it (ungated writes only) run as
 *    before.
 *  * **The database never holds a signature the broker did not confirm.** A
 *    signature DROPPED in memory (the gate saw a change, a table was
 *    replaced, retained or forgotten) is persisted BEFORE the upsert goes out
 *    ({@link GuardedOrion}); if that write fails, a gated upsert is not sent
 *    at all — otherwise a restart could resurrect the old signature for a
 *    value the broker no longer holds, and a value flipping back would be
 *    frozen. A COMMITTED signature is persisted after the broker confirmed it,
 *    batched per chunk; losing that write only costs a resend. Before a prune
 *    deletes, the candidates' signatures leave the database first
 *    ({@link ConnectorPersistence.forgetAhead}).
 *  * **A failed write keeps the in-memory truth.** Everything not written
 *    stays marked and goes out with the next write; one `[warn]` per failure
 *    streak, one info line when it recovers.
 *  * **One writer.** The service runs as ONE replica (Helm: `replicas: 1`,
 *    strategy `Recreate`). A session advisory lock, held for the process
 *    lifetime, enforces it: an instance without the lock loads nothing and so
 *    runs no connector that needs its state; it retries, and takes over (with
 *    a fresh load) once the other instance is gone. Losing the lock
 *    connection unloads every connector; once the lock is back, all of them
 *    are reloaded at once, not each before its next run.
 *
 * Prune bookkeeping and state values are written when they change (a state
 * key changed in place, a `Map`, is caught by the write at the end of every
 * run). Shutdown writes what is left and releases the lock.
 */

import type { SignatureScope, SignatureStore } from "./change-gate.js";
import { chunk, DEFAULT_CHUNK_SIZE, sizeOr } from "./orion.js";
import { PruneBookkeeping } from "./prune.js";
import type { PruneStore } from "./prune.js";
import { StateUnavailableError } from "./state.js";
import type { StateHooks, StateSnapshotter, StateStore } from "./state.js";
import type {
  ChangeGate,
  ChangeGateOptions,
  ConnectorId,
  DeleteOptions,
  DeleteResult,
  EntityId,
  JsonResponse,
  JsonValue,
  ListOptions,
  ListResult,
  Log,
  NgsiEntity,
  Orion,
  OrionQuery,
  OrionReadOptions,
  SignatureValue,
  UpsertOptions,
  UpsertPlan,
  UpsertResult,
} from "./types.js";

/** One signature row to write; `value: null` deletes it. */
export interface SignatureRow {
  readonly table: string;
  readonly field: string;
  readonly value: SignatureValue | null;
}

/** Everything one connector writes in one transaction. */
export interface StateWrite {
  readonly signatures: readonly SignatureRow[];
  /** The whole prune bookkeeping document, or `null` if it did not change. */
  readonly prune: JsonValue | null;
  readonly state: readonly (readonly [name: string, value: JsonValue])[];
}

/** One connector's rows as the database returned them — external data, narrowed on load. */
export interface StoredRows {
  /** `{ table_key, field, value }` */
  readonly signatures: readonly Readonly<Record<string, unknown>>[];
  /** The bookkeeping document, `null` when there is no row. */
  readonly prune: unknown;
  /** `{ name, value }` */
  readonly state: readonly Readonly<Record<string, unknown>>[];
}

/** The storage behind {@link Persistence}: PostgreSQL in the service, a fake in the tests. */
export interface StateBackend {
  /** Where the state lives, for logs and `/healthz`. */
  readonly description: string;
  /** Whether the writer lock is held, as far as the backend knows right now. */
  readonly locked: boolean;
  /**
   * Becomes the single writer: takes the advisory lock (held until
   * {@link close}) and creates the schema. `false` = another instance holds
   * it. Throws when the database cannot be reached.
   */
  acquire(): Promise<boolean>;
  /** Checks that the lock connection is still alive; `false` = lock lost. */
  stillHeld(): Promise<boolean>;
  load(connector: ConnectorId): Promise<StoredRows>;
  /** One transaction. Throws if the lock is not held. */
  write(connector: ConnectorId, batch: StateWrite): Promise<void>;
  deleteSignatures(connector: ConnectorId, table: string, fields: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

/** After a failed connection attempt or load, the next one waits this long. */
export const RETRY_AFTER_MS = 30_000;

/** Runs `task` once after `ms`; returns what cancels it. */
export type RetryTimer = (task: () => void, ms: number) => () => void;

/** Unref'd: a pending retry never keeps the process alive. */
const unrefTimer: RetryTimer = (task, ms) => {
  const timer = setTimeout(task, ms);
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
};

type WriterState = "idle" | "writer" | "standby" | "unreachable" | "closed";

/**
 * A refused connection to `localhost` (IPv6 and IPv4) arrives as an
 * `AggregateError` with an empty message; the log line needs its parts.
 */
export function describe(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map((part: unknown) => describe(part)).join("; ");
  }
  if (!(error instanceof Error)) return String(error);
  if (error.message !== "") return error.message;
  const code = "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : error.name;
}

function isSignatureValue(value: unknown): value is SignatureValue {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** What `/healthz` reports. */
export interface StateStoreHealth {
  readonly backend: string;
  readonly writer: WriterState;
  /**
   * Writer lock held, no load and no write failing, and every connector
   * loaded — or still queued in the reload that is running right now
   * (seconds after startup or a lock change, see `reloading`). Also `true`
   * when no connector needs the store.
   */
  readonly healthy: boolean;
  /** Why `healthy` is false; `null` exactly when it is true. */
  readonly reason: string | null;
  /** The eager reload of every connector is running (after startup or a lock change). */
  readonly reloading: boolean;
  readonly loaded: readonly ConnectorId[];
  readonly notLoaded: readonly ConnectorId[];
  /** Connectors whose last load failed; retried after 30 s and before their next run. */
  readonly loadFailed: readonly ConnectorId[];
  /** Connectors whose last write failed; retried with the next write. */
  readonly failing: readonly ConnectorId[];
}

export interface ConnectorBinding {
  /** The connector's own logger: its warnings are grouped under its name. */
  readonly log: Log;
  readonly signatures: SignatureStore;
  readonly state: StateStore;
}

/** The state store of the whole service. One per process, owned by the kernel. */
export class Persistence {
  readonly #backend: StateBackend;
  readonly #log: Log;
  readonly #nowMs: () => number;
  readonly #connectors = new Map<ConnectorId, ConnectorPersistence>();
  #writer: WriterState = "idle";
  #reason = "not connected yet";
  #failedAt: number | null = null;
  #checking: Promise<boolean> | null = null;
  readonly #timer: RetryTimer;
  /** The running reload of every connector, see {@link reloadAll}. */
  #reloading: Promise<void> | null = null;
  #reloadRequested = false;
  /** Cancels the pending retry of failed loads. */
  #cancelRetry: (() => void) | null = null;

  constructor(
    backend: StateBackend,
    log: Log,
    nowMs: () => number = Date.now,
    timer: RetryTimer = unrefTimer,
  ) {
    this.#backend = backend;
    this.#log = log;
    this.#nowMs = nowMs;
    this.#timer = timer;
  }

  get backend(): StateBackend {
    return this.#backend;
  }

  /** The persistence of connector `id`, bound to its tables on first call. */
  connector(id: ConnectorId, binding: ConnectorBinding): ConnectorPersistence {
    let connector = this.#connectors.get(id);
    if (connector === undefined) {
      connector = new ConnectorPersistence(this, id, binding);
      this.#connectors.set(id, connector);
    }
    return connector;
  }

  /** The writer lock is held and still alive. */
  writable(): boolean {
    return this.#writer === "writer" && this.#backend.locked;
  }

  get closed(): boolean {
    return this.#writer === "closed";
  }

  reason(): string {
    if (this.#writer === "writer" && !this.#backend.locked) return "writer lock lost";
    return this.#reason;
  }

  /**
   * Before a run of `id`: the writer lock, then the connector's load — the
   * safety net behind {@link reloadAll}. A load of `id` already in flight
   * (the eager reload) is waited for, not repeated. Never throws; `true` =
   * the state is usable.
   */
  async prepare(id: ConnectorId): Promise<boolean> {
    const connector = this.#connectors.get(id);
    if (connector === undefined) return true;
    if (!(await this.#ensureWriter())) return false;
    return connector.ensureLoaded();
  }

  /** Startup: the writer lock once, then every bound connector's load (awaited). */
  async prepareAll(): Promise<void> {
    if (!(await this.#ensureWriter())) return;
    // Taking the lock started the reload already; a second pass would only
    // repeat a failed load at once instead of after the retry delay.
    await (this.#reloading ?? this.reloadAll());
  }

  /**
   * Loads every bound connector that is not loaded, one after the other, each
   * on its own: a failure is that connector's, logged and retried after
   * {@link RETRY_AFTER_MS}. Started whenever the writer lock is taken — at
   * startup and after a lock change (a database switchover) — so that no
   * connector waits for its next run, which for some is twelve hours away.
   * One reload at a time; a request while one runs makes it go round once
   * more. Never throws.
   */
  reloadAll(): Promise<void> {
    this.#reloadRequested = true;
    this.#reloading ??= this.#reloadPasses();
    return this.#reloading;
  }

  async #reloadPasses(): Promise<void> {
    // Yield first, so that #reloading is assigned before this can finish.
    await Promise.resolve();
    try {
      while (this.#reloadRequested) {
        this.#reloadRequested = false;
        for (const connector of this.#connectors.values()) {
          // The lock went again: taking it back requests the next pass.
          if (!this.writable()) break;
          await connector.ensureLoaded();
        }
      }
    } finally {
      this.#reloading = null;
    }
  }

  /** A load failed: every failed one is retried after {@link RETRY_AFTER_MS} (one timer at a time). */
  loadFailed(): void {
    if (this.#cancelRetry !== null || this.closed) return;
    this.#cancelRetry = this.#timer(() => {
      this.#cancelRetry = null;
      void this.#retryLoads();
    }, RETRY_AFTER_MS);
  }

  async #retryLoads(): Promise<void> {
    if (this.closed) return;
    // The lock first: a lost one is taken again, which starts a reload itself.
    if (await this.#ensureWriter()) await this.reloadAll();
  }

  /** `id` touched its persisted state before and so cannot run without it. */
  needsState(id: ConnectorId): boolean {
    return this.#connectors.get(id)?.needsState ?? false;
  }

  /** Why `id`'s state is not usable; `""` when it is. */
  connectorReason(id: ConnectorId): string {
    return this.#connectors.get(id)?.reason() ?? "";
  }

  /** Writes whatever `id` still has marked. `true` when nothing is left. */
  async flush(id: ConnectorId): Promise<boolean> {
    return (await this.#connectors.get(id)?.flush()) ?? true;
  }

  /** Writes whatever is still marked, for every connector. */
  async flushAll(): Promise<void> {
    await Promise.all([...this.#connectors.values()].map((connector) => connector.flush()));
  }

  /** Shutdown: the last write, then the lock goes. */
  async close(): Promise<void> {
    if (this.#writer === "closed") return;
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    if (this.writable()) await this.flushAll();
    this.#writer = "closed";
    this.#reason = "shutting down";
    await this.#backend.close();
  }

  health(): StateStoreHealth {
    const all = [...this.#connectors.values()];
    const loaded = all.filter((c) => c.loaded).map((c) => c.id);
    const notLoaded = all.filter((c) => !c.loaded).map((c) => c.id);
    const loadFailed = all.filter((c) => c.loadError !== null);
    const failing = all.filter((c) => c.failing);
    const reloading = this.#reloading !== null;
    const reason = this.#unhealthyBecause(all.length, notLoaded, loadFailed, failing, reloading);
    return {
      backend: this.#backend.description,
      writer: this.#writer,
      healthy: reason === null,
      reason,
      reloading,
      loaded,
      notLoaded,
      loadFailed: loadFailed.map((c) => c.id),
      failing: failing.map((c) => c.id),
    };
  }

  /** `null` = healthy; otherwise never empty. */
  #unhealthyBecause(
    bound: number,
    notLoaded: readonly ConnectorId[],
    loadFailed: readonly ConnectorPersistence[],
    failing: readonly ConnectorPersistence[],
    reloading: boolean,
  ): string | null {
    // Nothing bound (no connector on runtime "app"): nothing to be unhealthy about.
    if (bound === 0) return null;
    if (!this.writable()) return this.reason() || "writer lock not held";
    const [firstLoad] = loadFailed;
    if (firstLoad !== undefined) {
      const ids = loadFailed.map((c) => c.id).join(", ");
      return `state load failing: ${ids} (${firstLoad.loadError ?? "unknown"})`;
    }
    const [firstWrite] = failing;
    if (firstWrite !== undefined) {
      const ids = failing.map((c) => c.id).join(", ");
      return `state writes failing: ${ids} (${firstWrite.failure ?? "unknown"})`;
    }
    // Merely queued in the running reload: loaded within seconds, no problem.
    if (notLoaded.length > 0 && !reloading) return `state not loaded: ${notLoaded.join(", ")}`;
    return null;
  }

  #ensureWriter(): Promise<boolean> {
    this.#checking ??= this.#checkWriter().finally(() => {
      this.#checking = null;
    });
    return this.#checking;
  }

  async #checkWriter(): Promise<boolean> {
    if (this.#writer === "closed") return false;
    if (this.#writer === "writer") {
      if (await this.#backend.stillHeld()) return true;
      this.#log.warn(
        "state store: writer lock lost — every connector's state is reloaded as soon as it is back",
      );
      this.#writer = "idle";
      this.#reason = "writer lock lost";
      for (const connector of this.#connectors.values()) connector.unload();
    }
    if (this.#failedAt !== null && this.#nowMs() - this.#failedAt < RETRY_AFTER_MS) return false;
    try {
      const acquired = await this.#backend.acquire();
      if (!acquired) {
        if (this.#writer !== "standby") {
          this.#log.warn(
            "state store: another instance holds the writer lock — connectors that need their persisted " +
              "state do not run here (the service must run as exactly one replica)",
          );
        }
        this.#writer = "standby";
        this.#reason = "another instance holds the writer lock";
        this.#failedAt = this.#nowMs();
        return false;
      }
    } catch (error) {
      if (this.#writer !== "unreachable") {
        this.#log.warn(
          `state store unreachable (${describe(error)}) — connectors that need their persisted state ` +
            "skip their runs until it is back",
        );
      }
      this.#writer = "unreachable";
      this.#reason = `unreachable: ${describe(error)}`;
      this.#failedAt = this.#nowMs();
      return false;
    }
    this.#writer = "writer";
    this.#reason = "";
    this.#failedAt = null;
    this.#log.info(
      `state store: writer lock held (${this.#backend.description}) — loading every connector's state`,
    );
    // In the background: a run that needs its state now waits for (or does)
    // its own load; all others no longer wait for their next run.
    void this.reloadAll();
    return true;
  }
}

/**
 * The state store of one connector: observer of its signature tables, store
 * of its pruner, hooks of its `ctx.state`. Kernel-internal.
 */
export class ConnectorPersistence implements PruneStore, StateHooks {
  readonly id: ConnectorId;
  /** Shared by every ctx of this connector (pruner and geo view). */
  readonly bookkeeping = new PruneBookkeeping();
  readonly #owner: Persistence;
  readonly #log: Log;
  readonly #signatures: SignatureScope;
  readonly #state: StateSnapshotter;
  /** Table -> fields changed in memory and not written yet. */
  readonly #dirty = new Map<string, Set<string>>();
  #pruneDirty = false;
  /** Name -> JSON of the value last written (or loaded). */
  #stateWritten = new Map<string, string>();
  #loaded = false;
  /** Touched the gate or a persisted state key: needs its state to run. */
  #needsState = false;
  #failing: string | null = null;
  /** Why the last load failed; `null` after a successful one. */
  #loadError: string | null = null;
  /** Bumped by {@link unload}: a load that started before it is stale. */
  #epoch = 0;
  #flushQueued = false;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(owner: Persistence, id: ConnectorId, binding: ConnectorBinding) {
    this.#owner = owner;
    this.id = id;
    this.#log = binding.log;
    this.#signatures = binding.signatures.scope(id);
    binding.signatures.observe(id, {
      assertLoaded: () => {
        this.assertUsable();
      },
      changed: (key, fields) => {
        this.#changed(key, fields);
      },
    });
    this.#state = binding.state.attach(id, this);
    this.bookkeeping.onChange(() => {
      if (!this.#loaded) return;
      this.#pruneDirty = true;
      this.#schedule();
    });
  }

  get loaded(): boolean {
    return this.#loaded;
  }

  get failing(): boolean {
    return this.#failing !== null;
  }

  /** Why the last write failed; `null` when it did not. */
  get failure(): string | null {
    return this.#failing;
  }

  /** Why the last load failed; `null` when it did not. */
  get loadError(): string | null {
    return this.#loadError;
  }

  /** This connector used the gate or a persisted state key: without its state it does not run. */
  get needsState(): boolean {
    return this.#needsState;
  }

  usable(): boolean {
    return this.#loaded && this.#owner.writable();
  }

  reason(): string {
    if (!this.#owner.writable()) return this.#owner.reason();
    return this.#loaded ? "" : "not loaded";
  }

  /* ── StateHooks (and the gate's assertLoaded) ── */

  assertUsable(): void {
    this.#needsState = true;
    if (!this.usable()) throw new StateUnavailableError(this.reason());
  }

  changed(): void {
    if (this.#loaded) this.#schedule();
  }

  invalid(name: string): void {
    this.#log.warn(`persisted state "${name}" not readable — starting from its initial value`);
  }

  /* ── load ── */

  /**
   * Loads the state unless it is loaded. Serialised with every other load and
   * write of this connector: a caller while a load is in flight waits for it
   * and gets its outcome. Never throws.
   */
  ensureLoaded(): Promise<boolean> {
    if (this.#loaded) return Promise.resolve(true);
    return this.#enqueue(() => this.#load()).catch((error: unknown) => this.#loadFailed(describe(error)));
  }

  /** The writer lock was lost: whatever is in memory may be stale by the next run. */
  unload(): void {
    this.#loaded = false;
    this.#loadError = null;
    this.#epoch += 1;
    this.#dirty.clear();
    this.#pruneDirty = false;
  }

  #loadFailed(reason: string): false {
    if (this.#owner.closed) return false;
    if (this.#loadError === null) {
      this.#log.warn(`state not loaded (${reason}) — retried in 30 s and before the next run`);
    }
    this.#loadError = reason;
    this.#owner.loadFailed();
    return false;
  }

  async #load(): Promise<boolean> {
    if (this.#loaded) return true;
    const epoch = this.#epoch;
    let rows: StoredRows;
    try {
      rows = await this.#owner.backend.load(this.id);
    } catch (error) {
      if (epoch !== this.#epoch) return false;
      return this.#loadFailed(describe(error));
    }
    // The lock changed hands while this read: the reload after it reads again.
    if (epoch !== this.#epoch) return false;
    const tables = new Map<string, Map<string, SignatureValue>>();
    let signatures = 0;
    let unreadable = 0;
    for (const row of rows.signatures) {
      const table = row.table_key;
      const field = row.field;
      const value = row.value;
      if (typeof table !== "string" || typeof field !== "string" || !isSignatureValue(value)) {
        // Unreadable = absent: the entity counts as changed and is written once.
        unreadable += 1;
        continue;
      }
      let target = tables.get(table);
      if (target === undefined) {
        target = new Map();
        tables.set(table, target);
      }
      target.set(field, value);
      signatures += 1;
    }
    const values = new Map<string, unknown>();
    for (const row of rows.state) {
      if (typeof row.name === "string") values.set(row.name, row.value);
    }
    this.#dirty.clear();
    this.#signatures.load(tables);
    const bookkeepingOk = this.bookkeeping.restore(rows.prune);
    // Rewrite a document that did not narrow instead of reading it again.
    this.#pruneDirty = !bookkeepingOk;
    this.#stateWritten = new Map([...values].map(([name, value]) => [name, JSON.stringify(value)]));
    this.#loaded = true;
    this.#loadError = null;
    this.#state.restore(values);
    if (!bookkeepingOk) this.#log.warn("persisted prune bookkeeping not readable — starting empty");
    this.#log.info(
      `state loaded: ${String(signatures)} signatures in ${String(tables.size)} tables, ` +
        `${String(values.size)} state values` +
        (unreadable > 0 ? `, ${String(unreadable)} unreadable signatures ignored` : ""),
    );
    return true;
  }

  /* ── write ── */

  /** Writes everything marked. Serialised; never throws. `false` = something is still unwritten. */
  flush(): Promise<boolean> {
    return this.#enqueue(() => this.#flushNow());
  }

  /** Some field is marked whose value is GONE from memory — a drop the database does not know yet. */
  hasUnwrittenDrops(): boolean {
    for (const [table, fields] of this.#dirty) {
      for (const field of fields) if (this.#signatures.valueOf(table, field) === undefined) return true;
    }
    return false;
  }

  forgetAhead(key: string, fields: readonly string[]): Promise<boolean> {
    return this.#enqueue(async () => {
      if (!this.usable()) return this.#failed(this.reason());
      try {
        await this.#owner.backend.deleteSignatures(this.id, key, fields);
      } catch (error) {
        return this.#failed(describe(error));
      }
      this.#recovered();
      return true;
    });
  }

  /** A guarded Orion client for this connector; see {@link GuardedOrion}. */
  guard(inner: Orion, gate: ChangeGate): Orion {
    return new GuardedOrion(inner, gate, this, this.#log);
  }

  #changed(key: string, fields: Iterable<string>): void {
    if (!this.#loaded) return; // the next load replaces memory anyway
    let marked = this.#dirty.get(key);
    if (marked === undefined) {
      marked = new Set();
      this.#dirty.set(key, marked);
    }
    for (const field of fields) marked.add(field);
    this.#schedule();
  }

  /** At most one queued background write; it picks up everything marked by then. */
  #schedule(): void {
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    void this.#enqueue(() => {
      this.#flushQueued = false;
      return this.#flushNow();
    });
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #flushNow(): Promise<boolean> {
    if (!this.#loaded) return true; // nothing is marked before a load
    const taken = new Map(this.#dirty);
    this.#dirty.clear();
    const signatures: SignatureRow[] = [];
    for (const [table, fields] of taken) {
      for (const field of fields) {
        signatures.push({ table, field, value: this.#signatures.valueOf(table, field) ?? null });
      }
    }
    const prune = this.#pruneDirty ? this.bookkeeping.snapshot() : null;
    this.#pruneDirty = false;
    const state: [string, JsonValue][] = [];
    const written = new Map<string, string>();
    for (const [name, value] of this.#state.snapshot()) {
      const text = JSON.stringify(value);
      if (this.#stateWritten.get(name) === text) continue;
      state.push([name, value]);
      written.set(name, text);
    }
    if (signatures.length === 0 && prune === null && state.length === 0) return true;

    try {
      if (!this.#owner.writable()) throw new Error(this.#owner.reason());
      await this.#owner.backend.write(this.id, { signatures, prune, state });
    } catch (error) {
      // Mark again what was taken — merged with whatever was marked meanwhile.
      for (const [table, fields] of taken) this.#changedQuietly(table, fields);
      if (prune !== null) this.#pruneDirty = true;
      return this.#failed(describe(error));
    }
    for (const [name, text] of written) this.#stateWritten.set(name, text);
    this.#recovered();
    return true;
  }

  #changedQuietly(key: string, fields: Iterable<string>): void {
    let marked = this.#dirty.get(key);
    if (marked === undefined) {
      marked = new Set();
      this.#dirty.set(key, marked);
    }
    for (const field of fields) marked.add(field);
  }

  #failed(reason: string): false {
    if (this.#owner.closed) return false;
    if (this.#failing === null) {
      this.#log.warn(`state not persisted (${reason}) — kept in memory, retried with the next write`);
    }
    this.#failing = reason;
    return false;
  }

  #recovered(): void {
    if (this.#failing === null) return;
    this.#log.info(`state persisted again (after: ${this.#failing})`);
    this.#failing = null;
  }
}

/**
 * Orion with the database rule in front of every write: the dropped
 * signatures of this connector are persisted BEFORE an upsert goes out, and a
 * gated upsert (one that carries pending signatures) is NOT sent when that
 * fails or the state is not loaded — the result reports every chunk as
 * unconfirmed and the pending signatures as dropped, so the connector sees a
 * failed write and the next run sends again. Reads and deletes pass through
 * (a prune persists its own drops first, see {@link PruneStore.forgetAhead}).
 */
class GuardedOrion implements Orion {
  readonly #inner: Orion;
  readonly #gate: ChangeGate;
  readonly #store: ConnectorPersistence;
  readonly #log: Log;

  constructor(inner: Orion, gate: ChangeGate, store: ConnectorPersistence, log: Log) {
    this.#inner = inner;
    this.#gate = gate;
    this.#store = store;
    this.#log = log;
  }

  async upsert(plan: UpsertPlan, options?: UpsertOptions): Promise<UpsertResult> {
    if (plan.entities.length === 0) return this.#inner.upsert(plan, options);
    const gated = plan.pending.length > 0;
    if (gated && !this.#store.usable()) return this.#refuse(plan, options, this.#store.reason());
    const written = await this.#store.flush();
    if (!written && (gated || this.#store.hasUnwrittenDrops())) {
      return this.#refuse(plan, options, "dropped signatures could not be persisted");
    }
    const result = await this.#inner.upsert(plan, options);
    // The commits of the last chunks; a failure is already warned and retried.
    await this.#store.flush();
    return result;
  }

  async upsertChanged<T extends NgsiEntity>(
    key: string,
    entities: readonly T[],
    sigOf: (entity: T) => SignatureValue,
    options?: ChangeGateOptions & UpsertOptions,
  ): Promise<UpsertResult> {
    return this.upsert(this.#gate.check(key, entities, sigOf, options), options);
  }

  delete(ids: readonly EntityId[], options?: DeleteOptions): Promise<DeleteResult> {
    return this.#inner.delete(ids, options);
  }

  find(query: OrionQuery, options?: OrionReadOptions): Promise<JsonResponse> {
    return this.#inner.find(query, options);
  }

  list(query: OrionQuery, options: ListOptions): Promise<ListResult> {
    return this.#inner.list(query, options);
  }

  count(query: OrionQuery): Promise<number | null> {
    return this.#inner.count(query);
  }

  #refuse(plan: UpsertPlan, options: UpsertOptions | undefined, reason: string): UpsertResult {
    const chunks = chunk(plan.entities, sizeOr(options?.chunkSize, DEFAULT_CHUNK_SIZE)).length;
    this.#log.warn(
      `Upsert not sent, state store not usable (${reason}): ${String(plan.pending.length)} change ` +
        "signatures dropped, entities will be sent again",
    );
    return {
      entities: plan.entities.length,
      chunks,
      failedChunks: chunks,
      confirmed: new Set(),
      committed: 0,
      dropped: plan.pending.length,
    };
  }
}
