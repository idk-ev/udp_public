/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `mastr-bw` — photovoltaics per municipality from the Marktstammdatenregister,
 * 150 municipalities a night in rotation.
 *
 * Port of the nodes `udp-rt-bx-*` in scripts/generate-nodered-flows.py: the
 * rotation (`udp-rt-bx-msgs`, {@link plan}), one request per page behind a
 * "1 Anfrage/s" delay, the slimming node `udp-rt-bx-wrap` ({@link slimPage}),
 * the join and the aggregation `udp-rt-bx-build` ({@link parse} + {@link
 * build}): one `EnergyMonitor:bw-<ags>` with plant count, installed capacity
 * and additions per year. At 150 a night the whole state (1,103) is covered
 * in about a week.
 *
 * ## Adaptive page count
 *
 * Most municipalities have fewer than 2,000 plants (one page). The fixed
 * 10-page loop fired ~1,350 empty queries a night against the federal source,
 * so the plant count of the last run is cached per municipality and decides
 * the pages of the next; an unknown municipality gets the full ten once and
 * corrects itself afterwards (10 pages à 2,000 cover up to 20,000 plants;
 * Stuttgart has ~17,100).
 *
 * ## State
 *
 * The rotation position (`mastrPos`) and the plant counts (`mastrCount`) were
 * GLOBAL context in the flow. Here they live per connector context
 * ({@link stateOf}), in memory: lost on restart as the global context was in
 * Kubernetes (no volume on /data) — but not as under Compose, where Node-RED
 * persisted it. After a restart the rotation starts at the first municipality
 * again and every municipality gets ten pages once. Reported for the contract
 * review: persistent per-connector state would restore the Compose behaviour.
 *
 * ## Fan-out and the join
 *
 * The delay node released one request per second into the `http request`
 * node, slow answers overlapping; the `join` timed out after 1,000 s, and the
 * stragglers formed a second group that was built on its own (which could
 * write a municipality from a partial page set). The port paces the starts
 * through the host's token bucket, lets at most {@link MAX_IN_FLIGHT} overlap,
 * sends each page once (`retries: 0`) with the 120 s socket timeout of the
 * `http request` node — large municipalities answer with megabytes — and waits
 * for every page, then builds once. Bounded by the number of pages (at most
 * 1,500) times the timeout.
 *
 * No `dateObserved` and no change gate, as before; no prune (the rotation
 * never sees the whole stock in one run).
 */

import { observed } from "../kernel/ngsi.js";
import { isArray, isRecord, isString, isTruthy } from "../kernel/parse.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  Ags,
  ConnectorModule,
  Ctx,
  GeoIndex,
  IsoTime,
  MunicipalityRow,
  NgsiEntity,
  Property,
} from "../kernel/types.js";

export const ID = "mastr-bw";

const BASE_URL =
  "https://www.marktstammdatenregister.de/MaStR/Einheit/EinheitJson/GetErweiterteOeffentlicheEinheitStromerzeugung";

/** Log prefix. */
const LABEL = "MaStR-BW";

/** Municipalities per night. */
export const PER_RUN = 150;

/** Pages at most per municipality (2,000 plants each). */
export const MAX_PAGES = 10;

const PAGE_SIZE = 2000;

/** As the build node: `emitChunks(node, msg, entities, 100)`. */
const CHUNK_SIZE = 100;

/** Overlapping page requests; the token bucket paces their starts at one a second. */
const MAX_IN_FLIGHT = 8;

/** Node-RED's default socket timeout of the `http request` node. */
const REQUEST_TIMEOUT_MS = 120_000;

/** Additions per year kept (`additions.slice(-27)`): 1999 (= before 2000) onwards. */
const YEARS_KEPT = 27;

/** One page request of the rotation, as `udp-rt-bx-msgs` put it on the message. */
export interface MastrRequest {
  readonly url: string;
  readonly ags: Ags;
  readonly name: string;
  readonly page: number;
}

export interface RotationPlan {
  readonly requests: readonly MastrRequest[];
  readonly position: number;
  readonly nextPosition: number;
}

/** `[Bruttoleistung in kW, year of commissioning]`, 0 for an unknown year. */
export type PlantRow = readonly [kw: number, year: number];

/** One slimmed page — the payload `udp-rt-bx-wrap` hands to the join. */
export interface MastrPage {
  readonly ags: Ags;
  readonly page: number;
  /**
   * `Total` of the response: the plant count of the whole query, not of the
   * page. `undefined` when the response had none (read as 0 downstream).
   */
  readonly total: number | undefined;
  readonly rows: readonly PlantRow[];
}

/** `[year, plants, kW]` — one entry of `additionsByYear`. */
export type YearAdditions = readonly [year: number, plants: number, kw: number];

