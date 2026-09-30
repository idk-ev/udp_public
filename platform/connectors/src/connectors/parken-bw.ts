/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `parken-bw` — car parks and bike parking in Baden-Württemberg (ParkAPI v3).
 *
 * Port of FN_PARK_FETCH (`udp-rt-bp-fetch`), FN_PARK_BUILD (`udp-rt-bp-build`)
 * and the signature commit behind its upsert (`udp-rt-bp-commit`, now inside
 * `Orion.upsert`). Writes one `ParkingSite` per car park, one `BikeParking` per
 * bike parking site with realtime occupancy, and one `ParkingSummary` per
 * municipality.
 *
 * ## The incident this connector is the reason for
 *
 * From late July to 24.08.2026 this connector wrote roughly 1.04 million TRoE
 * rows a day — about half of all rows — without anyone noticing for a month.
 * Two bugs, both silent:
 *
 *   > Vorher fächerte dieser Schritt 66 Anfragen mit &offset=<n*500> auf. Die
 *   > v3-API ignoriert offset stillschweigend: Die Antworten zu
 *   > offset=0/500/…/2500 waren byteweise identisch (IDs 384–1441). Der
 *   > Konnektor sah also 500 von 31.909 Anlagen und schrieb jede davon 66× je
 *   > Lauf.
 *
 * and the entity ids were built from the slugged site NAME, so equally named
 * sites collapsed into one entity:
 *
 *   > Vorher stand dort der geslugte Anlagenname, weshalb gleichnamige Anlagen
 *   > aufeinander fielen (42× »hauptbahnhof-westseite«, 36× »list-gymnasium« …).
 *
 * What must never regress, and what test/parity/parken-bw-invariants.test.ts
 * checks against THIS file:
 *
 *  * cursor pagination with `start=<next_id>` — never `offset=` ({@link pageUrl});
 *  * an overlap check across pages and a page cap with a warning
 *    ({@link ParkPager}, {@link MAX_PAGES}) — "lieber laut abbrechen als noch
 *    einmal 66× denselben Bestand schreiben";
 *  * stable ids from the ParkAPI key, `parkapi-<id>` ({@link siteId}), without
 *    the AGS (derived; a relocated site would orphan entity and time series);
 *  * no entity id from slugged free text;
 *  * the change gate in REPLACE mode for the sums, and the own tables
 *    `parkStatik` / `parkFrei` reduced to the current stock every run;
 *  * the row budget of the registry (`rowBudget24h`: ParkingSite 25,000,
 *    BikeParking 8,000, ParkingSummary 25,000 per day), watched by troe-stats.
 *
 * ## Shape of the port
 *
 * The cursor of the next page is only in the answer to the previous one, so
 * the pages are fetched sequentially. {@link ParkPager} is the fold over pages
 * the old fetch node did inline; `run` drives it page by page and `parse`
 * folds a recorded page sequence with the same code, so the abort cases are
 * testable offline. `build` is the geo part of the old build node (assignment,
 * municipal sums); {@link planSites} is its table part (full write, occupancy
 * only, freshness, nothing) over copies of the two tables — pure as well —
 * and {@link planWrite} applies it to the change gate (tables reduced to the
 * current stock, sums through the gate in replace mode) as one upsert plan.
 *
 * ## Deliberate deviations (behaviour otherwise identical)
 *
 *  * Transport: `ctx.fetch` instead of `node:https` + `zlib` inside the vm
 *    (see src/kernel/fetcher.ts): the service-wide User-Agent instead of
 *    `UDP Node-RED Konnektor parken-bw`, and the kernel's retries (2) on a
 *    network error before the run is aborted — the old node gave up on the
 *    first failure. The 1 s pause between pages is the fetcher's token bucket.
 *  * The prunes are awaited one after the other AFTER the upsert; the old node
 *    started them fire-and-forget while its chunks were still queued in the
 *    delay node. Their `keep` sets are the same, so nothing else differs.
 *  * Malformed records the old node would have crashed on or written verbatim
 *    are narrowed: an item that is not an object counts as seen but is not
 *    used (old: TypeError, run lost); an id that is neither number nor string
 *    is not used (old: `parkapi-undefined`); a non-numeric capacity counts 0
 *    and a non-numeric free count as "no realtime" (old: string arithmetic); a
 *    non-scalar `source_id` becomes `null`; a `next_id` that is neither number
 *    nor string aborts the run like a stalled cursor. None of these occur in
 *    the v3 schema; they are listed so nobody mistakes them for parity gaps.
 *  * Log texts are English; the `[error]`/`[warn]` levels are the old ones.
 */

import { mergePlans } from "../kernel/change-gate.js";
import { cleanText, dateObserved, observed } from "../kernel/ngsi.js";
import {
  isArray,
  isFiniteNumber,
  isRecord,
  isString,
  isTruthy,
  optString,
  requireArray,
} from "../kernel/parse.js";
import { hash64, propertyValue } from "../kernel/split-gate.js";
import { persisted, stateKey } from "../kernel/state.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  Ags,
  ChangeGate,
  ConnectorModule,
  Ctx,
  EntityId,
  Fetcher,
  GeoIndex,
  GeoJsonPoint,
  IsoTime,
  Log,
  MunicipalityRow,
  NgsiDateTime,
  NgsiEntity,
  PendingSignature,
  Property,
  PruneOptions,
  SeedOptions,
  SignatureValue,
  UpsertPlan,
} from "../kernel/types.js";

export const ID = "parken-bw";

