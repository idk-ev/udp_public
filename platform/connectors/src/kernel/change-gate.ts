/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Change detection over value signatures, two-phase — port of `gateChanged`,
 * `sigPending`, `freshTurn` (CHUNK_HELPER) and SIG_COMMIT in
 * scripts/generate-nodered-flows.py.
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
 * ## Why in memory, for now
 *
 * The store lives in the process and is lost on restart. In Kubernetes that is
 * today's behaviour too: Node-RED runs without a volume on /data there. Under
 * Compose, however, the flow context was persisted (`contextStorage:
 * localfilesystem` in settings.js), so there the old runtime kept its tables
 * across restarts and this one does not. For the change gate the loss is the
 * safe direction: every entity counts as changed and is written in full once.
 * (For the prune it is not in every respect — see src/kernel/prune.ts for the
 * municipality count, which is therefore seeded from Orion.)
 *
 * Postgres would fix it, and the migration plan explicitly defers that until
 * parity is green:
 *
 *   > Erst *nach* grüner Parität umstellen — vorher verfälscht es genau die
 *   > Diffs, mit denen geprüft wird.
 *
 * A persistent store would mean the first run after a restart sees a populated
 * signature table where the old runtime (in Kubernetes) saw an empty one, and
 * the two sides would legitimately produce different entity arrays.
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

/**
 * Stable per-entity rotation for freshness-only writes: with `every = k`, an
 * unchanged entity refreshes its `dateObserved` in one of k consecutive runs
 * (runs `periodMs` apart), spreading the rows evenly over the runs.
 *
 * Exported for tests. (`carsharing-bw` also called it directly, for the
 * one-off migration of its former `csStand` table; that path has nothing to
 * migrate in this service, whose tables start empty.)
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
 * The signature tables — the part of the Node-RED flow context the connectors
 * kept them in. Shared by the whole service, but every connector only ever
 * sees its own namespace ({@link scope}): two connectors cannot collide on a
 * key, and a prune's `signatureKey` cannot reach another connector's table.
 */
export class SignatureStore {
  readonly #tables = new Map<string, Map<string, SignatureValue>>();

  scope(owner: string): SignatureScope {
    return new SignatureScope(this.#tables, owner);
  }
}

/** One connector's view of the {@link SignatureStore}. Kernel-internal. */
export class SignatureScope {
  readonly #tables: Map<string, Map<string, SignatureValue>>;
  readonly #prefix: string;

  constructor(tables: Map<string, Map<string, SignatureValue>>, owner: string) {
    this.#tables = tables;
    this.#prefix = `${owner}${NAMESPACE_SEPARATOR}`;
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

  /** Replaces a table wholesale — replace mode of the gate, and test setup. */
  replace(key: string, table: ReadonlyMap<string, SignatureValue>): void {
    this.#tables.set(this.#prefix + key, new Map(table));
  }

  /** Keeps the entries `keep` accepts; drops a table left empty. */
  retain(key: string, keep: (field: string, value: SignatureValue) => boolean): void {
    const name = this.#prefix + key;
    const table = this.#tables.get(name);
    if (table === undefined) return;
    for (const [field, value] of [...table]) if (!keep(field, value)) table.delete(field);
    if (table.size === 0) this.#tables.delete(name);
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
    for (const field of fields) table.delete(field);
  }

  /**
   * SIG_COMMIT: stores the pending signatures whose entity is in `confirmed`,
   * drops the others. `value === null` removes the field.
   */
  commit(pending: readonly PendingSignature[], confirmed: ReadonlySet<EntityId>): CommitResult {
    let committed = 0;
    let dropped = 0;
    for (const [key, field, value, entityId] of pending) {
      if (!confirmed.has(entityId)) {
        dropped += 1;
        continue;
      }
      const table = this.live(key);
      if (value === null) table.delete(field);
      else table.set(field, value);
      committed += 1;
    }
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
    let changed = 0;

    for (const entity of entities) {
      const signature = sigOf(entity);
      if (previous.get(entity.id) !== signature) {
        table.delete(entity.id);
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

    if (replace) this.#store.replace(key, table);
    this.#log.status(`${String(changed)}/${String(entities.length)} changed (rest: freshness only)`);
    return { entities: out, pending };
  }

  table(key: string): Map<string, SignatureValue> {
    return this.#store.copy(key);
  }

  ungated(entities: readonly NgsiEntity[]): UpsertPlan {
    return ungated(entities);
  }

  retain(key: string, keep: (field: string, value: SignatureValue) => boolean): void {
    this.#store.retain(key, keep);
  }

  keys(): readonly string[] {
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
