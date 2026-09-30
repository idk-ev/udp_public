/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Change detection over value signatures, two-phase — port of `gateChanged`,
 * `sigPending`, `freshTurn` (CHUNK_HELPER) and SIG_COMMIT in
 * the former Node-RED flow generator (see git history).
 *
 * Why it exists, in the words of the original:
 *
 *   > Nur Entitäten mit geänderter Wertsignatur behalten. Orion-LD schreibt bei
 *   > options=update je Attribut eine TRoE-Zeile — unabhängig davon, ob sich der
 *   > Wert geändert hat. Ein über Stunden konstanter Pegel/Warnstatus/Median
 *   > erzeugt so unnötig Volumen. sigOf(e) muss die Messwerte hashen, NICHT den
 *   > dateObserved-Zeitstempel.
 *
 * An unchanged entity is not dropped: it is reduced to `{ id, type,
 * dateObserved, @context }`. With `options=update` Orion replaces only the
 * attributes actually sent, so the value rows are saved while the health check
 * and the frontend still see that the data is current. An entity that is
 * unchanged AND carries no `dateObserved` falls out entirely — there would be
 * nothing left to send.
 *
 * ## Commit only after a confirmed upsert
 *
 * A signature says "this value is in the broker". It may only take effect once
 * the broker confirmed the write. The first version stored it BEFORE the
 * upsert, and that froze entities for weeks whenever Orion-LD hung: the write
 * was lost, the next run found an unchanged signature and sent a freshness
 * stamp at most — the dashboards showed a current `dateObserved` on a value
 * from weeks ago. So:
 *
 *  1. {@link MemoryChangeGate.check} removes the OLD signature of a changed
 *     entity right away and returns the new one as PENDING, riding on the plan.
 *  2. {@link SignatureScope.commit} — called by `Orion.upsert` per chunk, never
 *     by a connector — stores the pending signatures of the ids the broker
 *     confirmed and drops the rest. A dropped signature leaves its entity
 *     "changed", and the next run sends it again.
 *
 * ## merge vs. replace
 *
 * The default is MERGING, and the reason is worth reading twice:
 *
 *   > Flows wie das GBFS-Carsharing rufen die Erkennung einmal je System auf und
 *   > tragen jeweils nur einen Teilbestand bei; ein Ersetzen würde die Tabelle
 *   > bei jedem System auf dessen Stationen eindampfen und die Erkennung
 *   > wirkungslos machen. Für Flows, die den GANZEN Bestand in einem Lauf sehen
 *   > (Parken landesweit), ist Mergen dagegen ein Leck: Entitäten, die aus der
 *   > Quelle verschwinden, bleiben für immer in der Signaturtabelle stehen.
 *
 * So: `replace: true` if and only if the connector sees the whole stock in one
 * call. Choosing wrongly either disables the gate (replace on a partial run) or
 * leaks memory forever (merge on a full run). `ladesaeulen-bw` switches per run
 * (`replace: complete`), so an incomplete run keeps the signatures of stations
 * on a missing page.
 *
 * ## Persisted, write-through
 *
 * The tables are kept in memory for the gate and persisted per connector in
 * PostgreSQL (src/kernel/persistence.ts), so a restart does not turn every
 * gated entity into "changed" — under Compose the old runtime kept them on a
 * volume, and losing them rewrote ~400k TRoE rows per restart. Every change
 * of a table is reported to the persistence ({@link SignatureObserver}):
 * dropped signatures are persisted BEFORE the upsert that makes them matter
 * goes out, committed ones after the broker confirmed them. The rule above
 * therefore also holds for the database: it never stores a signature the
 * broker did not confirm. While the persisted tables are not loaded the gate
 * refuses to work (`StateUnavailableError`) — a gate on empty tables
 * is the full rewrite the persistence exists to prevent.
 */

import type {
  ChangeGate,
  ChangeGateOptions,
  EntityId,
  Log,
  NgsiEntity,
  PendingSignature,
  SignatureValue,
  UpsertPlan,
} from "./types.js";

/** Default of `opts.periodMs` in CHUNK_HELPER. */
export const DEFAULT_FRESH_PERIOD_MS = 3_600_000;

/** A non-first run with more than this share changed warns (see `MemoryChangeGate#report`). */
export const CHANGED_SHARE_WARNING = 0.5;
/** Below this many entities a share says nothing. */
export const MIN_ENTITIES_FOR_WARNING = 20;

