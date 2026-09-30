/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Municipality assignment by coordinate — port of STRICT_LOOKUP and the
 * `geo_helper` prelude from the former Node-RED flow generator (see git history).
 *
 * Almost every connector needs it: a gauge, an air quality station, a car
 * sharing bay or a road work carries a coordinate, and the dashboards are built
 * per municipality.
 *
 * ## Strict: polygon or nothing
 *
 * A point that lies in no municipality polygon belongs to no BW municipality.
 * The former helper (NEAREST_HELPER) fell back to the nearest municipality
 * centroid, so points outside Baden-Württemberg — Basel, Alsace, the
 * Palatinate, Bavaria — were silently counted in the nearest BW municipality,
 * and without boundaries EVERY point was assigned by centroid. That fallback is
 * gone from the kernel on purpose; see `GeoIndex` in types.ts.
 *
 * ## Sliver tolerance
 *
 * The boundaries in `bw-grenzen.json` are simplified, which leaves thin slivers
 * between neighbouring polygons (on a 1 km grid over BW roughly 0.3 % of the
 * points fall into such gaps). A point without a polygon hit is still accepted
 * if four probes ~330 m to the north, south, east and west ALL hit a polygon;
 * it gets the municipality most probes agree on (ties: the first probe's in
 * N, S, E, W order). A point outside the state has BW polygons on one side at
 * most and is rejected — unless it sits in a notch or enclave narrower than
 * ~660 m.
 *
 * ## Without boundaries
 *
 * No boundaries, no assignment: every lookup answers `null`. Whether the run
 * then goes ahead is the connector's declared choice (`GeoRequirements`), and
 * the default is to skip it with a warning — guessing by centroid is exactly
 * the bug this replaced.
 *
 * Ported behaviour-identically, including the iteration order over the boundary
 * set: the first polygon hit wins, and `Object.keys` walks a JSON-parsed object
 * in insertion order exactly as `for (const a in GRZ)` did. (The AGS keys look
 * numeric but start with a zero, so they are not array-index keys and are not
 * reordered.) test/parity/strict-lookup.test.ts pins it against the old JS.
 */

import type { Ags, BoundarySet, GeoIndex, GeoRequirements, GeoStore, Log, MunicipalityRow } from "./types.js";

type Ring = readonly (readonly [lon: number, lat: number])[];

type Box = readonly [west: number, south: number, east: number, north: number];

/** Probe offsets `[dy, dx]` in degrees: ~330 m north, south, east, west at 48.5° N. */
const PROBES: readonly (readonly [dLat: number, dLon: number])[] = [
  [0.003, 0],
  [-0.003, 0],
  [0, 0.0045],
  [0, -0.0045],
];

/** Margin around the union of all boxes before the cheap reject. */
const BOX_MARGIN = 0.01;

/**
 * Ray casting. Rings carry `[lon, lat]` pairs, so x is longitude and y is
 * latitude — the axis swap against the `(lat, lon)` argument order is the one
 * place in this file worth re-reading before changing anything.
 */
