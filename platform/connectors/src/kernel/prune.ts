/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Automatic removal of stale own entities — port of PRUNE_HELPER
 * (`pruneStale`) and PRUNE_OK_JS in the former Node-RED flow generator (see git history).
 *
 * The connectors only upsert. An entity a run no longer produces — the object
 * left the source, or it was wrongly assigned to a border municipality before
 * the strict lookup — would stay in the broker forever. `stale()` lists the
 * connector's entities by type plus an anchored id pattern that only this
 * connector writes, pages through them completely and deletes the ids that are
 * no longer confirmed.
 *
 * Deleting live data is the one thing a connector can do that the next run
 * does not repair, so the guards are many and each of them is load-bearing:
 *
 *  * master data plausible (PRUNE_OK): ≥ 1,000 municipalities, ≥ 95 % of the
 *    last plausible count, boundaries for ≥ 99 % of their AGS. A truncated
 *    municipality file would otherwise make everything beyond the cut look
 *    "no longer produced";
 *  * call site: only after a COMPLETE, successful source run with a non-empty
 *    result (the connector's job — it knows what "complete" means);
 *  * interval: the previous run of this prune lies at most 2.5 intervals back,
 *    so a first run after an outage or a restart never acts on a single
 *    snapshot;
 *  * listing complete: every page read and the count matches
 *    `NGSILD-Results-Count` — a partial listing is not a picture of the stock;
 *  * own ids only: the pattern is checked again on every listed id, plus the
 *    optional `exclude` / `accept`;
 *  * `keep`: ids produced by this run are never deleted;
 *  * `graceMs`: only entities whose newest timestamp is older than the grace
 *    period; no timestamp = keep;
 *  * `confirmKey` + `confirmMs`: for sources without refreshed timestamps, a
 *    candidate in at least two consecutive runs AND for 24 h; any skipped run
 *    clears the candidates;
 *  * `liveMs`: age-only mode must see at least one recent write, otherwise the
 *    connector itself is down and "old" means nothing;
 *  * `maxFraction`: never more than 30 % of the own stock (at least 3) —
 *    beyond that something upstream is wrong and a human should look;
 *  * only ids the broker CONFIRMS as deleted (204, or the success part of a
 *    207) count and lose their change signature. TRoE history is untouched.
 *
 * ## State is persisted
 *
 * The interval bookkeeping, the confirmation tables and the last plausible
 * municipality count ({@link PruneBookkeeping}) are kept per connector and
 * persisted in PostgreSQL with the change signatures (src/kernel/persistence.ts),
 * so the first prune after a restart behaves like the one before it: the
 * interval check sees the previous run, a candidate keeps its consecutive
 * runs. (Lost, both would only delay pruning; the municipality count would
 * make the check MORE permissive — which is why a count that was never
 * persisted is still seeded from Orion, see `MasterDataCheck` in
 * src/kernel/geo.ts.)
 *
 * While the connector's persisted state is not loaded the prune is SKIPPED
 * with a `[warn]` and touches no bookkeeping: an empty interval table would
 * skip anyway, but empty confirmation tables and a missing reference are not
 * something to delete live data on. Before a delete goes out, the signatures
 * of its candidates are removed from the persisted table
 * ({@link PruneStore.forgetAhead}); if that cannot be written, the delete is
 * not sent. A signature that outlived its entity in the database would, after
 * a restart, turn the entity's return into a freshness-only write.
 */

import type { SignatureScope } from "./change-gate.js";
import { MasterDataCheck } from "./geo.js";
import type { SharedGeo } from "./geo.js";
import { isArray, isEntityId, isRecord, isString, isTruthy } from "./parse.js";
import type { EntityId, JsonValue, Log, Orion, PruneOptions, PruneResult, Pruner } from "./types.js";

/** PRUNE_HELPER lists and deletes in pages of these sizes. */
const LIST_MAX_PAGES = 100;
const DELETE_CHUNK_SIZE = 100;

const DEFAULT_MAX_FRACTION = 0.3;

/**
 * The entities `stammdaten-bw` writes — their number seeds the reference of
 * the 95 % ratchet after a start.
 */
const MUNICIPALITY_QUERY = {
  type: "Municipality",
  idPattern: "^urn:ngsi-ld:Municipality:bw-[0-9]{8}$",
} as const;

/** `^…$`, not escaped: the prune only ever touches ids its whole pattern describes. */
function isAnchored(pattern: string): boolean {
  return pattern.startsWith("^") && pattern.endsWith("$") && !pattern.endsWith("\\$");
}

/** `(0, 1]`; anything else is the default. */
function fractionOf(value: number | undefined): number {
  if (value === undefined || !(value > 0)) return DEFAULT_MAX_FRACTION;
  return Math.min(value, 1);
}
const DEFAULT_CONFIRM_MS = 24 * 3_600_000;

/** `[first seen as candidate (ms), consecutive runs]` — the value of a confirmation table. */
type Confirmation = readonly [firstSeenMs: number, runs: number];

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `[[id, firstSeenMs, runs], …]` as persisted; `null` if anything is off. */
function confirmationTableOf(raw: unknown): Map<string, Confirmation> | null {
  if (!isArray(raw)) return null;
  const table = new Map<string, Confirmation>();
  for (const row of raw) {
    if (!isArray(row) || row.length !== 3) return null;
    const [id, first, runs] = row;
    const firstSeen = finite(first);
    const count = finite(runs);
    if (typeof id !== "string" || firstSeen === null || count === null) return null;
    table.set(id, [firstSeen, count]);
  }
  return table;
}

/**
 * The state of one connector's prunes: `pruneLastRun_<label>` and the
 * `confirmKey` tables of the old flow context, plus the master data
 * reference. One per connector id; persisted as one document
 * (src/kernel/persistence.ts), so every change is reported via
 * {@link onChange}.
 */
export class PruneBookkeeping {
  readonly masterData: MasterDataCheck;
  /** Keyed by label, type and pattern. */
  readonly #lastRun = new Map<string, number>();
  readonly #confirmations = new Map<string, Map<string, Confirmation>>();
  #onChange: () => void = () => undefined;

  constructor(masterData: MasterDataCheck = new MasterDataCheck()) {
    this.masterData = masterData;
    masterData.onChange(() => {
      this.#onChange();
    });
  }

  onChange(listener: () => void): void {
    this.#onChange = listener;
  }

  lastRun(key: string): number | undefined {
    return this.#lastRun.get(key);
  }

  setLastRun(key: string, ms: number): void {
    this.#lastRun.set(key, ms);
    this.#onChange();
  }

  confirmations(key: string): ReadonlyMap<string, Confirmation> | undefined {
    return this.#confirmations.get(key);
  }

  setConfirmations(key: string, table: Map<string, Confirmation>): void {
    this.#confirmations.set(key, table);
    this.#onChange();
  }

  /** The ids the broker confirmed as deleted leave the confirmation table. */
  forgetConfirmed(key: string, ids: readonly string[]): void {
    const table = this.#confirmations.get(key);
    if (table === undefined || ids.length === 0) return;
    for (const id of ids) table.delete(id);
    this.#onChange();
  }

  snapshot(): JsonValue {
    return {
      lastRun: [...this.#lastRun].map(([key, ms]) => [key, ms]),
      confirmations: [...this.#confirmations].map(([key, table]) => [
        key,
        [...table].map(([id, [first, runs]]) => [id, first, runs]),
      ]),
      masterDataCount: this.masterData.snapshot(),
    };
  }

  /**
   * Replaces everything with a persisted document (external data, hence
   * `unknown`). `null` = nothing persisted: all empty, the reference unset.
   * A document that does not narrow is dropped as a whole and reported as
   * `false` — empty bookkeeping only ever delays a prune.
   */
  restore(raw: unknown): boolean {
    this.#lastRun.clear();
    this.#confirmations.clear();
    this.masterData.restore(null);
    if (raw === null) return true;
    if (!isRecord(raw) || !isArray(raw.lastRun) || !isArray(raw.confirmations)) return false;
    const lastRun = new Map<string, number>();
    for (const row of raw.lastRun) {
      if (!isArray(row) || row.length !== 2) return false;
      const [key, ms] = row;
      const at = finite(ms);
      if (typeof key !== "string" || at === null) return false;
      lastRun.set(key, at);
    }
    const confirmations = new Map<string, Map<string, Confirmation>>();
    for (const row of raw.confirmations) {
      if (!isArray(row) || row.length !== 2) return false;
      const [key, rows] = row;
      const table = confirmationTableOf(rows);
      if (typeof key !== "string" || table === null) return false;
      confirmations.set(key, table);
    }
    const count = raw.masterDataCount;
    const reference = finite(count);
    if (count !== null && reference === null) return false;
    for (const [key, ms] of lastRun) this.#lastRun.set(key, ms);
    for (const [key, table] of confirmations) this.#confirmations.set(key, table);
    this.masterData.restore(reference);
    return true;
  }
}

/**
 * What the persistence offers the pruner (kernel-internal, implemented in
 * src/kernel/persistence.ts). Without one the bookkeeping is memory only.
 */
export interface PruneStore {
  /** The connector's persisted state is loaded and writable. */
  usable(): boolean;
  /** Why not, for the skip line. */
  reason(): string;
  /**
   * Removes the persisted signatures of `fields` in table `key` BEFORE their
   * entities are deleted; the in-memory table is left alone. `false` = not
   * written, and the delete must not go out.
   */
  forgetAhead(key: string, fields: readonly string[]): Promise<boolean>;
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `tsOf` of PRUNE_HELPER: the newest of `modifiedAt` (entity and attributes,
 * via `options=sysAttrs`), `observedAt`, and the value of `dateObserved`
 * (plain or as `{ "@value" }`). 0 if none parses.
 */
export function newestTimestamp(entity: Readonly<Record<string, unknown>>): number {
  let newest = 0;
  const see = (value: unknown): void => {
    // Date.parse(undefined) and friends are NaN in the original; only strings
    // can parse, so the narrowing loses nothing.
    if (!isString(value)) return;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > newest) newest = parsed;
  };
  if (isTruthy(entity.modifiedAt)) see(entity.modifiedAt);
  for (const key of Object.keys(entity)) {
    const attribute = entity[key];
    if (!isRecord(attribute)) continue;
    if (isTruthy(attribute.observedAt)) see(attribute.observedAt);
    if (isTruthy(attribute.modifiedAt)) see(attribute.modifiedAt);
    if (key === "dateObserved") {
      const value = attribute.value;
      see(isRecord(value) ? value["@value"] : value);
    }
  }
  return newest;
}

export interface PrunerDeps {
  readonly log: Log;
  readonly orion: Orion;
  readonly signatures: SignatureScope;
  readonly geo: SharedGeo;
  readonly masterData: MasterDataCheck;
  /** Default of `PruneOptions.intervalMs`: the connector's registry interval. */
  readonly defaultIntervalMs: number;
  readonly nowMs: () => number;
  /**
   * The connector's bookkeeping, shared by every ctx of it; must hold
   * `masterData`. Default: a fresh one around `masterData`, memory only.
   */
  readonly bookkeeping?: PruneBookkeeping | undefined;
  /** The persistence; without it nothing is persisted and the pruner is always usable. */
  readonly store?: PruneStore | undefined;
}

class KernelPruner implements Pruner {
  readonly #deps: PrunerDeps;
  readonly #book: PruneBookkeeping;

  constructor(deps: PrunerDeps) {
    this.#deps = deps;
    this.#book = deps.bookkeeping ?? new PruneBookkeeping(deps.masterData);
  }

  async masterDataPlausible(): Promise<boolean> {
    const { masterData, geo, orion, log, store } = this.#deps;
    if (store !== undefined && !store.usable()) return false;
    if (!masterData.seeded) {
      const count = await orion.count(MUNICIPALITY_QUERY);
      if (count === null) {
        log.debug("prune: municipality count not readable from Orion — no prune until it is");
        return false;
      }
      masterData.seed(count);
    }
    return masterData.evaluate(geo.municipalities, geo.boundaries, geo.boundariesDegraded);
  }

  resetConfirmations(confirmKey: string): void {
    this.#book.setConfirmations(confirmKey, new Map());
  }

  async stale(options: PruneOptions): Promise<PruneResult> {
    const store = this.#deps.store;
    if (store !== undefined && !store.usable()) {
      // Nothing else happens: no bookkeeping, no confirmation reset — the
      // reload replaces the bookkeeping anyway.
      const why = `state store not loaded (${store.reason()})`;
      this.#deps.log.warn(`${options.label}: prune skipped, ${why}`);
      return { deleted: 0, listed: null, skipped: why };
    }
    // Every old call site read `if (PRUNE_OK) pruneStale(…)`. Checking here as
    // well makes the guard impossible to forget. Without it the old code did
    // not call the prune at all — and the call sites with a confirmation table
    // cleared it in their else branch, which happens here too.
    if (!(await this.masterDataPlausible())) {
      if (options.confirmKey !== undefined) this.resetConfirmations(options.confirmKey);
      this.#deps.log.debug(`${options.label}: prune not attempted, master data not plausible`);
      return { deleted: 0, listed: null, skipped: "master data not plausible" };
    }
    try {
      return await this.#run(options);
    } catch (error) {
      // `.catch(e => node.warn(label + ': prune failed (…)'))` at every call site.
      this.#deps.log.warn(`${options.label}: prune failed (${describeFailure(error)})`);
      return { deleted: 0, listed: null, skipped: `failed (${describeFailure(error)})` };
    }
  }

  async #run(o: PruneOptions): Promise<PruneResult> {
    const { log, orion, signatures } = this.#deps;
    const now = this.#deps.nowMs();
    const pattern = new RegExp(o.pattern);
    const exclude = o.exclude === undefined ? null : new RegExp(o.exclude);
    const fraction = fractionOf(o.maxFraction);
    let listed: PruneResult["listed"] = null;

    const skip = (why: string, quiet = false): PruneResult => {
      // "consecutive" means consecutive
      if (o.confirmKey !== undefined) this.resetConfirmations(o.confirmKey);
      if (quiet) log.info(`${o.label}: prune skipped, ${why}`);
      else log.warn(`${o.label}: prune skipped, ${why}`);
      return { deleted: 0, listed, skipped: why };
    };

    // Stricter than the old code, which would have run a prune with an
    // unanchored pattern: `bw-svz-1` also matches `bw-svz-10` and every id that
    // merely contains it. No ported caller passes one.
    if (!isAnchored(o.pattern)) return skip(`pattern ${o.pattern} is not anchored (^…$)`);

    // The guard cannot be switched off: the old `if (o.intervalMs)` skipped it
    // for 0, and every old caller passed a real interval, so a missing or
    // unusable value means the registry interval here.
    const intervalMs =
      o.intervalMs !== undefined && o.intervalMs > 0 ? o.intervalMs : this.#deps.defaultIntervalMs;
    const intervalKey = `${o.label}|${o.type}|${o.pattern}`;
    const previousRun = this.#book.lastRun(intervalKey);
    this.#book.setLastRun(intervalKey, now);
    // Quiet on the very first run: after a start that is the normal case, not
    // a fault worth a [warn] in the health check.
    if (previousRun === undefined || now - previousRun > 2.5 * intervalMs) {
      return skip("no successful run within the last 2.5 intervals", previousRun === undefined);
    }

    // 1. List all own entities, completely
    const listing = await orion.list(
      {
        type: o.type,
        idPattern: o.pattern,
        attrs: o.attrs ?? ["ags"],
        options: "sysAttrs",
      },
      { maxPages: LIST_MAX_PAGES },
    );
    if (!listing.ok) return skip(`listing ${listing.reason}`);

    // 2. Candidates: own ids, not confirmed by this run, old enough
    let mine = 0;
    let newest = 0;
    let candidates: EntityId[] = [];
    for (const entity of listing.entities) {
      if (!isRecord(entity)) continue;
      const id = entity.id;
      // isEntityId narrows to the id type; every prune pattern is anchored at
      // `^urn:ngsi-ld:`, so it adds nothing the pattern does not already demand.
      if (!isEntityId(id) || !pattern.test(id)) continue; // never touch foreign ids
      if (exclude?.test(id) === true) continue; // excluded sub-scheme
      if (o.accept !== undefined && !o.accept(id, entity)) continue; // extra ownership check
      mine += 1;
      const timestamp = newestTimestamp(entity);
      if (timestamp > newest) newest = timestamp;
      if (o.keep?.has(id) === true) continue;
      if (o.graceMs !== undefined && o.graceMs > 0 && (timestamp === 0 || now - timestamp < o.graceMs))
        continue;
      candidates.push(id);
    }
    listed = { mine, candidates: candidates.length };

    if (o.liveMs !== undefined && o.liveMs > 0 && now - newest > o.liveMs) {
      return skip(
        `no entity written within the last ${String(Math.round(o.liveMs / 3_600_000))} h — connector down?`,
      );
    }
    const limit = Math.max(3, Math.floor(mine * fraction));
    if (candidates.length > limit) {
      return skip(
        `${String(candidates.length)} of ${String(mine)} entities would be deleted ` +
          `(limit ${String(limit)}) — please check manually`,
      );
    }

    if (o.confirmKey !== undefined) {
      const previous = this.#book.confirmations(o.confirmKey) ?? new Map<string, Confirmation>();
      const table = new Map<string, Confirmation>();
      for (const id of candidates) {
        const seen = previous.get(id) ?? [now, 0];
        table.set(id, [seen[0], seen[1] + 1]);
      }
      const confirmMs = o.confirmMs !== undefined && o.confirmMs > 0 ? o.confirmMs : DEFAULT_CONFIRM_MS;
      candidates = candidates.filter((id) => {
        const entry = table.get(id);
        return entry !== undefined && entry[1] >= 2 && now - entry[0] >= confirmMs;
      });
      this.#book.setConfirmations(o.confirmKey, table);
    }
    if (candidates.length === 0) return { deleted: 0, listed, skipped: null };

    // The persisted signatures of the candidates go first: once an entity is
    // deleted, a signature left in the database would make its return a
    // freshness-only write after a restart.
    const store = this.#deps.store;
    if (
      o.signatureKey !== undefined &&
      store !== undefined &&
      !(await store.forgetAhead(o.signatureKey, candidates))
    ) {
      return skip(`state store not writable (${store.reason()}), delete deferred`);
    }

    // 3. Delete in batches; count only what the broker confirms
    const result = await orion.delete(candidates, {
      chunkSize: DELETE_CHUNK_SIZE,
      label: `${o.label}: prune`,
    });
    const deleted = [...result.deleted];
    if (o.confirmKey !== undefined) this.#book.forgetConfirmed(o.confirmKey, deleted);
    // Forget the change signatures of deleted entities, so a returning object
    // is written in full again instead of as a freshness-only update.
    if (o.signatureKey !== undefined && deleted.length > 0) signatures.forget(o.signatureKey, deleted);

    log.info(`${o.label}: pruned ${String(deleted.length)} of ${String(mine)} entities`);
    log.status(
      `${o.status === undefined ? "" : `${o.status} · `}pruned ${String(deleted.length)}/${String(mine)}`,
    );
    return { deleted: deleted.length, listed, skipped: null };
  }
}

export function createPruner(deps: PrunerDeps): Pruner {
  return new KernelPruner(deps);
}
