/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The change gate with master data and measurements kept apart — the
 * `planSites` pattern of `parken-bw` (`parkStatik` / `parkFrei`, "nurFrei"),
 * generalised for the connectors whose entities carry a few measured values
 * next to a dozen attributes that practically never change.
 *
 * Orion-LD writes one TRoE row per attribute sent with `options=update`,
 * whether its value changed or not. The plain gate sends a changed entity in
 * full: an EV charging station whose status moved wrote twelve rows for one
 * or two changed counters. Here every entity has two signatures:
 *
 *  * a STATIC one over the master data (name, address, location, operator,
 *    …). Missing or different: the entity goes out in full, and both
 *    signatures ride on the write.
 *  * a DYNAMIC one over the measured attributes, kept per attribute (a JSON
 *    array in a fixed order). Static unchanged, dynamic different: a partial
 *    update with only the attributes whose value changed, plus
 *    `dateObserved`. `options=update` replaces exactly the attributes sent
 *    and leaves the rest of the entity alone.
 *  * both unchanged: the freshness stamp (`dateObserved` alone) in every
 *    `freshEvery`-th run, as the plain gate does.
 *
 * A partial update cannot REMOVE an attribute. When a measured attribute
 * disappears (a charging station loses its live status) the entity is sent
 * in full instead — which does not remove it either, but is what the plain
 * gate did, and rare.
 *
 * A partial or stamp-only update of an entity that is NOT in the broker
 * (deleted by an admin, a restore, a delete that was not confirmed) creates
 * a skeleton — id, type, a measurement, no name, no location, no provider —
 * and a kept static signature would never send the rest. So every entity is
 * written in full once a week anyway ({@link needsRefresh}: a fixed hour of
 * the week per id, spread evenly), which heals such a skeleton within a
 * week. It costs about one seventh of a full write of the stock per day
 * (docs/betrieb.md, "Zeilenbudget").
 *
 * Commit after confirm, as everywhere: new signatures are pending on the
 * plan, the old ones of whatever goes out are dropped from the tables before
 * the upsert ({@link applySplit}). `replace: true` (the call sees the whole
 * stock) reduces both tables to the current entities; merge mode only drops.
 */

import { freshTurn, MIN_ENTITIES_FOR_WARNING } from "./change-gate.js";
import { isArray, isRecord } from "./parse.js";
import type { ChangeGate, NgsiEntity, PendingSignature, SignatureValue, UpsertPlan } from "./types.js";

/** Default of `periodMs`, as the gate's. */
const HOUR_MS = 3_600_000;

/** Hours between two full writes of an unchanged entity: one week. */
export const REFRESH_EVERY_HOURS = 168;

/** This hour is `id`'s weekly full write (the same rotation as the freshness stamps). */
export function needsRefresh(id: string, nowMs: number): boolean {
  return freshTurn(id, REFRESH_EVERY_HOURS, HOUR_MS, nowMs);
}

/**
 * Compact value signature: two FNV-1a runs with different primes give 64
 * bits, base36 about 13 characters per entry. From `parken-bw`, where tens
 * of thousands of raw master data signatures would have been several MB per
 * write of the old flow context.
 */
export function hash64(text: string): string {
  let x = 0x811c9dc5;
  let y = 0x1000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    x = Math.imul(x ^ c, 0x01000193) >>> 0;
    y = Math.imul(y ^ c, 0x85ebca6b) >>> 0;
  }
  return x.toString(36) + y.toString(36);
}

/** `entity[name].value` of a Property as the broker returns it (or as it was built), else `undefined`. */
export function propertyValue(entity: Readonly<Record<string, unknown>>, name: string): unknown {
  const attribute = entity[name];
  return isRecord(attribute) ? attribute.value : undefined;
}

/** `[lon, lat]` of a GeoProperty point, rounded to 5 decimals (~1 m), or `null`. */
export function pointOf(entity: Readonly<Record<string, unknown>>, name = "location"): string | null {
  const value = propertyValue(entity, name);
  const coordinates = isRecord(value) ? value.coordinates : undefined;
  if (!isArray(coordinates)) return null;
  const [lon, lat] = coordinates;
  if (typeof lon !== "number" || typeof lat !== "number") return null;
  return `${lon.toFixed(5)},${lat.toFixed(5)}`;
}

/**
 * The static signature over `parts`, or `null` if one is missing — a broker
 * entity without its master data cannot seed a signature.
 */
export function staticSignatureOf(parts: readonly unknown[]): string | null {
  if (parts.some((part) => part === undefined || part === null)) return null;
  return hash64(JSON.stringify(parts));
}

