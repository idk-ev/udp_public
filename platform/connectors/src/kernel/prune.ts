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
 *  * `maxFraction`: never more RECENT candidates than 30 % of the fresh stock
 *    (at least 3) — beyond that something upstream is wrong and a human
 *    should look;
 *  * only ids the broker CONFIRMS as deleted (204, or the success part of a
 *    207) count and lose their change signature. TRoE history is untouched.
 *
 * ## Recent candidates and backlog
 *
 * The share cap used to count every candidate. A backlog that piled up
 * before a prune existed (tens of thousands of entities gone for months)
 * then blocked the prune for good: over the cap in every run, skipped in
 * every run, and growing. So the candidates are split by the age of their
 * newest timestamp:
 *
 *  * RECENT (younger than `backlogMs`, default 7 days): what went missing
 *    lately — this is where an upstream fault shows. The cap applies to
 *    these alone, measured against the FRESH stock (own entities that are no
 *    candidate). Over the cap: nothing at all is deleted, as before.
 *  * BACKLOG (older): untouched for a week while this connector kept running
 *    and writing (`liveMs`, the interval check) — gone for good. Deleted
 *    oldest first, at most `backlogBatch` (1,000) per run, and only when
 *    every guard above passed AND the fresh stock is at least 95 % of the
 *    previous run's (persisted per prune). An upstream outage shrinks the
 *    fresh stock first and stops the drain; its entities could reach the
 *    backlog only after a week without a single write while the connector
 *    runs, which is what "gone" means.
 *
 * A prune without a cap (`maxFraction: 1`, the parking legacy cleanup) has
 * nothing to be blocked by: no backlog, every candidate past the grace goes.
 *
 * A prune skipped by the cap counts its consecutive skips (persisted); from
 * the third on the skip is an `[error]`, and `/healthz` lists the prune under
 * `stateStore.blockedPrunes` — a prune that never runs must not stay quiet.
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
import type {
  EntityId,
  JsonValue,
  Log,
  Orion,
  PruneOptions,
  PruneResult,
  Pruner,
  RemoveOptions,
  RemoveResult,
} from "./types.js";

/** PRUNE_HELPER lists and deletes in pages of these sizes. */
const LIST_MAX_PAGES = 100;
const DELETE_CHUNK_SIZE = 100;