/** ParkAPI v3, MobiData BW. */
export const BASE_URL = "https://api.mobidata-bw.de/park-api/api/public/v3/parking-sites";
/** `PRO_SEITE` of the old node. */
export const PAGE_SIZE = 500;
/**
 * `MAX_SEITEN`: 31,909/500 ≈ 64 pages — a cap with headroom for growth. Hitting
 * it is never silent (see {@link fetchInventory}): cutting off quietly would be
 * the same error as the offset bug with the opposite sign.
 */
export const MAX_PAGES = 120;
/**
 * Body cap per page (security review; the old node read without a limit). A
 * page of 500 sites measured 0.3 MB decompressed (2026-09); 16 MiB is ~50 times
 * that and still finite.
 */
export const PAGE_MAX_BYTES = 16 * 1024 * 1024;
/** `PAUSE_MS`: politeness towards MobiData BW, as the former 1-request/s node. */
export const PAGE_INTERVAL_MS = 1000;

/** As FN_PARK_BUILD: `emitChunks(node, msg, entities, 100)`. */
const CHUNK_SIZE = 100;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const PROVIDER = "MobiData BW ParkAPI";

/** Own tables and gate keys, unchanged from the flow context. */
export const STATIC_TABLE = "parkStatik";
export const OCCUPANCY_TABLE = "parkFrei";
export const SUMMARY_GATE = "parkSummenSig";
export const CONFIRM_KEYS = ["parkPruneSite", "parkPruneBike", "parkPruneSummary"] as const;

/**
 * Creation time of the switch to `parkapi-` ids (commit of 25.08.2026 03:28
 * CEST). Only entities created before it can be legacy ones.
 */
const LEGACY_MIGRATION_MS = Date.parse("2026-08-25T01:28:11Z");

/* ------------------------------------------------------------------ Records */

/** The ParkAPI's own key of a site. A number in v3. */
export type ParkApiId = number | string;

/** Site purposes this connector writes; the rest (`ITEM` lockers, …) is skipped. */
export type ParkPurpose = "CAR" | "BIKE";

/**
 * The compact positional record of the old fetch node — "bei ~32.000 Anlagen
 * zählt jedes Feld". The column meaning used to be a comment
 * (`// 0 id · 1 lat · 2 lon · …`); here the compiler carries it.
 */
export type ParkRecord = readonly [
  id: ParkApiId,
  lat: number,
  lon: number,
  capacity: number,
  purpose: ParkPurpose,
  /** Cleaned (apostrophe swap, 80 characters), trimmed. */
  name: string,
  /** `official_region_code`, the 12-digit ARS; `""` if missing. */
  regionCode: string,
  sourceId: number | string | null,
  /** `original_uid`, at most 64 characters; `""` if missing. */
  originalUid: string,
  /** `modified_at`; `""` if missing. */
  modifiedAt: string,
  realtime: boolean,
  /** Free spaces; `-1` = unknown (no realtime data). */
  free: number,
];

/** What the cursor run collected. */
export interface ParkInventory {
  readonly records: readonly ParkRecord[];
  /** Pages read. */
  readonly pages: number;
  /** `total_count` of the first page that carried one. */
  readonly total: number | null;
  /** Distinct source ids seen (all items, usable or not). */
  readonly seen: number;
  /** The cursor ran to its end (no `next_id` any more). */
  readonly exhausted: boolean;
  /**
   * `msg.parkVollstaendig`: cursor ran to the end AND delivered what it
   * announced (≥ 90 %). Only then may anything be pruned.
   */
  readonly complete: boolean;
}

/** Outcome of one page. */
export type PageStep =
  | { readonly kind: "next"; readonly start: ParkApiId }
  | { readonly kind: "done" }
  | { readonly kind: "abort"; readonly message: string };

/** Thrown by {@link parse} when a recorded page sequence would have aborted the run. */
export class ParkPagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParkPagingError";
  }
}

/** Text of a scalar for comparison and URL building; `null` for anything else. */
function scalarText(value: unknown): string | null {
  if (isString(value)) return value;
  if (isFiniteNumber(value)) return String(value);
  return null;
}

/**
 * `start=`, never `offset=`: the v3 API ignores `offset` silently, and exactly
 * that returned the same 500 sites 66 times per run for a month.
 */
export function pageUrl(start: ParkApiId | null): string {
  return `${BASE_URL}?limit=${String(PAGE_SIZE)}${start === null ? "" : `&start=${encodeURIComponent(String(start))}`}`;
}

/** One item of a page as the compact record, or `null` if it is not used. */
function compact(item: Record<string, unknown>): ParkRecord | null {
  const id = item.id;
  if (!isFiniteNumber(id) && !isString(id)) return null;
  if (!isTruthy(item.lat) || !isTruthy(item.lon)) return null;
  const purpose = item.purpose;
  if (purpose !== "CAR" && purpose !== "BIKE") return null;
  const realtime = item.has_realtime_data === true;
  const free = item.realtime_free_capacity;
  const sourceId = item.source_id;
  const uid = scalarText(item.original_uid);
  const name = optString(item.name) ?? "";
  return [
    id,
    Number(item.lat),
    Number(item.lon),
    isFiniteNumber(item.capacity) ? item.capacity : 0,
    purpose,
    cleanText(name.trim(), 80),
    scalarText(item.official_region_code) ?? "",
    isFiniteNumber(sourceId) || isString(sourceId) ? sourceId : null,
    uid === null ? "" : uid.slice(0, 64),
    optString(item.modified_at) ?? "",
    realtime,
    realtime && isFiniteNumber(free) ? free : -1,
  ];
}

/**
 * The cursor fold of the old fetch node, one page at a time. Pure: it never
 * fetches, it only says what the next request is — or that the run must stop.
 */