/** The dynamic signature: the measured values in `attributes` order, `null` where absent. */
export function dynamicSignature(
  entity: Readonly<Record<string, unknown>>,
  attributes: readonly string[],
): string {
  return JSON.stringify(attributes.map((name) => propertyValue(entity, name) ?? null));
}

function decodeDynamic(signature: SignatureValue | undefined, length: number): readonly unknown[] | null {
  if (typeof signature !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(signature);
    return isArray(parsed) && parsed.length === length ? parsed : null;
  } catch {
    return null;
  }
}

export interface SplitSpec<T extends NgsiEntity> {
  readonly staticKey: string;
  readonly dynamicKey: string;
  /** Signature of the master data; must not depend on the measured values. */
  readonly staticSignature: (entity: T) => SignatureValue;
  /** The measured attributes, in a fixed order. */
  readonly dynamic: readonly string[];
  /** `true` if and only if this call sees the whole stock (see the gate's `replace`). */
  readonly replace: boolean;
  /** Freshness of unchanged entities with `dateObserved` in every k-th run. Default 1. */
  readonly freshEvery?: number | undefined;
  readonly periodMs?: number | undefined;
}

/** What {@link planSplit} decided. */
export interface SplitPlan extends UpsertPlan {
  /** Sent in full: new, master data changed, or a measured attribute disappeared. */
  readonly full: number;
  /** …of which had no static signature at all (new entity, or state lost). */
  readonly unknown: number;
  /** …of which were the weekly refresh of an unchanged entity. */
  readonly refreshed: number;
  /** Partial updates, and the measured attributes they carry (without `dateObserved`). */
  readonly partial: number;
  readonly partialAttributes: number;
  readonly unchanged: number;
  /** Unchanged entities refreshed with their stamp in this run. */
  readonly fresh: number;
  readonly keepStatic: ReadonlySet<string>;
  readonly keepDynamic: ReadonlySet<string>;
  readonly dropStatic: ReadonlySet<string>;
  readonly dropDynamic: ReadonlySet<string>;
}

/** Pure over COPIES of the two tables — see the module header. */
export function planSplit<T extends NgsiEntity>(
  entities: readonly T[],
  staticTable: ReadonlyMap<string, SignatureValue>,
  dynamicTable: ReadonlyMap<string, SignatureValue>,
  spec: SplitSpec<T>,
  nowMs: number,
): SplitPlan {
  const every = spec.freshEvery ?? 1;
  const period = spec.periodMs ?? HOUR_MS;
  const out: NgsiEntity[] = [];
  const pending: PendingSignature[] = [];
  const keepStatic = new Set<string>();
  const keepDynamic = new Set<string>();
  const dropStatic = new Set<string>();
  const dropDynamic = new Set<string>();
  let full = 0;
  let unknown = 0;
  let refreshed = 0;
  let partial = 0;
  let partialAttributes = 0;
  let unchanged = 0;
  let fresh = 0;

  for (const entity of entities) {
    const id = entity.id;
    const staticNow = spec.staticSignature(entity);
    const dynamicNow = dynamicSignature(entity, spec.dynamic);
    const staticBefore = staticTable.get(id);
    const dynamicBefore = dynamicTable.get(id);

    const sendFull = (): void => {
      full += 1;
      if (staticBefore === undefined) unknown += 1;
      else dropStatic.add(id);
      if (dynamicBefore !== undefined) dropDynamic.add(id);
      pending.push([spec.staticKey, id, staticNow, id], [spec.dynamicKey, id, dynamicNow, id]);
      out.push(entity);
    };

    if (staticBefore !== staticNow) {
      sendFull();
      continue;
    }
    // The weekly full write: heals an entity that vanished behind a kept
    // signature (see the module header), once per entity and week.
    if (needsRefresh(id, nowMs)) {
      refreshed += 1;
      sendFull();
      continue;
    }
    if (dynamicBefore === dynamicNow) {
      keepStatic.add(id);
      keepDynamic.add(id);
      unchanged += 1;
      const dateObserved = entity.dateObserved;
      if (dateObserved !== undefined && freshTurn(id, every, period, nowMs)) {
        fresh += 1;
        out.push({ id, type: entity.type, dateObserved, "@context": entity["@context"] });
      }
      continue;
    }
    // Master data unchanged, measurements moved: only what changed.
    const before = decodeDynamic(dynamicBefore, spec.dynamic.length);
    const changed: Record<string, NgsiEntity[string]> = {};
    let count = 0;
    let vanished = false;
    for (const [index, name] of spec.dynamic.entries()) {
      const now = propertyValue(entity, name);
      const was = before === null ? undefined : before[index];
      if (now === undefined) {
        if (was !== undefined && was !== null) vanished = true;
        continue;
      }
      if (before === null || JSON.stringify(now) !== JSON.stringify(was)) {
        changed[name] = entity[name];
        count += 1;
      }
    }
    if (vanished || count === 0) {
      sendFull();
      continue;
    }
    keepStatic.add(id);
    if (dynamicBefore !== undefined) dropDynamic.add(id);
    pending.push([spec.dynamicKey, id, dynamicNow, id]);
    out.push({
      ...changed,
      id,
      type: entity.type,
      ...(entity.dateObserved === undefined ? {} : { dateObserved: entity.dateObserved }),
      "@context": entity["@context"],
    });
    partial += 1;
    partialAttributes += count;
  }
  return {
    entities: out,
    pending,
    full,
    unknown,
    refreshed,
    partial,
    partialAttributes,
    unchanged,
    fresh,
    keepStatic,
    keepDynamic,
    dropStatic,
    dropDynamic,
  };
}

