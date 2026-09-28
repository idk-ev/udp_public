/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Automatic removal of stale own entities — port of PRUNE_HELPER
 * (`pruneStale`) and PRUNE_OK_JS in scripts/generate-nodered-flows.py.
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
 * ## State stays in memory — decided, not deferred by accident
 *
 * The interval bookkeeping and the confirmation tables live in this process,
 * per connector. A restart loses them, and both then answer "skip": the
 * interval check sees no previous run, the confirmation tables start empty. For
 * these two a restart only delays pruning.
 *
 * The third piece of state, the last plausible municipality count behind the
 * 95 % ratchet, is different: starting from zero it would make the check MORE
 * permissive after a restart, and under Compose the old runtime kept it
 * (`contextStorage: localfilesystem`; only Kubernetes ran without a volume on
 * /data). It is therefore seeded from the number of `Municipality` entities in
 * Orion before the first verdict, and while Orion cannot answer there is no
 * prune at all (see `MasterDataCheck` in src/kernel/geo.ts).
 *
 * All of it moves to Postgres together with the change gate, after parity (see
 * src/kernel/change-gate.ts).
 */

import type { SignatureScope } from "./change-gate.js";
import type { MasterDataCheck, SharedGeo } from "./geo.js";
import { isEntityId, isRecord, isString, isTruthy } from "./parse.js";
import type { EntityId, Log, Orion, PruneOptions, PruneResult, Pruner } from "./types.js";

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
}

class MemoryPruner implements Pruner {
  readonly #deps: PrunerDeps;
  /** `pruneLastRun_<label>` of the flow context, keyed by label, type and pattern. */
  readonly #lastRun = new Map<string, number>();
  readonly #confirmations = new Map<string, Map<string, Confirmation>>();

  constructor(deps: PrunerDeps) {
    this.#deps = deps;
  }

  async masterDataPlausible(): Promise<boolean> {
    const { masterData, geo, orion, log } = this.#deps;
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
    this.#confirmations.set(confirmKey, new Map());
  }

  async stale(options: PruneOptions): Promise<PruneResult> {
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
    const previousRun = this.#lastRun.get(intervalKey);
    this.#lastRun.set(intervalKey, now);
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

    let confirm: Map<string, Confirmation> | null = null;
    if (o.confirmKey !== undefined) {
      const previous = this.#confirmations.get(o.confirmKey) ?? new Map<string, Confirmation>();
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
      this.#confirmations.set(o.confirmKey, table);
      confirm = table;
    }
    if (candidates.length === 0) return { deleted: 0, listed, skipped: null };

    // 3. Delete in batches; count only what the broker confirms
    const result = await orion.delete(candidates, {
      chunkSize: DELETE_CHUNK_SIZE,
      label: `${o.label}: prune`,
    });
    const deleted = [...result.deleted];
    if (confirm !== null) for (const id of deleted) confirm.delete(id);
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
  return new MemoryPruner(deps);
}
