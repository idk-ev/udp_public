/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Municipality assignment by coordinate — port of NEAREST_HELPER and PIP_ONLY
 * from scripts/generate-nodered-flows.py.
 *
 * Almost every connector needs it: a gauge, an air quality station, a car
 * sharing bay or a road work carries a coordinate, and the dashboards are built
 * per municipality. Two steps, in this order:
 *
 *  1. **Point in polygon** over the simplified boundaries from
 *     `bw-grenzen.json`, guarded by each municipality's bounding box. This is
 *     the correct assignment and the reason the boundary cache exists.
 *  2. **Centroid fallback** — nearest municipality centre by squared distance,
 *     with longitude scaled by 0.66 (roughly cos 48.5°, the latitude of Baden-
 *     Württemberg) so that a degree of longitude is not counted as long as a
 *     degree of latitude.
 *
 * The fallback also covers the window in which `grenzen-bw` has not run yet: the
 * old helper says "Fallback nearest bleibt aktiv" and keeps assigning rather
 * than dropping the reading.
 *
 * `agsAt` is the strict variant (PIP_ONLY in the generator): polygon hit or
 * nothing. The Overpass connectors use it because a point five kilometres
 * outside every boundary is a query artefact, not a municipal amenity.
 *
 * Ported behaviour-identically, including the iteration order over the boundary
 * set: the first polygon hit wins, and `Object.keys` walks a JSON-parsed object
 * in insertion order exactly as `for (const ags in GRZ)` did. (The AGS keys look
 * numeric but start with a zero, so they are not array-index keys and are not
 * reordered.)
 */

import type { Ags, BoundarySet, GeoIndex, GeoStore, Log, MunicipalityRow } from "./types.js";

type Ring = readonly (readonly [lon: number, lat: number])[];

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
      // Only reachable on a malformed ring; the old code would have thrown here
      // and taken the whole run with it. Skipping the vertex keeps the other
      // 1,102 municipalities updating.
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

class Index implements GeoIndex {
  readonly municipalities: readonly MunicipalityRow[];
  readonly boundaries: BoundarySet | null;
  readonly #byAgs: ReadonlyMap<Ags, MunicipalityRow>;
  readonly #boundaryKeys: readonly Ags[];

  constructor(municipalities: readonly MunicipalityRow[], boundaries: BoundarySet | null) {
    this.municipalities = municipalities;
    this.boundaries = boundaries;
    this.#byAgs = new Map(municipalities.map((row) => [row[0], row]));
    this.#boundaryKeys = boundaries === null ? [] : Object.keys(boundaries);
  }

  byAgs(ags: Ags): MunicipalityRow | undefined {
    return this.#byAgs.get(ags);
  }

  agsAt(lat: number, lon: number): Ags | null {
    const boundaries = this.boundaries;
    if (boundaries === null) return null;
    for (const ags of this.#boundaryKeys) {
      const entry = boundaries[ags];
      if (entry === undefined) continue;
      const box = entry.b;
      if (lon >= box[0] && lat >= box[1] && lon <= box[2] && lat <= box[3]) {
        if (pointInRings(lat, lon, entry.r)) return ags;
      }
    }
    return null;
  }

  nearest(lat: number, lon: number): MunicipalityRow | null {
    const hit = this.agsAt(lat, lon);
    if (hit !== null) {
      const row = this.#byAgs.get(hit);
      // A polygon without a master data row falls through to the centroid
      // search, exactly as the original did (`if (row) return row;`).
      if (row !== undefined) return row;
    }

    let best: MunicipalityRow | null = null;
    let bestDistance = Infinity;
    for (const row of this.municipalities) {
      const dy = row[2] - lat;
      const dx = (row[3] - lon) * 0.66;
      const distance = dy * dy + dx * dx;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = row;
      }
    }
    return best;
  }
}

/**
 * Holds the geo context — replaces `global.get('bwGemeinden')` and
 * `global.set('bwGrenzen', …)`.
 *
 * `index()` stays `null` until `stammdaten-bw` has delivered the municipality
 * rows. That is the state the old helper answered with
 * `node.warn('bwGemeinden noch nicht im Kontext — Stammdaten-Flow abwarten')`;
 * connectors warn and skip the run rather than assigning by guesswork.
 */
class MemoryGeoStore implements GeoStore {
  readonly #log: Log;
  #municipalities: readonly MunicipalityRow[] | null = null;
  #boundaries: BoundarySet | null = null;
  #index: GeoIndex | null = null;

  constructor(log: Log) {
    this.#log = log;
  }

  setMunicipalities(rows: readonly MunicipalityRow[]): void {
    this.#municipalities = rows;
    this.#index = null;
    this.#log.debug(`geo context: ${String(rows.length)} municipalities`);
  }

  setBoundaries(boundaries: BoundarySet): void {
    this.#boundaries = boundaries;
    this.#index = null;
    this.#log.debug(`geo context: ${String(Object.keys(boundaries).length)} municipality polygons`);
  }

  index(): GeoIndex | null {
    const municipalities = this.#municipalities;
    if (municipalities === null) return null;
    // Rebuilt only after a set*, so the lookup maps and the boundary key order
    // are computed once per refresh instead of once per coordinate.
    this.#index ??= new Index(municipalities, this.#boundaries);
    return this.#index;
  }
}

export function createGeoStore(log: Log): GeoStore {
  return new MemoryGeoStore(log);
}

/** Standalone index, for the parity harness and for tests. */
export function createGeoIndex(
  municipalities: readonly MunicipalityRow[],
  boundaries: BoundarySet | null,
): GeoIndex {
  return new Index(municipalities, boundaries);
}