export function pointInRings(lat: number, lon: number, rings: readonly Ring[]): boolean {
  for (const ring of rings) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const a = ring[i];
      const b = ring[j];
      // Only reachable on a malformed ring, and grenzen-bw's parser rejects
      // those; the old code would have thrown here and taken the run with it.
      if (a === undefined || b === undefined) continue;
      const xi = a[0];
      const yi = a[1];
      const xj = b[0];
      const yj = b[1];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

/** Union of all polygon bounding boxes (`BW_BOX`): cheap reject for points far outside BW. */
function unionBox(boundaries: BoundarySet | null, keys: readonly Ags[]): Box {
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  if (boundaries !== null) {
    for (const ags of keys) {
      const entry = boundaries[ags];
      if (entry === undefined) continue;
      const box = entry.b;
      if (box[0] < west) west = box[0];
      if (box[1] < south) south = box[1];
      if (box[2] > east) east = box[2];
      if (box[3] > north) north = box[3];
    }
  }
  return [west, south, east, north];
}

class Index implements GeoIndex {
  readonly municipalities: readonly MunicipalityRow[];
  readonly boundaries: BoundarySet | null;
  readonly hasBoundaries: boolean;
  readonly #byAgs: ReadonlyMap<Ags, MunicipalityRow>;
  readonly #boundaryKeys: readonly Ags[];
  readonly #box: Box;

  constructor(municipalities: readonly MunicipalityRow[], boundaries: BoundarySet | null) {
    this.municipalities = municipalities;
    this.boundaries = boundaries;
    this.#byAgs = new Map(municipalities.map((row) => [row[0], row]));
    this.#boundaryKeys = boundaries === null ? [] : Object.keys(boundaries);
    this.hasBoundaries = this.#boundaryKeys.length > 0;
    this.#box = unionBox(boundaries, this.#boundaryKeys);
  }

  byAgs(ags: Ags): MunicipalityRow | undefined {
    return this.#byAgs.get(ags);
  }

  /** `pipAgs`: the first polygon containing the point, no tolerance. */
  #polygonAt(boundaries: BoundarySet, lat: number, lon: number): Ags | null {
    for (const ags of this.#boundaryKeys) {
      const entry = boundaries[ags];
      if (entry === undefined) continue;
      const box = entry.b;
      if (
        lon >= box[0] &&
        lat >= box[1] &&
        lon <= box[2] &&
        lat <= box[3] &&
        pointInRings(lat, lon, entry.r)
      ) {
        return ags;
      }
    }
    return null;
  }

  agsAt(lat: number, lon: number): Ags | null {
    const boundaries = this.boundaries;
    if (boundaries === null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const box = this.#box;
    if (
      lon < box[0] - BOX_MARGIN ||
      lat < box[1] - BOX_MARGIN ||
      lon > box[2] + BOX_MARGIN ||
      lat > box[3] + BOX_MARGIN
    ) {
      return null;
    }
    const hit = this.#polygonAt(boundaries, lat, lon);
    if (hit !== null) return hit;

    const votes = new Map<Ags, number>();
    let best: Ags | null = null;
    for (const [dLat, dLon] of PROBES) {
      const probe = this.#polygonAt(boundaries, lat + dLat, lon + dLon);
      // One probe outside every polygon: the point is at the edge of the
      // covered area, not in a sliver between two municipalities.
      if (probe === null) return null;
      const count = (votes.get(probe) ?? 0) + 1;
      votes.set(probe, count);
      if (best === null || count > (votes.get(best) ?? 0)) best = probe;
    }
    return best;
  }

  municipalityAt(lat: number, lon: number): MunicipalityRow | null {
    const ags = this.agsAt(lat, lon);
    return ags === null ? null : (this.#byAgs.get(ags) ?? null);
  }
}

/**
 * The plausibility of the master data for pruning (PRUNE_OK_JS). Kept per
 * connector, as the old node context was per function node; evaluated both by
 * `GeoStore.forRun` (where the old prelude computed it) and by the pruner.
 *
 * ## The reference count after a restart
 *
 * The 95 % ratchet compares against the last plausible count (`gemCount` in
 * the node context). Under Compose that context survived restarts
 * (`contextStorage: localfilesystem`); here it is persisted with the prune
 * bookkeeping (src/kernel/persistence.ts: {@link snapshot} / {@link restore}).
 * Where none was persisted yet it would start at 0, and a truncated
 * municipality file arriving right then — 1,020 of 1,101 rows, say — would
 * pass as plausible and let every prune delete the entities of the missing
 * municipalities. So a missing reference is SEEDED once from the number of
 * `Municipality` entities in Orion (what `stammdaten-bw` wrote) before the
 * check gives any verdict; until the seed is in, the answer is `false` and no
 * bookkeeping happens.
 */
export class MasterDataCheck {
  /** `context.get('gemCount')`; `null` until seeded or restored. */
  #lastCount: number | null = null;
  #onChange: () => void = () => undefined;

  get seeded(): boolean {
    return this.#lastCount !== null;
  }

  /** Sets the reference once; later calls are ignored (the ratchet owns it then). */
  seed(count: number): void {
    if (this.#lastCount !== null) return;
    this.#lastCount = count;
    this.#onChange();
  }

  /** The reference, for the persistence. */
  snapshot(): number | null {
    return this.#lastCount;
  }

  /** The persisted reference; `null` = none persisted, seed from Orion again. */
  restore(count: number | null): void {
    this.#lastCount = count;
  }

  /** Called whenever the reference changes (kernel-internal: the persistence). */
  onChange(listener: () => void): void {
    this.#onChange = listener;
  }

  /**
   * At least 1,000 municipalities, not fewer than 95 % of the last plausible
   * count, and boundaries for at least 99 % of their AGS — checked by key, not
   * by count, so a boundary file of the right size but for the wrong
   * municipalities does not pass. Deleting entities relies on the master data
   * being complete; a truncated file would otherwise make every municipality
   * beyond the cut look "no longer produced".
   *
   * `boundariesDegraded` (the parser dropped an entry) fails it as well —
   * stricter than the old code in wording only: the old node stored the broken
   * entry and crashed on it, so it never reached a prune either.
   *
   * Idempotent within one state of the geo context, so evaluating it twice in
   * one run changes nothing.
   */
  evaluate(
    municipalities: readonly MunicipalityRow[] | null,
    boundaries: BoundarySet | null,
    boundariesDegraded: boolean,
  ): boolean {
    const previous = this.#lastCount;
    if (previous === null || municipalities === null) return false;
    const count = municipalities.length;
    if (count < 1000 || count < previous * 0.95) return false;
    if (count !== previous) {
      this.#lastCount = count;
      this.#onChange();
    }
    if (boundaries === null || boundariesDegraded) return false;
    let covered = 0;
    for (const row of municipalities) if (boundaries[row[0]] !== undefined) covered += 1;
    return covered >= count * 0.99;
  }
}

/**
 * The shared geo context — replaces `global.get('bwGemeinden')` and
 * `global.set('bwGrenzen', …)`. The kernel's geo bootstrap
 * (src/kernel/geo-bootstrap.ts) fills it at startup and every 6 h, and so do
 * `stammdaten-bw` and `grenzen-bw` when they run here — same files, same
 * parsers, last write wins. Every other connector reads it through its own
 * {@link GeoStore} view.
 */
export class SharedGeo {
  readonly #log: Log;
  #municipalities: readonly MunicipalityRow[] | null = null;
  #boundaries: BoundarySet | null = null;
  #boundariesDegraded = false;
  #index: Index | null = null;

  constructor(log: Log) {
    this.#log = log;
  }

  get municipalities(): readonly MunicipalityRow[] | null {
    return this.#municipalities;
  }

  get boundaries(): BoundarySet | null {
    return this.#boundaries;
  }

  /** The parser dropped at least one polygon of the current boundary set. */
  get boundariesDegraded(): boolean {
    return this.#boundariesDegraded;
  }

  setMunicipalities(rows: readonly MunicipalityRow[]): void {
    this.#municipalities = rows;
    this.#index = null;
    this.#log.debug(`geo context: ${String(rows.length)} municipalities`);
  }

  setBoundaries(boundaries: BoundarySet, skippedEntries: number): void {
    this.#boundaries = boundaries;
    this.#boundariesDegraded = skippedEntries > 0;
    this.#index = null;
    this.#log.debug(
      `geo context: ${String(Object.keys(boundaries).length)} municipality polygons` +
        (skippedEntries > 0 ? `, ${String(skippedEntries)} dropped (degraded: no prune)` : ""),
    );
  }

  /**
   * Rebuilt only after a set*, so the lookup maps, the key order and the union
   * box are computed once per refresh instead of once per coordinate.
   */
  index(): GeoIndex {
    this.#index ??= new Index(this.#municipalities ?? [], this.#boundaries);
    return this.#index;
  }

  /** The per-connector view handed out as `ctx.geo`. */
  view(log: Log, masterData: MasterDataCheck): GeoStore {
    return new GeoView(this, log, masterData);
  }
}

class GeoView implements GeoStore {
  readonly #shared: SharedGeo;
  readonly #log: Log;
  readonly #masterData: MasterDataCheck;

  constructor(shared: SharedGeo, log: Log, masterData: MasterDataCheck) {
    this.#shared = shared;
    this.#log = log;
    this.#masterData = masterData;
  }

  setMunicipalities(rows: readonly MunicipalityRow[]): void {
    this.#shared.setMunicipalities(rows);
  }

  setBoundaries(boundaries: BoundarySet, skippedEntries: number): void {
    this.#shared.setBoundaries(boundaries, skippedEntries);
  }

  /** The checks of `geo_helper`, in its order. */
  forRun(label: string, requirements?: GeoRequirements): GeoIndex | null {
    const municipalities = this.#shared.municipalities;
    if (municipalities === null && requirements?.municipalities !== "optional") {
      this.#log.warn(`${label}: bwGemeinden not in context yet — waiting for the master data flow`);
      return null;
    }
    // PRUNE_OK is computed here in the old prelude — after the master data
    // check, before the boundary check — so its bookkeeping advances on every
    // run that gets this far, including runs skipped for missing boundaries.
    // (Not before the reference is seeded from Orion; see MasterDataCheck.)
    this.#masterData.evaluate(municipalities, this.#shared.boundaries, this.#shared.boundariesDegraded);
    const index = this.#shared.index();
    if (!index.hasBoundaries && requirements?.boundaries !== "optional") {
      this.#log.warn(
        `${label}: municipality boundaries (bwGrenzen) not loaded — run skipped instead of assigning by centroid`,
      );
      return null;
    }
    return index;
  }
}

export function createSharedGeo(log: Log): SharedGeo {
  return new SharedGeo(log);
}

/** Standalone index, for the parity harness and for tests. */
export function createGeoIndex(
  municipalities: readonly MunicipalityRow[],
  boundaries: BoundarySet | null,
): GeoIndex {
  return new Index(municipalities, boundaries);
}