/**
 * Stable per-entity rotation for freshness-only writes: with `every = k`, an
 * unchanged entity refreshes its `dateObserved` in one of k consecutive runs
 * (runs `periodMs` apart), spreading the rows evenly over the runs.
 *
 * Exported for tests. (`carsharing-bw` also called it directly, for the
 * one-off migration of its former `csStand` table; that path has nothing to
 * migrate in this service, whose tables never held that table.)
 */
export function freshTurn(id: string, every: number, periodMs: number, nowMs: number): boolean {
  if (!(every > 1)) return true;
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h + Math.floor(nowMs / periodMs)) % every === 0;
}

export interface CommitResult {
  readonly committed: number;
  readonly dropped: number;
}

const NAMESPACE_SEPARATOR = "\u0000";

/**
 * The persistence behind one connector's tables (kernel-internal; implemented
 * in src/kernel/persistence.ts). Without one a scope is memory only — the
 * parity harness and most unit tests run that way.
 */
export interface SignatureObserver {
  /** Throws `StateUnavailableError` while the persisted tables are not loaded. */
  assertLoaded(): void;
  /** These fields of table `key` changed in memory: set, overwritten or removed. */
  changed(key: string, fields: Iterable<string>): void;
}

/**
 * The signature tables — the part of the Node-RED flow context the connectors
 * kept them in. Shared by the whole service, but every connector only ever
 * sees its own namespace ({@link scope}): two connectors cannot collide on a
 * key, and a prune's `signatureKey` cannot reach another connector's table.
 */
export class SignatureStore {
  readonly #tables = new Map<string, Map<string, SignatureValue>>();
  readonly #observers = new Map<string, SignatureObserver>();

  scope(owner: string): SignatureScope {
    return new SignatureScope(this.#tables, owner, () => this.#observers.get(owner));
  }

  /** Kernel-internal: reports every change of `owner`'s tables to `observer`. */
  observe(owner: string, observer: SignatureObserver): void {
    this.#observers.set(owner, observer);
  }
}

/** One connector's view of the {@link SignatureStore}. Kernel-internal. */
export class SignatureScope {
  readonly #tables: Map<string, Map<string, SignatureValue>>;
  readonly #prefix: string;
  readonly #observer: () => SignatureObserver | undefined;

  constructor(
    tables: Map<string, Map<string, SignatureValue>>,
    owner: string,
    observer: () => SignatureObserver | undefined = () => undefined,
  ) {
    this.#tables = tables;
    this.#prefix = `${owner}${NAMESPACE_SEPARATOR}`;
    this.#observer = observer;
  }

  /** Throws `StateUnavailableError` while the persisted tables are not loaded. */
  assertLoaded(): void {
    this.#observer()?.assertLoaded();
  }

  /** Reports changed fields to the persistence; the gate calls it for what it changes on a live table. */
  changed(key: string, fields: Iterable<string>): void {
    this.#observer()?.changed(key, fields);
  }

  /** The live table, created on demand. Connectors only ever get copies. */
  live(key: string): Map<string, SignatureValue> {
    const name = this.#prefix + key;
    let table = this.#tables.get(name);
    if (table === undefined) {
      table = new Map();
      this.#tables.set(name, table);
    }
    return table;
  }

