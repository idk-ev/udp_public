/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `grenzen-bw` — municipality boundary cache for point-in-polygon assignment.
 *
 * Port of FN_GRENZEN from scripts/generate-nodered-flows.py. The whole connector
 * is three lines in the original, and it ingests nothing: it loads
 * `bw-grenzen.json` and puts it into the geo context, where the strict lookup
 * (STRICT_LOOKUP, src/kernel/geo.ts) reads it. Without it there is no
 * municipality assignment at all: the connectors that need one skip their runs
 * — guessing by nearest centroid instead is what put rental bikes from Basel
 * into Lörrach, and was removed for that reason.
 *
 * That is also why it is in phase 1 and why its registry entry carries a
 * `healthUrl` instead of a `sampleEntity` — there is no entity whose freshness
 * could be measured, so the health check pulls the file itself.
 *
 * `build` therefore returns the boundary set, not entities. The contract allows
 * that (`ConnectorModule<Raw, Built>`), and it keeps the pure part diffable: the
 * parity harness compares the parsed structure rather than nothing at all.
 */

import { COCKPIT_URL } from "../kernel/env.js";
import { isArray, isFiniteNumber, isRecord } from "../kernel/parse.js";
import type { BoundaryEntry, BoundarySet, ConnectorModule, Ctx, GeoIndex, IsoTime } from "../kernel/types.js";

export const ID = "grenzen-bw";

export const DEFAULT_URL = `${COCKPIT_URL}/bw-grenzen.json`;

/** Result of parsing, with the count of entries that had to be dropped. */
export interface BoundaryFile {
  readonly boundaries: BoundarySet;
  readonly skipped: number;
}

function parseRing(raw: unknown): readonly (readonly [lon: number, lat: number])[] | null {
  if (!isArray(raw)) return null;
  const points: [lon: number, lat: number][] = [];
  for (const point of raw) {
    if (!isArray(point)) return null;
    const lon = point[0];
    const lat = point[1];
    if (!isFiniteNumber(lon) || !isFiniteNumber(lat)) return null;
    points.push([lon, lat]);
  }
  return points;
}

function parseEntry(raw: unknown): BoundaryEntry | null {
  if (!isRecord(raw)) return null;
  const box = raw.b;
  if (!isArray(box) || box.length !== 4) return null;
  const [west, south, east, north] = box;
  if (!isFiniteNumber(west) || !isFiniteNumber(south) || !isFiniteNumber(east) || !isFiniteNumber(north)) {
    return null;
  }
  const rings = raw.r;
  if (!isArray(rings)) return null;
  const parsed: (readonly (readonly [lon: number, lat: number])[])[] = [];
  for (const ring of rings) {
    const points = parseRing(ring);
    if (points === null) return null;
    parsed.push(points);
  }
  return { b: [west, south, east, north], r: parsed };
}

/**
 * Lenient per entry, unlike `stammdaten-bw`.
 *
 * The original checked nothing beyond `typeof msg.payload === 'object'` and put
 * the file into the context as it came. Rejecting the whole file over one broken
 * polygon would be a harder failure than the flow ever had — 1,102 municipalities
 * would lose their exact assignment because of one. Broken entries are dropped
 * and counted instead, and the count is reported by `run`.
 */
export function parse(raw: unknown): BoundaryFile {
  if (!isRecord(raw)) throw new Error("bw-grenzen.json: expected an object keyed by AGS");
  const boundaries: Record<string, BoundaryEntry> = {};
  let skipped = 0;
  for (const [ags, value] of Object.entries(raw)) {
    const entry = parseEntry(value);
    if (entry === null) skipped += 1;
    else boundaries[ags] = entry;
  }
  return { boundaries, skipped };
}

/**
 * Pure. `now` and `geo` are unused — the boundary set is the source's own
 * structure and carries no timestamp. Kept in the signature so the module fits
 * the contract every other connector uses.
 */
export function build(raw: BoundaryFile, _geo: GeoIndex | null, _now: IsoTime): BoundarySet {
  return raw.boundaries;
}

export async function run(ctx: Ctx): Promise<void> {
  const url = ctx.env.get("UDP_BOUNDARIES_URL") ?? DEFAULT_URL;
  const response = await ctx.fetch.json(url);
  if (!response.ok || !isRecord(response.body)) {
    // Wording of the original. The previous boundaries stay in place, as the
    // old node returned before `global.set`.
    ctx.log.warn(
      `bw-grenzen.json not loadable (HTTP ${String(response.status)}) — ` +
        "connectors with strict municipality lookup skip their runs",
    );
    return;
  }

  const file = parse(response.body);
  const boundaries = build(file, null, ctx.now());
  const count = Object.keys(boundaries).length;
  if (file.skipped > 0) {
    ctx.log.warn(`bw-grenzen.json: ${String(file.skipped)} unusable entries skipped`);
  }
  if (count === 0) {
    ctx.log.warn(
      "bw-grenzen.json contained no usable polygon — connectors with strict lookup skip their runs",
    );
  }
  // Set even when empty, as the original set whatever object arrived: an empty
  // cache makes the strict connectors skip (no assignment, no prune) instead of
  // carrying on with boundaries the source no longer vouches for.
  ctx.geo.setBoundaries(boundaries, file.skipped);
  ctx.log.status(`${String(count)} municipality polygons`);
}

/** Checked against the contract by the compiler, as every ported module is. */
export const connector: ConnectorModule<BoundaryFile, BoundarySet> = { id: ID, parse, build, run };