export class ParkPager {
  readonly #seen = new Set<unknown>();
  readonly #records: ParkRecord[] = [];
  #start: ParkApiId | null = null;
  #pages = 0;
  #total: number | null = null;
  #exhausted = false;

  /** Cursor of the next request; `null` before the first page. */
  get start(): ParkApiId | null {
    return this.#start;
  }

  get pages(): number {
    return this.#pages;
  }

  get seen(): number {
    return this.#seen.size;
  }

  get total(): number | null {
    return this.#total;
  }

  take(body: unknown): PageStep {
    const number = this.#pages + 1;
    const items = isRecord(body) ? body.items : undefined;
    if (!isArray(items)) {
      return {
        kind: "abort",
        message: `ParkAPI: page ${String(number)} without items array — response format changed?`,
      };
    }
    this.#pages = number;
    const total = isRecord(body) ? body.total_count : undefined;
    if (this.#total === null && isFiniteNumber(total)) this.#total = total;

    // Overlap check. Exactly this error — pages that all deliver the same
    // slice — went unnoticed for a month because it was silent. Better abort
    // loudly than write the same stock 66 times again.
    const idOf = (item: unknown): unknown => (isRecord(item) ? item.id : undefined);
    let duplicates = 0;
    for (const item of items) if (this.#seen.has(idOf(item))) duplicates += 1;
    if (duplicates > 0) {
      return {
        kind: "abort",
        message:
          `ParkAPI: page ${String(number)} overlaps the previous pages in ${String(duplicates)} of ` +
          `${String(items.length)} records — is the cursor "start" no longer working? Run aborted`,
      };
    }
    for (const item of items) {
      this.#seen.add(idOf(item));
      if (!isRecord(item)) continue;
      const record = compact(item);
      if (record !== null) this.#records.push(record);
    }

    const next = isRecord(body) ? body.next_id : undefined;
    if (next === null || next === undefined) {
      this.#exhausted = true;
      return { kind: "done" };
    }
    const nextText = scalarText(next);
    if (nextText === null || !(isFiniteNumber(next) || isString(next))) {
      return {
        kind: "abort",
        message: `ParkAPI: cursor next_id unreadable on page ${String(number)} — run aborted`,
      };
    }
    // `String(next_id) === String(start)` of the original; `start` is still null on page 1.
    if (nextText === (this.#start === null ? "null" : String(this.#start))) {
      return {
        kind: "abort",
        message: `ParkAPI: cursor stalled (next_id ${nextText} as before) — run aborted`,
      };
    }
    this.#start = next;
    return { kind: "next", start: next };
  }

  inventory(): ParkInventory {
    const total = this.#total;
    const seen = this.#seen.size;
    const short = total !== null && total !== 0 && seen < total * 0.9;
    return {
      records: this.#records,
      pages: this.#pages,
      total,
      seen,
      exhausted: this.#exhausted,
      complete: this.#exhausted && !short,
    };
  }
}

/**
 * Folds a recorded page sequence (the bodies, in cursor order) exactly as
 * `run` folds the live one. Throws {@link ParkPagingError} where the live run
 * would have been aborted. A sequence that ends before the cursor does is
 * incomplete, as a run that hit the page cap.
 */
export function parse(raw: unknown): ParkInventory {
  const pager = new ParkPager();
  for (const body of requireArray(raw, "pages")) {
    const step = pager.take(body);
    if (step.kind === "abort") throw new ParkPagingError(step.message);
    if (step.kind === "done") break;
  }
  return pager.inventory();
}

/**
 * The cursor loop of FN_PARK_FETCH. `null` after an `[error]` — the run is
 * aborted, nothing is written and nothing pruned.
 */
export async function fetchInventory(fetcher: Fetcher, log: Log): Promise<ParkInventory | null> {
  const pager = new ParkPager();
  let finished = false;
  while (pager.pages < MAX_PAGES) {
    const number = pager.pages + 1;
    const url = pageUrl(pager.start);
    let status: number;
    let text: string;
    try {
      const response = await fetcher.text(url, {
        headers: { Accept: "application/json" },
        minIntervalMs: PAGE_INTERVAL_MS,
        maxBytes: PAGE_MAX_BYTES,
      });
      status = response.status;
      text = response.body;
    } catch (error) {
      log.error(`ParkAPI: page ${String(number)} not loadable`, error);
      return null;
    }
    if (status !== 200) {
      log.error(`ParkAPI: HTTP ${String(status)} on page ${String(number)} (${url})`);
      return null;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      log.error(`ParkAPI: page ${String(number)} is not valid JSON`);
      return null;
    }
    const step = pager.take(body);
    if (step.kind === "abort") {
      log.error(step.message);
      return null;
    }
    const total = pager.total;
    log.status(
      `page ${String(pager.pages)} · ${String(pager.seen)}${total === null || total === 0 ? "" : `/${String(total)}`} records`,
    );
    if (step.kind === "done") {
      finished = true;
      break;
    }
  }

  const inventory = pager.inventory();
  const announced = inventory.total === null || inventory.total === 0 ? "" : ` of ${String(inventory.total)}`;
  // Never cut off silently: whoever reaches the cap gets a log entry —
  // otherwise the error above repeats itself with the opposite sign.
  if (!finished) {
    log.warn(
      `ParkAPI: page cap ${String(MAX_PAGES)} reached, stock incomplete (${String(inventory.seen)}${announced}) — raise MAX_PAGES`,
    );
  }
  if (
    inventory.total !== null &&
    inventory.total !== 0 &&
    finished &&
    inventory.seen < inventory.total * 0.9
  ) {
    log.warn(
      `ParkAPI: only ${String(inventory.seen)} of ${String(inventory.total)} announced records fetched`,
    );
  }
  return inventory;
}

/* ------------------------------------------------------------------ Build */

/**
 * AGS from the 12-digit ARS (Amtlicher Regionalschlüssel):
 *
 *   > Die ParkAPI führt official_region_code zu 100 % — einen 12-stelligen ARS.
 *   > Der AGS steckt darin, nur an anderer Stelle: AGS = ARS[0..5] + ARS[9..12]
 *   > (Land+RB+Kreis, dann die Gemeinde; die Stellen 6–9 sind der
 *   > Verbandsschlüssel). Beispiele: 081160019019 -> 08116019, 082120000000 ->
 *   > 08212000. Gegen gui/public/bw-gemeinden.json geprüft: 830 von 830
 *   > Stichproben getroffen.
 *
 * Exact and free; the strict point-in-polygon lookup is only the fallback for
 * records without or with an unknown ARS.
 */
export function arsToAgs(ars: string): Ags | null {
  return /^[0-9]{12}$/.test(ars) ? ars.slice(0, 5) + ars.slice(9, 12) : null;
}

/**
 * Compact value signature (src/kernel/split-gate.ts, where it moved from
 * here): the flow context was written to disk; raw signatures of ~26,000
 * sites would have been several MB per write. Kept verbatim so both runtimes
 * agree on a value.
 */
export { hash64 };

export type SiteType = "ParkingSite" | "BikeParking";

/** A site assigned to a municipality, before the tables decide what is written. */
export type SiteCandidate = readonly [type: SiteType, municipality: MunicipalityRow, record: ParkRecord];

type MeasuredCount = Property<number>;

export interface ParkingSummaryEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:ParkingSummary:bw-${string}`;
  readonly type: "ParkingSummary";
  readonly ags: Property<string>;
  readonly siteCount: MeasuredCount;
  readonly totalCapacity: MeasuredCount;
  readonly realtimeFree?: MeasuredCount | undefined;
  readonly realtimeSites?: MeasuredCount | undefined;
  readonly dateObserved?: Property<NgsiDateTime> | undefined;
  readonly "@context": string;
}

export interface ParkingSiteEntity extends NgsiEntity {
  readonly id: EntityId;
  readonly type: SiteType;
  readonly ags: Property<string>;
  readonly name: Property<string>;
  readonly totalSpotNumber: Property<number>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly dataProvider: Property<string>;
  readonly location: { readonly type: "GeoProperty"; readonly value: GeoJsonPoint };
  readonly sourceId?: Property<number | string> | undefined;
  readonly originalUid?: Property<string> | undefined;
  readonly category?: Property<string> | undefined;
  readonly availableSpotNumber?: MeasuredCount | undefined;
  readonly "@context": string;
}

/** Counters of the assignment, for the status line. */
export interface AssignmentCounts {
  readonly viaArs: number;
  readonly viaGeo: number;
  readonly outside: number;
  readonly unassigned: number;
  /** `modified_at` within the last day — an operating display, not a write reason. */
  readonly freshSource: number;
}

export interface ParkBuild {
  /** Car parks first, then bike parking with realtime occupancy — the old order. */
  readonly sites: readonly SiteCandidate[];
  readonly summaries: readonly ParkingSummaryEntity[];
  readonly counts: AssignmentCounts;
  /** `anlagen.length`: usable records of the run. */
  readonly records: number;
}

interface Sum {
  n: number;
  cap: number;
  rtFree: number;
  rtN: number;
}

/**
 * Assignment and municipal sums. Pure. `geo` may be `null` (no master data):
 * then nothing can be assigned, as the old node would not have run at all.
 */
export function build(inventory: ParkInventory, geo: GeoIndex | null, now: IsoTime): ParkBuild {
  const byMunicipality = new Map<Ags, Sum>();
  const cars: SiteCandidate[] = [];
  const bikes: SiteCandidate[] = [];
  let viaArs = 0;
  let viaGeo = 0;
  let outside = 0;
  let unassigned = 0;
  let freshSource = 0;
  const dayAgo = Date.parse(now) - DAY_MS;

  for (const record of inventory.records) {
    const lat = record[1];
    const lon = record[2];
    let municipality: MunicipalityRow | null = null;
    const ags = arsToAgs(record[6]);
    if (ags !== null) {
      // The ARS says: not Baden-Württemberg.
      if (!ags.startsWith("08")) {
        outside += 1;
        continue;
      }
      municipality = geo?.byAgs(ags) ?? null;
      if (municipality !== null) viaArs += 1;
    }
    if (municipality === null) {
      if (geo?.hasBoundaries !== true) {
        unassigned += 1;
        continue;
      }
      municipality = geo.municipalityAt(lat, lon);
      // In no BW municipality polygon — no centroid guessing.
      if (municipality === null) {
        outside += 1;
        continue;
      }
      viaGeo += 1;
    }
    if (record[9] !== "" && Date.parse(record[9]) > dayAgo) freshSource += 1;
    if (record[4] === "BIKE") {
      // Only bike sites with realtime occupancy — a capacity figure without free
      // spaces would add nothing to the dashboard (building block "br").
      if (record[11] >= 0) bikes.push(["BikeParking", municipality, record]);
      continue;
    }
    const key = municipality[0];
    let sum = byMunicipality.get(key);
    if (sum === undefined) {
      sum = { n: 0, cap: 0, rtFree: 0, rtN: 0 };
      byMunicipality.set(key, sum);
    }
    sum.n += 1;
    sum.cap += record[3];
    if (record[11] >= 0) {
      sum.rtFree += record[11];
      sum.rtN += 1;
    }
    cars.push(["ParkingSite", municipality, record]);
  }

  const summaries = [...byMunicipality].map(([ags, sum]): ParkingSummaryEntity => ({
    id: `urn:ngsi-ld:ParkingSummary:bw-${ags}`,
    type: "ParkingSummary",
    ags: { type: "Property", value: ags },
    siteCount: observed(sum.n, "C62", now),
    totalCapacity: observed(sum.cap, "C62", now),
    "@context": NGSI_CONTEXT,
    ...(sum.rtN > 0
      ? {
          realtimeFree: observed(sum.rtFree, "C62", now),
          realtimeSites: observed(sum.rtN, "C62", now),
          // Freshness of the realtime sum: the gate refreshes dateObserved of
          // unchanged sums (about 100 municipalities × 8 runs ≈ 800 rows/day).
          dateObserved: dateObserved(now),
        }
      : {}),
  }));

  return {
    sites: [...cars, ...bikes],
    summaries,
    counts: { viaArs, viaGeo, outside, unassigned, freshSource },
    records: inventory.records.length,
  };
}

/** Sums unchanged → not written at all (no dateObserved without realtime). */
export function summarySignature(entity: ParkingSummaryEntity): string {
  return [
    entity.siteCount.value,
    entity.totalCapacity.value,
    entity.realtimeFree === undefined ? "" : entity.realtimeFree.value,
    entity.realtimeSites === undefined ? "" : entity.realtimeSites.value,
  ].join("|");
}

/**
 * Stable entity id from the ParkAPI's own id. The AGS deliberately does NOT
 * belong in it: it is derived, and a relocated site would orphan the entity
 * together with its time series. The frontend queries by the `ags` ATTRIBUTE
 * (gui/public/smartcity-lib.js, byAgs), never by the id.
 */
export function siteId(type: SiteType, record: ParkRecord): EntityId {
  return `urn:ngsi-ld:${type}:parkapi-${String(record[0])}`;
}

/** What {@link planSites} decided for the site entities. */
export interface SitePlan {
  readonly entities: readonly NgsiEntity[];
  readonly pending: readonly PendingSignature[];
  /** Entries of `parkStatik` to carry over (unchanged master data). */
  readonly keepStatic: ReadonlySet<string>;
  /** Entries of `parkFrei` to carry over (unchanged occupancy). */
  readonly keepOccupancy: ReadonlySet<string>;
  /** Every site id of this run — the `keep` of the prunes. */
  readonly ids: ReadonlySet<EntityId>;
  readonly full: number;
  readonly occupancyOnly: number;
  readonly fresh: number;
  readonly unchanged: number;
}

/**
 * Separate statics from dynamics. Orion-LD writes one TRoE row per attribute
 * sent with `options=update`, whether the value changed or not. The earlier
 * version sent all seven attributes per site and run; only 4.7 % of the sites
 * have realtime data at all, the other six attributes practically never change.
 *
 *   > Bewusst NICHT modified_at als Auslöser für den Vollschrieb: Das Feld
 *   > wandert bei jedem Neueinlesen der Quelle mit. Im Abzug vom 24.08. trugen
 *   > 93 von 500 Datensätzen (darunter alle 32 mit Echtzeitdaten) ein frisches
 *   > modified_at, ohne dass sich fachlich etwas geändert hätte.
 *
 * The value signature of the static attributes decides, the same idea as the
 * change gate. Pure over COPIES of the two tables: new values only go into
 * `pending` (committed after a confirmed upsert), and the caller reduces the
 * stored tables to `keepStatic` / `keepOccupancy` with `ctx.gate.retain`
 * before the upsert — the whole stock is seen every run, so the tables are
 * replaced, not merged (otherwise they would grow without bound).
 */
export function planSites(
  sites: readonly SiteCandidate[],
  staticTable: ReadonlyMap<string, SignatureValue>,
  occupancyTable: ReadonlyMap<string, SignatureValue>,
  now: IsoTime,
): SitePlan {
  const entities: NgsiEntity[] = [];
  const pending: PendingSignature[] = [];
  const keepStatic = new Set<string>();
  const keepOccupancy = new Set<string>();
  const ids = new Set<EntityId>();
  let full = 0;
  let occupancyOnly = 0;
  let fresh = 0;
  let unchanged = 0;

  for (const [type, municipality, record] of sites) {
    const id = siteId(type, record);
    const [, lat, lon, capacity, purpose, name, , sourceId, originalUid, , , free] = record;
    ids.add(id);
    const signature = hash64(
      [
        municipality[0],
        name,
        capacity,
        lat.toFixed(5),
        lon.toFixed(5),
        sourceId ?? "",
        originalUid,
        purpose,
      ].join("|"),
    );
    const stamp = dateObserved(now);
    if (staticTable.get(id) !== signature) {
      // First sighting or a real master data change -> full entity.
      full += 1;
      pending.push([STATIC_TABLE, id, signature, id]);
      if (free >= 0) pending.push([OCCUPANCY_TABLE, id, free, id]);
      const entity: ParkingSiteEntity = {
        id,
        type,
        ags: { type: "Property", value: municipality[0] },
        name: {
          type: "Property",
          value: name === "" ? (type === "BikeParking" ? "Radabstellanlage" : "Parkplatz") : name,
        },
        totalSpotNumber: { type: "Property", value: capacity, unitCode: "C62" },
        dateObserved: stamp,
        dataProvider: { type: "Property", value: PROVIDER },
        location: { type: "GeoProperty", value: { type: "Point", coordinates: [lon, lat] } },
        "@context": NGSI_CONTEXT,
        // The source's foreign keys: should MobiData BW rebuild its database
        // and hand out new ids, the entities can be matched again through
        // them. Only when present — Orion-LD refuses a Property with null.
        ...(sourceId === null ? {} : { sourceId: { type: "Property", value: sourceId } }),
        ...(originalUid === "" ? {} : { originalUid: { type: "Property", value: originalUid } }),
        ...(type === "ParkingSite" ? { category: { type: "Property", value: "CAR" } } : {}),
        ...(free >= 0 ? { availableSpotNumber: observed(free, "C62", now) } : {}),
      };
      entities.push(entity);
      continue;
    }
    keepStatic.add(id);
    // Master data unchanged: only the occupancy, and only if it moved.
    // Freshness: sites with realtime occupancy refresh dateObserved in every
    // run (about 370 sites × 8 runs ≈ 3,000 rows/day), so views can tell a
    // current occupancy from a frozen one. Static-only sites (about 98 %) do
    // not: their data are master data without an observation time, and
    // refreshing them would cost about 200,000 rows/day. Their removal is
    // handled by the prune.
    if (free >= 0 && occupancyTable.get(id) !== free) {
      occupancyOnly += 1;
      pending.push([OCCUPANCY_TABLE, id, free, id]);
      entities.push({
        id,
        type,
        availableSpotNumber: observed(free, "C62", now),
        dateObserved: stamp,
        "@context": NGSI_CONTEXT,
      });
      continue;
    }
    if (free >= 0) {
      keepOccupancy.add(id);
      fresh += 1;
      entities.push({ id, type, dateObserved: stamp, "@context": NGSI_CONTEXT });
    }
    unchanged += 1;
  }
  return { entities, pending, keepStatic, keepOccupancy, ids, full, occupancyOnly, fresh, unchanged };
}

/**
 * The table part of the old build node against the change gate: the site
 * plan over copies of `parkStatik`/`parkFrei`, the two tables reduced to the
 * current stock, and the municipal sums through the gate — one plan for one
 * write, sites first, sums after, as the old chunks were. No network; `run`
 * hands it to `Orion.upsert`, which commits the pending signatures the broker
 * confirms.
 */
export function planWrite(
  gate: ChangeGate,
  built: ParkBuild,
  now: IsoTime,
): { readonly upsert: UpsertPlan; readonly sites: SitePlan } {
  const sites = planSites(built.sites, gate.table(STATIC_TABLE), gate.table(OCCUPANCY_TABLE), now);
  // Whole stock per run -> reduce the tables to it (replace, not merge; merged
  // they would grow without bound). Before the upsert: the new values ride on
  // the plan and are committed for what the broker confirms.
  gate.retain(STATIC_TABLE, (field) => sites.keepStatic.has(field));
  gate.retain(OCCUPANCY_TABLE, (field) => sites.keepOccupancy.has(field));
  // Municipal sums: unchanged -> not written at all. Replace, because this run
  // sees the whole state's stock (see src/kernel/change-gate.ts).
  const sums = gate.check(SUMMARY_GATE, built.summaries, summarySignature, { replace: true });
  return { upsert: mergePlans({ entities: sites.entities, pending: sites.pending }, sums), sites };
}

/* ------------------------------------------------------------------ Seeding */

/**
 * `parkStatik` of a site as the broker holds it — the formula of
 * {@link planSites} over the entity's attributes; `null` when one is missing.
 * The name is the one written: a site whose source name was empty stands as
 * "Parkplatz"/"Radabstellanlage" and so differs once — a full write, never a
 * wrong match.
 */
export function brokerSiteStatic(entity: Readonly<Record<string, unknown>>): string | null {
  const purpose = entity.type === "ParkingSite" ? "CAR" : entity.type === "BikeParking" ? "BIKE" : null;
  const ags = propertyValue(entity, "ags");
  const name = propertyValue(entity, "name");
  const capacity = propertyValue(entity, "totalSpotNumber");
  const location = propertyValue(entity, "location");
  const coordinates = isRecord(location) ? location.coordinates : undefined;
  const [lon, lat]: readonly unknown[] = isArray(coordinates) ? coordinates : [];
  const sourceId = propertyValue(entity, "sourceId") ?? "";
  const originalUid = propertyValue(entity, "originalUid") ?? "";
  if (
    purpose === null ||
    !isString(ags) ||
    !isString(name) ||
    !isFiniteNumber(capacity) ||
    !isFiniteNumber(lat) ||
    !isFiniteNumber(lon) ||
    !(isString(sourceId) || isFiniteNumber(sourceId)) ||
    !isString(originalUid)
  ) {
    return null;
  }
  return hash64(
    [ags, name, capacity, lat.toFixed(5), lon.toFixed(5), sourceId, originalUid, purpose].join("|"),
  );
}

/** {@link summarySignature} of a sum as the broker holds it; `null` without its counts. */
export function brokerSummarySignature(entity: Readonly<Record<string, unknown>>): string | null {
  const sites = propertyValue(entity, "siteCount");
  const capacity = propertyValue(entity, "totalCapacity");
  const free = propertyValue(entity, "realtimeFree");
  const realtime = propertyValue(entity, "realtimeSites");
  if (!isFiniteNumber(sites) || !isFiniteNumber(capacity)) return null;
  if (
    !(free === undefined || isFiniteNumber(free)) ||
    !(realtime === undefined || isFiniteNumber(realtime))
  ) {
    return null;
  }
  return [sites, capacity, free ?? "", realtime ?? ""].join("|");
}

/** Empty tables (fresh install, lost state) are seeded from the broker instead of rewriting ~25,000 sites. */
export const SEED: SeedOptions = {
  label: "Parken-BW",
  queries: [
    { type: "ParkingSite", pattern: "^urn:ngsi-ld:ParkingSite:parkapi-[^:]+$" },
    { type: "BikeParking", pattern: "^urn:ngsi-ld:BikeParking:parkapi-[^:]+$" },
    { type: "ParkingSummary", pattern: "^urn:ngsi-ld:ParkingSummary:bw-[0-9]{8}$" },
  ],
  attrs: [
    "ags",
    "name",
    "totalSpotNumber",
    "location",
    "sourceId",
    "originalUid",
    "availableSpotNumber",
    "dataProvider",
    "siteCount",
    "totalCapacity",
    "realtimeFree",
    "realtimeSites",
  ],
  // Sites carry this connector's provider; the sums carry none.
  accept: (_id, entity) =>
    entity.type === "ParkingSummary" || propertyValue(entity, "dataProvider") === PROVIDER,
  tables: {
    [STATIC_TABLE]: (entity) => (entity.type === "ParkingSummary" ? null : brokerSiteStatic(entity)),
    [OCCUPANCY_TABLE]: (entity) => {
      if (entity.type === "ParkingSummary" || brokerSiteStatic(entity) === null) return null;
      const free = propertyValue(entity, "availableSpotNumber");
      return isFiniteNumber(free) ? free : null;
    },
    [SUMMARY_GATE]: (entity) => (entity.type === "ParkingSummary" ? brokerSummarySignature(entity) : null),
  },
};

/* ------------------------------------------------------------------ Legacy cleanup */

/**
 * Ownership check of the one-off legacy cleanup. Until August 2026 the ids
 * were `<municipality slug>-<slugged name or lat-lon>`; nothing writes them any
 * more. An entity counts as a legacy one of THIS connector only if its id
 * starts with a known municipality slug, it carries this connector's
 * `dataProvider` (municipal B+R connectors use the same slug-prefixed id style,
 * see docs/staedte-hinzufuegen.md, and must never be touched), and it was
 * created before the switch to `parkapi-` ids — so nothing written since can
 * ever match.
 */
export function legacyParkApi(
  slugs: ReadonlySet<string>,
): (id: string, entity: Readonly<Record<string, unknown>>) => boolean {
  const legacyOwn = (id: string): boolean => {
    const parts = id.split(":").slice(3).join(":").split("-");
    for (let i = 1; i < parts.length; i += 1) if (slugs.has(parts.slice(0, i).join("-"))) return true;
    return false;
  };
  return (id, entity) => {
    if (!legacyOwn(id)) return false;
    const provider = entity.dataProvider;
    if (!isTruthy(provider) || !isRecord(provider) || provider.value !== PROVIDER) return false;
    const createdAt = entity.createdAt;
    return isString(createdAt) && Date.parse(createdAt) < LEGACY_MIGRATION_MS;
  };
}

/**
 * The flow-context flags of the legacy cleanup. They are not signatures, so
 * they cannot live in the change gate; they live in `ctx.state`, persisted
 * like the prune bookkeeping.
 */
export const LEGACY_DONE = stateKey("parkLegacyDone", () => false, persisted.boolean);
export const LEGACY_LAST = stateKey("parkLegacyLast", () => 0, persisted.number);

/* ------------------------------------------------------------------ Run */

function statusText(built: ParkBuild, municipalities: number, plan: SitePlan): string {
  const c = built.counts;
  return (
    `${String(built.records)} sites · ${String(municipalities)} municipalities · ` +
    `${String(plan.full)} full · ${String(plan.occupancyOnly)} occupancy only · ` +
    `${String(plan.unchanged)} unchanged (${String(plan.fresh)} freshness)` +
    ` · ${String(c.freshSource)} with fresh modified_at` +
    (c.viaGeo > 0 ? ` · ${String(c.viaGeo)} via geo fallback` : "") +
    (c.outside > 0 ? ` · ${String(c.outside)} outside BW` : "") +
    (c.unassigned > 0 ? ` · ${String(c.unassigned)} unassigned` : "")
  );
}

async function pruneComplete(
  ctx: Ctx,
  geo: GeoIndex,
  plan: SitePlan,
  summaryIds: ReadonlySet<string>,
  status: string,
  now: IsoTime,
): Promise<void> {
  // Prune sites and sums this complete run no longer contains (left the
  // source, or outside BW and formerly assigned by centroid). Site timestamps
  // are not refreshed on unchanged runs, so instead of a grace period an id
  // must be missing in consecutive complete runs for at least 24 h
  // (confirmKey); a bike site without realtime data for a few hours is not
  // deleted.
  const [siteKey, bikeKey, summaryKey] = CONFIRM_KEYS;
  await ctx.prune.stale({
    label: "Parken-BW ParkingSite",
    type: "ParkingSite",
    pattern: "^urn:ngsi-ld:ParkingSite:parkapi-[^:]+$",
    keep: plan.ids,
    confirmKey: siteKey,
    confirmMs: 24 * HOUR_MS,
    intervalMs: ctx.intervalMs(),
    status,
  });
  await ctx.prune.stale({
    label: "Parken-BW BikeParking",
    type: "BikeParking",
    pattern: "^urn:ngsi-ld:BikeParking:parkapi-[^:]+$",
    keep: plan.ids,
    confirmKey: bikeKey,
    confirmMs: 24 * HOUR_MS,
    intervalMs: ctx.intervalMs(),
    status,
  });
  await ctx.prune.stale({
    label: "Parken-BW ParkingSummary",
    type: "ParkingSummary",
    pattern: "^urn:ngsi-ld:ParkingSummary:bw-[0-9]{8}$",
    keep: summaryIds,
    confirmKey: summaryKey,
    confirmMs: 24 * HOUR_MS,
    intervalMs: ctx.intervalMs(),
    status,
  });

  // One-off cleanup of the legacy id scheme. A static test forbids
  // ParkingSite/BikeParking ids other than parkapi-<id>, so none of the legacy
  // entities is ever confirmed again and the share limit cannot apply
  // (maxFraction 1). Instead: own pattern ([a-z0-9.-] only, the parkapi-
  // scheme excluded), known municipality slug AND this connector's
  // dataProvider AND created before the switch ({@link legacyParkApi});
  // untouched for 7 days; only after a complete run with plausible master
  // data; at most once a day and only if the previous daily check was done
  // (interval check), so a single snapshot never deletes. Once a complete
  // listing finds no legacy entity of either type any more, the check
  // switches itself off.
  const done = ctx.state.slot(LEGACY_DONE);
  const last = ctx.state.slot(LEGACY_LAST);
  const nowMs = Date.parse(now);
  if (done.get() || nowMs - last.get() < 20 * HOUR_MS) return;
  last.set(nowMs);
  const slugs = new Set(geo.municipalities.map((row) => row[8]).filter((slug) => slug !== ""));
  const accept = legacyParkApi(slugs);
  const legacy = (type: SiteType): PruneOptions => ({
    label: `Parken-BW legacy ${type}`,
    type,
    pattern: `^urn:ngsi-ld:${type}:[a-z0-9][a-z0-9.-]*$`,
    attrs: ["ags", "dataProvider"],
    exclude: `^urn:ngsi-ld:${type}:parkapi-`,
    accept,
    keep: plan.ids,
    graceMs: 7 * 24 * HOUR_MS,
    maxFraction: 1,
    intervalMs: DAY_MS,
    status,
  });
  const site = await ctx.prune.stale(legacy("ParkingSite"));
  const bike = await ctx.prune.stale(legacy("BikeParking"));
  if (site.listed !== null && bike.listed !== null && site.listed.mine === 0 && bike.listed.mine === 0) {
    done.set(true);
    ctx.log.info("Parken-BW: no legacy parking ids left, cleanup switched off");
  }
}

export async function run(ctx: Ctx): Promise<void> {
  const inventory = await fetchInventory(ctx.fetch, ctx.log);
  if (inventory === null) return;
  if (inventory.records.length === 0) {
    ctx.log.warn("ParkAPI: no usable sites in the snapshot");
    return;
  }
  ctx.log.status(
    `${String(inventory.pages)} pages · ${String(inventory.seen)}` +
      `${inventory.total === null || inventory.total === 0 ? "" : `/${String(inventory.total)}`} records · ` +
      `${String(inventory.records.length)} usable`,
  );

  // Boundaries optional: the ARS assigns first, the rest stays unassigned
  // until boundaries are loaded — never guessed by centroid.
  const geo = ctx.geo.forRun("Parken-BW", { boundaries: "optional" });
  if (geo === null) return;

  // One timestamp per run, as NOW of the old node.
  const now = ctx.now();
  const built = build(inventory, geo, now);
  await ctx.orion.seedSignatures(SEED);
  const stored = ctx.gate.table(STATIC_TABLE).size;
  const { upsert, sites: plan } = planWrite(ctx.gate, built, now);
  // Master data do not change wholesale; a mass of full writes on stored
  // signatures is lost change state.
  const sites = built.sites.length;
  if (stored * 2 >= sites && sites >= 20 && plan.full / sites > 0.5) {
    ctx.log.warn(
      `Parken-BW: ${String(plan.full)} of ${String(built.sites.length)} sites written in full although ` +
        "signatures were stored — change state lost?",
    );
  }

  // Cardinality invariant: if clearly fewer than n entity ids come out of n
  // source records, ids collide — exactly the error slugged names caused here
  // for a month (500 records -> 336 ids).
  const sourceRecords = built.sites.length;
  if (sourceRecords > 0 && plan.ids.size / sourceRecords < 0.95) {
    ctx.log.warn(
      `Parken-BW: only ${String(plan.ids.size)} distinct entity ids from ${String(sourceRecords)} source records ` +
        `(${String(Math.round((plan.ids.size / sourceRecords) * 100))} %) — id collision?`,
    );
  }

  const status = statusText(built, built.summaries.length, plan);
  ctx.log.status(status);

  const result = await ctx.orion.upsert(upsert, { chunkSize: CHUNK_SIZE });
  if (result.entities > 0) {
    ctx.log.info(
      `${String(result.entities)} entities upserted in ${String(result.chunks)} chunks ` +
        `(${String(result.failedChunks)} failed, ${String(result.committed)} signatures committed)`,
    );
  }

  if (inventory.complete && plan.ids.size > 0 && (await ctx.prune.masterDataPlausible())) {
    await pruneComplete(ctx, geo, plan, new Set(built.summaries.map((entity) => entity.id)), status, now);
  } else {
    // Incomplete run: candidates must be missing in CONSECUTIVE complete runs.
    for (const key of CONFIRM_KEYS) ctx.prune.resetConfirmations(key);
  }
}

/** Checked against the contract by the compiler. */
export const connector: ConnectorModule<ParkInventory, ParkBuild> = { id: ID, parse, build, run };