  copy(key: string): Map<string, SignatureValue> {
    return new Map(this.#tables.get(this.#prefix + key));
  }

  /** Entries of a table; 0 when it does not exist. */
  size(key: string): number {
    return this.#tables.get(this.#prefix + key)?.size ?? 0;
  }

  /**
   * Fills an EMPTY table with signatures derived from what the broker holds
   * (`Orion.seedSignatures`, the only caller). A table that holds anything
   * is left alone. Reported as a change, so the store gets them too.
   */
  seed(key: string, table: ReadonlyMap<string, SignatureValue>): number {
    if (this.size(key) > 0 || table.size === 0) return 0;
    this.#tables.set(this.#prefix + key, new Map(table));
    this.changed(key, table.keys());
    return table.size;
  }

  /** The stored value of one field, for the persistence. */
  valueOf(key: string, field: string): SignatureValue | undefined {
    return this.#tables.get(this.#prefix + key)?.get(field);
  }

  /** Replaces a table wholesale — replace mode of the gate, and test setup. */
  replace(key: string, table: ReadonlyMap<string, SignatureValue>): void {
    const name = this.#prefix + key;
    const previous = this.#tables.get(name);
    const touched = new Set<string>();
    if (previous !== undefined) {
      for (const [field, value] of previous) if (table.get(field) !== value) touched.add(field);
    }
    for (const [field, value] of table) if (previous?.get(field) !== value) touched.add(field);
    this.#tables.set(name, new Map(table));
    if (touched.size > 0) this.changed(key, touched);
  }

  /** Keeps the entries `keep` accepts; drops a table left empty. */
  retain(key: string, keep: (field: string, value: SignatureValue) => boolean): void {
    const name = this.#prefix + key;
    const table = this.#tables.get(name);
    if (table === undefined) return;
    const removed: string[] = [];
    for (const [field, value] of [...table]) {
      if (keep(field, value)) continue;
      table.delete(field);
      removed.push(field);
    }
    if (table.size === 0) this.#tables.delete(name);
    if (removed.length > 0) this.changed(key, removed);
  }

  keys(): readonly string[] {
    return [...this.#tables.keys()]
      .filter((name) => name.startsWith(this.#prefix))
      .map((name) => name.slice(this.#prefix.length));
  }

  /** Removes fields from a table — the prune forgetting deleted entities (`sigKey`). */
  forget(key: string, fields: Iterable<string>): void {
    const table = this.#tables.get(this.#prefix + key);
    if (table === undefined) return;
    const removed: string[] = [];
    for (const field of fields) if (table.delete(field)) removed.push(field);
    if (removed.length > 0) this.changed(key, removed);
  }

  /**
   * Replaces ALL of this connector's tables with what the state store holds —
   * the load before the first run, and the reload after the writer lock was
   * lost. Not reported as a change: it is what the store already has.
   */
  load(tables: ReadonlyMap<string, ReadonlyMap<string, SignatureValue>>): void {
    for (const key of this.keys()) this.#tables.delete(this.#prefix + key);
    for (const [key, table] of tables) this.#tables.set(this.#prefix + key, new Map(table));
  }

  /**
   * After another writer may have held the lock: keeps only the signatures
   * on which memory and `stored` agree and removes every other one from
   * memory. Returns, per table, every field that differed (in memory, in the
   * store, or both) — the store must lose them too. Not reported as a change;
   * the persistence marks what it returns.
   */
  reconcile(stored: ReadonlyMap<string, ReadonlyMap<string, SignatureValue>>): Map<string, Set<string>> {
    const differing = new Map<string, Set<string>>();
    const mark = (key: string, field: string): void => {
      let fields = differing.get(key);
      if (fields === undefined) {
        fields = new Set();
        differing.set(key, fields);
      }
      fields.add(field);
    };
    for (const key of new Set([...this.keys(), ...stored.keys()])) {
      const table = this.#tables.get(this.#prefix + key);
      const other = stored.get(key);
      for (const [field, value] of table ?? []) {
        if (other?.get(field) !== value) mark(key, field);
      }
      for (const [field, value] of other ?? []) {
        if (table?.get(field) !== value) mark(key, field);
      }
      if (table === undefined) continue;
      for (const field of differing.get(key) ?? []) table.delete(field);
      if (table.size === 0) this.#tables.delete(this.#prefix + key);
    }
    return differing;
  }

  /**
   * SIG_COMMIT: stores the pending signatures whose entity is in `confirmed`,
   * drops the others. `value === null` removes the field.
   */
  commit(pending: readonly PendingSignature[], confirmed: ReadonlySet<EntityId>): CommitResult {
    let committed = 0;
    let dropped = 0;
    const touched = new Map<string, string[]>();
    for (const [key, field, value, entityId] of pending) {
      if (!confirmed.has(entityId)) {
        dropped += 1;
        continue;
      }
      const table = this.live(key);
      if (value === null) table.delete(field);
      else table.set(field, value);
      committed += 1;
      const fields = touched.get(key);
      if (fields === undefined) touched.set(key, [field]);
      else fields.push(field);
    }
    // Write-through, batched per chunk: Orion.upsert commits once per chunk.
    for (const [key, fields] of touched) this.changed(key, fields);
    return { committed, dropped };
  }
}

/** A plan without signatures — see `ChangeGate.ungated`. */
export function ungated(entities: readonly NgsiEntity[]): UpsertPlan {
  return { entities, pending: [] };
}

/** Combines plans into one write — e.g. site entities plus gated sums in `parken-bw`. */
export function mergePlans(...plans: readonly UpsertPlan[]): UpsertPlan {
  return {
    entities: plans.flatMap((plan) => plan.entities),
    pending: plans.flatMap((plan) => plan.pending),
  };
}

class MemoryChangeGate implements ChangeGate {
  readonly #store: SignatureScope;
  readonly #log: Log;
  readonly #nowMs: () => number;

  constructor(store: SignatureScope, log: Log, nowMs: () => number) {
    this.#store = store;
    this.#log = log;
    this.#nowMs = nowMs;
  }

  check<T extends NgsiEntity>(
    key: string,
    entities: readonly T[],
    sigOf: (entity: T) => SignatureValue,
    options?: ChangeGateOptions,
  ): UpsertPlan {
    this.#store.assertLoaded();
    const replace = options?.replace ?? false;
    const every = options?.freshEvery ?? 1;
    const period = options?.periodMs ?? DEFAULT_FRESH_PERIOD_MS;
    const nowMs = this.#nowMs();
    const previous = this.#store.live(key);
    // Merge works on the stored table itself, replace on a fresh one — exactly
    // `const table = ersetzen ? {} : prev` of the original.
    const table = replace ? new Map<string, SignatureValue>() : previous;
    const out: NgsiEntity[] = [];
    const pending: PendingSignature[] = [];
    const dropped: string[] = [];
    // Not a first run, nor a new kind of entity in an old table (see #report).
    const known = previous.size > 0 && previous.size * 2 >= entities.length;
    let changed = 0;
    let missing = 0;

    for (const entity of entities) {
      const signature = sigOf(entity);
      const stored = previous.get(entity.id);
      if (stored !== signature) {
        if (stored === undefined) missing += 1;
        if (table.delete(entity.id)) dropped.push(entity.id);
        pending.push([key, entity.id, signature, entity.id]);
        out.push(entity);
        changed += 1;
        continue;
      }
      table.set(entity.id, signature);
      const dateObserved = entity.dateObserved;
      if (dateObserved !== undefined && freshTurn(entity.id, every, period, nowMs)) {
        // Freshness only: id, type, dateObserved, context. Nothing else, or the
        // saved TRoE rows come straight back.
        out.push({
          id: entity.id,
          type: entity.type,
          dateObserved,
          "@context": entity["@context"],
        });
      }
    }

    // Replace mode reports its own difference; merge mode only ever drops.
    if (replace) this.#store.replace(key, table);
    else if (dropped.length > 0) this.#store.changed(key, dropped);
    this.#log.status(`${String(changed)}/${String(entities.length)} changed (rest: freshness only)`);
    this.#report(key, entities.length, changed, missing, known, options?.volatile === true);
    return { entities: out, pending };
  }

  /**
   * One info line per gated write, and a `[warn]` when a run that HAD
   * signatures (`known`: for at least half as many entities as it writes —
   * a first run or a new kind of entity in an old table is no alarm) finds
   * most entities changed: the signature of lost change state, a full
   * rewrite of everything. For a volatile source only the entities without
   * any stored signature count.
   */
  #report(
    key: string,
    total: number,
    changed: number,
    missing: number,
    known: boolean,
    volatile: boolean,
  ): void {
    if (total === 0) return;
    this.#log.info(
      `gate ${key}: ${String(changed)}/${String(total)} changed` +
        (missing > 0 ? ` (${String(missing)} without a stored signature)` : ""),
    );
    if (!known || total < MIN_ENTITIES_FOR_WARNING) return;
    const suspicious = volatile ? missing : changed;
    if (suspicious / total <= CHANGED_SHARE_WARNING) return;
    this.#log.warn(
      `gate ${key}: ${String(changed)} of ${String(total)} entities changed (${String(missing)} without a ` +
        "stored signature) although signatures were stored — change state lost?",
    );
  }

  table(key: string): Map<string, SignatureValue> {
    this.#store.assertLoaded();
    return this.#store.copy(key);
  }

  ungated(entities: readonly NgsiEntity[]): UpsertPlan {
    return ungated(entities);
  }

  retain(key: string, keep: (field: string, value: SignatureValue) => boolean): void {
    this.#store.assertLoaded();
    this.#store.retain(key, keep);
  }

  keys(): readonly string[] {
    this.#store.assertLoaded();
    return this.#store.keys();
  }
}

/**
 * @param nowMs Clock for `freshEvery`. Injected so a test can pin the rotation;
 *              the service passes `Date.now`.
 */
export function createChangeGate(
  store: SignatureScope,
  log: Log,
  nowMs: () => number = Date.now,
): ChangeGate {
  return new MemoryChangeGate(store, log, nowMs);
}