export interface SplitResult extends SplitPlan {
  /**
   * The static table held entries for at least half as many entities as this
   * call writes: not a first run, nor a new kind of entity in an old table.
   */
  readonly known: boolean;
}

/**
 * {@link planSplit} against the gate: copies of both tables, the old
 * signatures of whatever goes out dropped (replace: the tables reduced to the
 * current stock) BEFORE the upsert, the new ones pending on the plan.
 */
export function applySplit<T extends NgsiEntity>(
  gate: ChangeGate,
  entities: readonly T[],
  spec: SplitSpec<T>,
  nowMs: number,
): SplitResult {
  const staticTable = gate.table(spec.staticKey);
  const plan = planSplit(entities, staticTable, gate.table(spec.dynamicKey), spec, nowMs);
  if (spec.replace) {
    gate.retain(spec.staticKey, (field) => plan.keepStatic.has(field));
    gate.retain(spec.dynamicKey, (field) => plan.keepDynamic.has(field));
  } else {
    gate.retain(spec.staticKey, (field) => !plan.dropStatic.has(field));
    gate.retain(spec.dynamicKey, (field) => !plan.dropDynamic.has(field));
  }
  return { ...plan, known: staticTable.size > 0 && staticTable.size * 2 >= entities.length };
}

/** Share of full writes above which a non-first run warns: master data do not change wholesale. */
export const FULL_SHARE_WARNING = 0.5;

/** Sums of several {@link SplitResult}s — one line per run for a connector that plans per system. */
export interface SplitTotals {
  full: number;
  unknown: number;
  refreshed: number;
  partial: number;
  partialAttributes: number;
  unchanged: number;
  fresh: number;
  total: number;
  known: boolean;
}

export function emptyTotals(): SplitTotals {
  return {
    full: 0,
    unknown: 0,
    refreshed: 0,
    partial: 0,
    partialAttributes: 0,
    unchanged: 0,
    fresh: 0,
    total: 0,
    known: false,
  };
}

/** The totals of a single result. */
export function totalsOf(result: SplitResult): SplitTotals {
  const totals = emptyTotals();
  addTotals(totals, result);
  return totals;
}

export function addTotals(totals: SplitTotals, result: SplitResult): void {
  totals.full += result.full;
  totals.unknown += result.unknown;
  totals.refreshed += result.refreshed;
  totals.partial += result.partial;
  totals.partialAttributes += result.partialAttributes;
  totals.unchanged += result.unchanged;
  totals.fresh += result.fresh;
  totals.total += result.full + result.partial + result.unchanged;
  totals.known ||= result.known;
}

/**
 * The info line of a split write, and a `[warn]` when a run that had
 * signatures still sends more than half of its entities in full — master
 * data do not change wholesale; lost change state does.
 */
export function reportSplit(
  log: { info(message: string): void; warn(message: string): void },
  label: string,
  totals: SplitTotals,
): void {
  log.info(
    `${label}: ${String(totals.full)}/${String(totals.total)} in full (${String(totals.unknown)} without ` +
      `signature, ${String(totals.refreshed)} weekly refresh) · ${String(totals.partial)} partial ` +
      `(${String(totals.partialAttributes)} attributes) · ` +
      `${String(totals.unchanged)} unchanged (${String(totals.fresh)} freshness)`,
  );
  if (
    totals.known &&
    totals.total >= MIN_ENTITIES_FOR_WARNING &&
    (totals.full - totals.refreshed) / totals.total > FULL_SHARE_WARNING
  ) {
    log.warn(
      `${label}: ${String(totals.full)} of ${String(totals.total)} entities written in full although ` +
        "signatures were stored — change state lost?",
    );
  }
}