const DEFAULT_MAX_FRACTION = 0.3;
/** Candidates older than this are backlog, not recent. */
export const DEFAULT_BACKLOG_MS = 7 * 24 * 3_600_000;
/** Backlog deletions per run. */
export const DEFAULT_BACKLOG_BATCH = 1000;
/** The backlog is drained only while the fresh stock holds at least this share of the previous run's. */
export const BACKLOG_FRESH_RATIO = 0.95;
/** From this many consecutive cap skips on, the skip is an `[error]`. */
export const BLOCKED_AFTER = 3;

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
  /** Fresh stock (own entities that were no candidate) of the last run that passed the cap, per prune. */
  readonly #fresh = new Map<string, number>();
  /** Consecutive runs skipped by the share cap, per prune (only non-zero entries). */
  readonly #capSkips = new Map<string, number>();
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

  fresh(key: string): number | undefined {
    return this.#fresh.get(key);
  }

  setFresh(key: string, count: number): void {
    if (this.#fresh.get(key) === count) return;
    this.#fresh.set(key, count);
    this.#onChange();
  }

  capSkips(key: string): number {
    return this.#capSkips.get(key) ?? 0;
  }

  setCapSkips(key: string, runs: number): void {
    if (this.capSkips(key) === runs) return;
    if (runs > 0) this.#capSkips.set(key, runs);
    else this.#capSkips.delete(key);
    this.#onChange();
  }

  /** Prunes the share cap skipped in their last runs: `[key, consecutive skips]`. */
  blocked(): readonly (readonly [key: string, skips: number])[] {
    return [...this.#capSkips];
  }

  snapshot(): JsonValue {
    return {
      lastRun: [...this.#lastRun].map(([key, ms]) => [key, ms]),
      confirmations: [...this.#confirmations].map(([key, table]) => [
        key,
        [...table].map(([id, [first, runs]]) => [id, first, runs]),
      ]),
      masterDataCount: this.masterData.snapshot(),
      fresh: [...this.#fresh].map(([key, count]) => [key, count]),
      capSkips: [...this.#capSkips].map(([key, runs]) => [key, runs]),
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
    this.#fresh.clear();
    this.#capSkips.clear();
    this.masterData.restore(null);
    if (raw === null) return true;
    if (!isRecord(raw) || !isArray(raw.lastRun) || !isArray(raw.confirmations)) return false;
    const lastRun = numberPairs(raw.lastRun);
    // Absent in documents written before the backlog drain: empty, not unreadable.
    const fresh = raw.fresh === undefined ? new Map<string, number>() : numberPairs(raw.fresh);
    const capSkips = raw.capSkips === undefined ? new Map<string, number>() : numberPairs(raw.capSkips);
    if (lastRun === null || fresh === null || capSkips === null) return false;
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
    for (const [key, stock] of fresh) this.#fresh.set(key, stock);
    for (const [key, runs] of capSkips) if (runs > 0) this.#capSkips.set(key, runs);
    this.masterData.restore(reference);
    return true;
  }
}

/** `[[key, number], …]` as persisted; `null` if anything is off. */
function numberPairs(raw: unknown): Map<string, number> | null {
  if (!isArray(raw)) return null;
  const out = new Map<string, number>();
  for (const row of raw) {
    if (!isArray(row) || row.length !== 2) return null;
    const [key, value] = row;
    const number = finite(value);
    if (typeof key !== "string" || number === null) return null;
    out.set(key, number);
  }
  return out;
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
    const found: { readonly id: EntityId; readonly timestamp: number }[] = [];
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
      found.push({ id, timestamp });
    }
    listed = { mine, candidates: found.length };

    if (o.liveMs !== undefined && o.liveMs > 0 && now - newest > o.liveMs) {
      return skip(
        `no entity written within the last ${String(Math.round(o.liveMs / 3_600_000))} h — connector down?`,
      );
    }

    // Recent vs. backlog (module header). No timestamp: recent, never backlog.
    // A prune without a cap (maxFraction 1, the parking legacy cleanup) has
    // nothing to be blocked by and so no backlog: all of it counts as recent.
    const capped = fraction < 1;
    const backlogMs = o.backlogMs !== undefined && o.backlogMs > 0 ? o.backlogMs : DEFAULT_BACKLOG_MS;
    const isBacklog = (candidate: { readonly timestamp: number }): boolean =>
      capped && candidate.timestamp > 0 && now - candidate.timestamp >= backlogMs;
    const recent = found.filter((candidate) => !isBacklog(candidate));
    const backlog = found.filter(isBacklog);
    const fresh = mine - found.length;
    const limit = capped ? Math.max(3, Math.floor(fresh * fraction)) : Number.POSITIVE_INFINITY;
    if (recent.length > limit) {
      const skips = this.#book.capSkips(intervalKey) + 1;
      this.#book.setCapSkips(intervalKey, skips);
      const why =
        `${String(recent.length)} of ${String(mine)} entities would be deleted ` +
        `(limit ${String(limit)}) — please check manually` +
        (backlog.length > 0
          ? ` (${String(fresh)} fresh; a backlog of ${String(backlog.length)} older ones waits as well)`
          : "");
      if (skips >= BLOCKED_AFTER) {
        log.error(
          `${o.label}: prune blocked by its share cap for ${String(skips)} consecutive runs (${why}) — ` +
            "the stock is not cleaned up until someone looks",
        );
      }
      return skip(why);
    }
    this.#book.setCapSkips(intervalKey, 0);
    const previousFresh = this.#book.fresh(intervalKey);
    this.#book.setFresh(intervalKey, fresh);

    let candidates = found.map((candidate) => candidate.id);
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
    const confirmed = new Set(candidates);

    // Recent candidates in full; the backlog oldest first, bounded, and only
    // while the fresh stock holds against the previous run's.
    const drain = previousFresh !== undefined && fresh >= BACKLOG_FRESH_RATIO * previousFresh;
    const batch = o.backlogBatch !== undefined && o.backlogBatch > 0 ? o.backlogBatch : DEFAULT_BACKLOG_BATCH;
    const backlogIds = drain
      ? backlog
          .filter((candidate) => confirmed.has(candidate.id))
          .sort((a, b) => a.timestamp - b.timestamp)
          .slice(0, batch)
          .map((candidate) => candidate.id)
      : [];
    if (!drain && backlog.length > 0) {
      log.info(
        `${o.label}: backlog of ${String(backlog.length)} not drained in this run (fresh stock ` +
          `${String(fresh)}, previous ${previousFresh === undefined ? "unknown" : String(previousFresh)})`,
      );
    }
    const toDelete = [
      ...recent.filter((candidate) => confirmed.has(candidate.id)).map((candidate) => candidate.id),
      ...backlogIds,
    ];
    if (toDelete.length === 0) return { deleted: 0, listed, skipped: null };

    // The persisted signatures of the candidates go first: once an entity is
    // deleted, a signature left in the database would make its return a
    // freshness-only write after a restart.
    const store = this.#deps.store;
    const keys = signatureKeysOf(o.signatureKey, o.signatureKeys);
    if (store !== undefined) {
      for (const key of keys) {
        if (!(await store.forgetAhead(key, toDelete))) {
          return skip(`state store not writable (${store.reason()}), delete deferred`);
        }
      }
    }

    // 3. Delete in batches; count only what the broker confirms
    const result = await orion.delete(toDelete, {
      chunkSize: DELETE_CHUNK_SIZE,
      label: `${o.label}: prune`,
    });
    const deleted = [...result.deleted];
    if (o.confirmKey !== undefined) this.#book.forgetConfirmed(o.confirmKey, deleted);
    // Forget the change signatures of deleted entities, so a returning object
    // is written in full again instead of as a freshness-only update.
    if (deleted.length > 0) for (const key of keys) signatures.forget(key, deleted);
    const fromBacklog = backlogIds.filter((id) => result.deleted.has(id)).length;

    log.info(
      `${o.label}: pruned ${String(deleted.length)} of ${String(mine)} entities` +
        (backlogIds.length > 0
          ? ` (${String(fromBacklog)} from a backlog of ${String(backlog.length)})`
          : ""),
    );
    log.status(
      `${o.status === undefined ? "" : `${o.status} · `}pruned ${String(deleted.length)}/${String(mine)}`,
    );
    return { deleted: deleted.length, listed, skipped: null, backlogDeleted: fromBacklog };
  }

  async remove(o: RemoveOptions): Promise<RemoveResult> {
    const { log, orion, signatures, store } = this.#deps;
    const none = (why: string, quiet = false): RemoveResult => {
      if (quiet) log.debug(`${o.label}: not deleted, ${why}`);
      else log.warn(`${o.label}: not deleted, ${why}`);
      return { deleted: new Set(), skipped: why };
    };
    if (o.ids.length === 0) return { deleted: new Set(), skipped: null };
    if (store !== undefined && !store.usable()) return none(`state store not loaded (${store.reason()})`);
    if (!isAnchored(o.pattern)) return none(`pattern ${o.pattern} is not anchored (^…$)`);
    const pattern = new RegExp(o.pattern);
    const foreign = o.ids.find((id) => !pattern.test(id));
    if (foreign !== undefined) return none(`${foreign} does not match ${o.pattern}`);
    if (!(await this.masterDataPlausible())) return none("master data not plausible", true);
    const keys = o.signatureKeys ?? [];
    if (store !== undefined) {
      for (const key of keys) {
        if (!(await store.forgetAhead(key, o.ids))) {
          return none(`state store not writable (${store.reason()}), delete deferred`);
        }
      }
    }
    const result = await orion.delete(o.ids, { chunkSize: DELETE_CHUNK_SIZE, label: o.label });
    const deleted = [...result.deleted];
    if (deleted.length > 0) for (const key of keys) signatures.forget(key, deleted);
    log.info(`${o.label}: deleted ${String(deleted.length)} of ${String(o.ids.length)}`);
    return { deleted: result.deleted, skipped: null };
  }
}

function signatureKeysOf(key: string | undefined, more: readonly string[] | undefined): string[] {
  return [...(key === undefined ? [] : [key]), ...(more ?? [])];
}

export function createPruner(deps: PrunerDeps): Pruner {
  return new KernelPruner(deps);
}