export interface EnergyMonitorEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:EnergyMonitor:bw-${string}`;
  readonly type: "EnergyMonitor";
  readonly ags: Property<string>;
  readonly plantCount: Property<number>;
  readonly installedCapacityKw: Property<number>;
  readonly additionsByYear: Property<readonly YearAdditions[]>;
  readonly complete: Property<boolean>;
  readonly "@context": string;
}

/* ------------------------------------------------------------------ rotation */

/**
 * Port of `udp-rt-bx-msgs`: the next {@link PER_RUN} municipalities from
 * `position` (wrapping around), and per municipality as many pages as its
 * cached plant count needs — all ten while it is unknown. Pure; the caller
 * stores `nextPosition`.
 */
export function plan(
  rows: readonly MunicipalityRow[],
  position: number,
  counts: ReadonlyMap<Ags, number>,
): RotationPlan {
  const requests: MastrRequest[] = [];
  const slice: MunicipalityRow[] = [];
  for (let i = 0; i < PER_RUN; i += 1) {
    const row = rows[(position + i) % rows.length];
    if (row !== undefined) slice.push(row);
  }
  for (const [ags, name] of slice) {
    const known = counts.get(ags);
    const pages =
      known === undefined ? MAX_PAGES : Math.min(MAX_PAGES, Math.max(1, Math.ceil(known / PAGE_SIZE)));
    for (let page = 1; page <= pages; page += 1) {
      requests.push({
        url:
          `${BASE_URL}?sort=&pageSize=${String(PAGE_SIZE)}` +
          "&filter=Energietr%C3%A4ger~eq~%272495%27~and~Gemeinde~eq~%27" +
          encodeURIComponent(name).replace(/'/g, "%27") +
          `%27~and~Betriebs-Status~eq~%2735%27&page=${String(page)}`,
        ags,
        name,
        page,
      });
    }
  }
  return { requests, position, nextPosition: (position + PER_RUN) % rows.length };
}

/* ------------------------------------------------------------------ slimming */

/** JavaScript's `String(x)` for a foreign value. */
function jsString(value: unknown): string {
  return String(value);
}

/** `new Date(ms).getUTCFullYear()` of `/Date(<ms>)/`, else 0. */
function yearOf(value: unknown): number {
  // `r.InbetriebnahmeDatum || ''`, and RegExp#exec stringifies what it gets.
  const text = isTruthy(value) ? jsString(value) : "";
  const match = /\/Date\((\d+)\)\//.exec(text);
  const ms = match?.[1];
  return ms === undefined ? 0 : new Date(Number.parseInt(ms, 10)).getUTCFullYear();
}

/**
 * Port of `udp-rt-bx-wrap`: a failed page (status ≥ 400, no body, no `Data`
 * array) becomes an empty page with total 0; otherwise `Total` and one
 * `[kW, year]` per plant. `status: null` is a request without a response —
 * the node then saw an error string as payload, which has no `Data` either.
 */
export function slimPage(request: MastrRequest, status: number | null, body: unknown): MastrPage {
  const data = isRecord(body) ? body.Data : undefined;
  if ((status !== null && status >= 400) || !isRecord(body) || !isArray(data)) {
    return { ags: request.ags, page: request.page, total: 0, rows: [] };
  }
  const total = body.Total;
  return {
    ags: request.ags,
    page: request.page,
    // `msg.payload.Total`, used as `part.total || 0` downstream.
    total: typeof total === "number" ? total : undefined,
    rows: data.map((row): PlantRow => {
      const record = isRecord(row) ? row : {};
      const kw = record.Bruttoleistung;
      // `r.Bruttoleistung || 0`
      return [typeof kw === "number" ? kw : 0, yearOf(record.InbetriebnahmeDatum)];
    }),
  };
}

/* ------------------------------------------------------------------ parse / build */

function parsePage(raw: unknown): MastrPage | null {
  // `if (!part || !part.ags) continue;`
  if (!isRecord(raw) || !isString(raw.ags) || raw.ags === "") return null;
  const rows: PlantRow[] = [];
  const list = raw.rows;
  if (isArray(list)) {
    for (const row of list) {
      if (!isArray(row)) continue;
      const kw = row[0];
      const year = row[1];
      rows.push([typeof kw === "number" ? kw : 0, typeof year === "number" ? year : 0]);
    }
  }
  const total = raw.total;
  const page = raw.page;
  return {
    ags: raw.ags,
    page: typeof page === "number" ? page : 0,
    total: typeof total === "number" ? total : undefined,
    rows,
  };
}

/** Narrows the joined pages (`msg.payload` of the build node); holes and unusable parts are skipped. */
export function parse(raw: unknown): readonly MastrPage[] {
  if (!isArray(raw)) throw new Error(`${LABEL}: joined pages are not an array`);
  const pages: MastrPage[] = [];
  for (const part of raw) {
    const page = parsePage(part);
    if (page !== null) pages.push(page);
  }
  return pages;
}

interface Aggregate {
  total: number;
  kw: number;
  got: number;
  /** Year → `[plants, kW]`. */
  readonly years: Map<number, [plants: number, kw: number]>;
}

/**
 * Pure. Sums the pages per municipality; `plantCount` is the largest `Total`
 * seen, `complete` says whether every plant was on the fetched pages. Years
 * before 2000 are pooled as 1999.
 */
export function build(
  raw: readonly MastrPage[],
  _geo: GeoIndex | null,
  now: IsoTime,
): readonly EnergyMonitorEntity[] {
  const byAgs = aggregate(raw);
  const entities: EnergyMonitorEntity[] = [];
  for (const [ags, sum] of byAgs) {
    // `Object.keys(b.years).sort()`: a string sort of the year keys.
    const additions = [...sum.years.keys()]
      .map(String)
      .sort()
      .map((key): YearAdditions => {
        const year = Number.parseInt(key, 10);
        const entry = sum.years.get(year) ?? [0, 0];
        return [year, entry[0], Math.round(entry[1])];
      });
    entities.push({
      id: `urn:ngsi-ld:EnergyMonitor:bw-${ags}`,
      type: "EnergyMonitor",
      ags: { type: "Property", value: ags },
      plantCount: observed(sum.total, "C62", now),
      installedCapacityKw: observed(Math.round(sum.kw), "KWT", now),
      additionsByYear: { type: "Property", value: additions.slice(-YEARS_KEPT), observedAt: now },
      complete: { type: "Property", value: sum.got >= sum.total },
      "@context": NGSI_CONTEXT,
    });
  }
  return entities;
}

function aggregate(pages: readonly MastrPage[]): Map<Ags, Aggregate> {
  const byAgs = new Map<Ags, Aggregate>();
  for (const part of pages) {
    let sum = byAgs.get(part.ags);
    if (sum === undefined) {
      sum = { total: 0, kw: 0, got: 0, years: new Map() };
      byAgs.set(part.ags, sum);
    }
    sum.total = Math.max(sum.total, part.total ?? 0);
    for (const [kw, year] of part.rows) {
      sum.kw += kw;
      sum.got += 1;
      const bucket = year !== 0 && year < 2000 ? 1999 : year;
      // `if (yy)`: 0 and NaN (an unparseable date) carry no year.
      if (bucket === 0 || Number.isNaN(bucket)) continue;
      const entry = sum.years.get(bucket) ?? [0, 0];
      entry[0] += 1;
      entry[1] += kw;
      sum.years.set(bucket, entry);
    }
  }
  return byAgs;
}

/** The plant counts to cache after a run: the `Total` per municipality built. */
export function countsOf(pages: readonly MastrPage[]): ReadonlyMap<Ags, number> {
  return new Map([...aggregate(pages)].map(([ags, sum]) => [ags, sum.total]));
}

/* ------------------------------------------------------------------ run */

interface RotationState {
  position: number;
  readonly counts: Map<Ags, number>;
}

/**
 * `mastrPos` / `mastrCount` of the global context, per connector context
 * (created once at startup). See the module header for what a restart does.
 */
const states = new WeakMap<Ctx, RotationState>();

export function stateOf(ctx: Ctx): RotationState {
  let state = states.get(ctx);
  if (state === undefined) {
    state = { position: 0, counts: new Map() };
    states.set(ctx, state);
  }
  return state;
}

/** At most `limit` in flight, results in item order; stops starting new ones once aborted. */
async function inOrder<T, R>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal,
  work: (item: T) => Promise<R>,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = items.map(() => undefined);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length && !signal.aborted) {
      const at = next;
      next += 1;
      const item = items[at];
      if (item !== undefined) results[at] = await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

export async function run(ctx: Ctx): Promise<void> {
  // Master data only; this connector assigns no coordinates.
  const geo = ctx.geo.forRun(LABEL, { boundaries: "optional" });
  if (geo === null) return;
  if (geo.municipalities.length === 0) {
    ctx.log.warn(`${LABEL}: master data list is empty — run skipped`);
    return;
  }
  const state = stateOf(ctx);
  const rotation = plan(geo.municipalities, state.position, state.counts);
  state.position = rotation.nextPosition;
  ctx.log.status(
    `position ${String(rotation.position)} → ${String(rotation.nextPosition)} · ` +
      `${String(rotation.requests.length)} requests`,
  );

  const answers = await inOrder(rotation.requests, MAX_IN_FLIGHT, ctx.signal, async (request) => {
    try {
      const response = await ctx.fetch.json(request.url, { retries: 0, timeoutMs: REQUEST_TIMEOUT_MS });
      return slimPage(request, response.status, response.body);
    } catch {
      return slimPage(request, null, null);
    }
  });
  const pages = answers.filter((page): page is MastrPage => page !== undefined);

  const entities = build(pages, geo, ctx.now());
  if (entities.length === 0) return;
  // Cache the plant count per municipality — it steers the pages next time.
  for (const [ags, total] of countsOf(pages)) state.counts.set(ags, total);
  ctx.log.status(`${String(entities.length)} municipalities aggregated`);
  await ctx.orion.upsert(ctx.gate.ungated(entities), { chunkSize: CHUNK_SIZE });
}

/** Checked against the contract by the compiler, as every ported module is. */
export const connector: ConnectorModule<readonly MastrPage[], readonly EnergyMonitorEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
