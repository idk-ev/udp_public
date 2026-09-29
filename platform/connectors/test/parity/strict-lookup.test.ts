/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: the strict municipality lookup — STRICT_LOOKUP as it ran in the
 * frozen flows (test/fixtures/legacy-flows.json) against `GeoIndex.agsAt` of
 * src/kernel/geo.ts.
 *
 * Almost every connector assigns coordinates with it, so it is pinned on its
 * own, on points no connector fixture would contain: points just outside the
 * state (Basel, Alsace, Neu-Ulm), points in notches of the border, points in
 * the slivers the simplification leaves between neighbouring polygons (where
 * the four-probe tolerance decides), non-finite coordinates, and a systematic
 * sweep. The old code is cut out of the pegel node verbatim and evaluated in a
 * vm; it is checked to be the same text in every node that embeds it, so
 * pinning one pins all.
 *
 * Two inputs: the trimmed boundary fixture (whose probe categories are
 * asserted, so the test cannot silently stop exercising a branch), and the full
 * gui/public/bw-grenzen.json the cockpit serves (parity only, because its
 * content changes when the file is regenerated).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseBoundaries } from "../../src/connectors/grenzen-bw.js";
import { parse as parseMunicipalities } from "../../src/connectors/stammdaten-bw.js";
import { createGeoIndex, createSharedGeo, MasterDataCheck } from "../../src/kernel/geo.js";
import type { BoundarySet, GeoIndex } from "../../src/kernel/types.js";
import { readFixture, repositoryRoot } from "../harness/fixtures.js";
import { recordingLog } from "../harness/kernel.js";
import { normalize } from "../harness/normalize.js";
import { evaluateSnippet, extractSnippet, functionNodesContaining } from "../harness/vm-runner.js";

/** PEGELONLINE node: embeds STRICT_LOOKUP directly, without the geo_helper prelude. */
const NODE_ID = "udp-rt-pe-fn";
const START = "const pip = (lat, lon, rings) => {";
const END = "    return best;\n};";

type Point = readonly [lat: number, lon: number];

const NAMED: readonly (readonly [label: string, lat: number, lon: number])[] = [
  ["Freiburg, Muenster", 47.9956, 7.8522],
  ["Loerrach, centre", 47.6156, 7.6614],
  ["Kehl, Rhine bridge (German bank)", 48.5716, 7.8103],
  ["Strasbourg, cathedral", 48.5818, 7.7509],
  ["Basel, Marktplatz", 47.5582, 7.5878],
  ["Mulhouse", 47.7508, 7.3359],
  ["Colmar", 48.0794, 7.3585],
  ["Rheinfelden (Schweiz)", 47.5541, 7.7934],
  ["Neu-Ulm", 48.3923, 10.0112],
  ["Ludwigshafen", 49.4774, 8.4452],
  ["Stuttgart (inside the box, no polygon in the fixture)", 48.7758, 9.1829],
  ["Zurich (outside the box)", 47.3769, 8.5417],
];

const NON_FINITE: readonly Point[] = [
  [Number.NaN, 7.8],
  [48, Number.NaN],
  [Number.POSITIVE_INFINITY, 7.8],
  [48, Number.NEGATIVE_INFINITY],
];

function strictLookupSource(): string {
  return extractSnippet(NODE_ID, START, END);
}

/**
 * Points on both sides of polygon edges: the midpoint of every `step`-th edge,
 * pushed perpendicular by each offset. That is where slivers, notches and the
 * state border are — a plain grid would hit them only by luck.
 */
function edgePoints(boundaries: BoundarySet, step: number, offsets: readonly number[]): Point[] {
  const points: Point[] = [];
  let edge = 0;
  for (const entry of Object.values(boundaries)) {
    for (const ring of entry.r) {
      for (let i = 1; i < ring.length; i += 1) {
        edge += 1;
        if (edge % step !== 0) continue;
        const a = ring[i - 1];
        const b = ring[i];
        if (a === undefined || b === undefined) continue;
        const dLon = b[0] - a[0];
        const dLat = b[1] - a[1];
        const length = Math.hypot(dLon, dLat);
        if (length === 0) continue;
        const midLon = (a[0] + b[0]) / 2;
        const midLat = (a[1] + b[1]) / 2;
        for (const offset of offsets) {
          points.push([midLat + (dLon / length) * offset, midLon - (dLat / length) * offset]);
        }
      }
    }
  }
  return points;
}

function gridPoints(boundaries: BoundarySet, step: number): Point[] {
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const entry of Object.values(boundaries)) {
    west = Math.min(west, entry.b[0]);
    south = Math.min(south, entry.b[1]);
    east = Math.max(east, entry.b[2]);
    north = Math.max(north, entry.b[3]);
  }
  const points: Point[] = [];
  for (let lat = south - 0.02; lat <= north + 0.02; lat += step) {
    for (let lon = west - 0.02; lon <= east + 0.02; lon += step) points.push([lat, lon]);
  }
  return points;
}

function legacyLookup(rawBoundaries: unknown, points: readonly Point[]): unknown {
  return normalize(
    evaluateSnippet(
      strictLookupSource(),
      { GRZ: rawBoundaries, PROBES: points },
      "PROBES.map((p) => agsStrict(p[0], p[1]))",
    ),
  );
}

function portedLookup(index: GeoIndex, points: readonly Point[]): (string | null)[] {
  return points.map(([lat, lon]) => index.agsAt(lat, lon));
}

function firstDifference(
  legacy: unknown,
  ported: readonly (string | null)[],
  points: readonly Point[],
): string {
  if (!Array.isArray(legacy)) return "legacy result is not an array";
  for (let i = 0; i < points.length; i += 1) {
    if (legacy[i] !== ported[i]) {
      const point = points[i];
      return `point ${String(i)} ${JSON.stringify(point)}: old ${JSON.stringify(legacy[i])} vs new ${JSON.stringify(ported[i])}`;
    }
  }
  return legacy.length === ported.length ? "" : `length ${String(legacy.length)} vs ${String(ported.length)}`;
}

function snippetIsTheSameEverywhere(): void {
  const source = strictLookupSource();
  const nodes = functionNodesContaining("const agsStrict = (lat, lon) =>");
  assert.ok(nodes.length >= 10, `expected STRICT_LOOKUP in many nodes, found ${String(nodes.length)}`);
  for (const node of nodes) {
    assert.ok(node.func.includes(source), `${node.id} (${node.name}) carries a different STRICT_LOOKUP`);
  }
}

function fixtureProbesMatchAndCoverEveryBranch(): void {
  const raw = readFixture("grenzen-bw").payload;
  const boundaries = parseBoundaries(raw).boundaries;
  const rows = parseMunicipalities(readFixture("stammdaten-bw").payload).gemeinden;
  const index = createGeoIndex(rows, boundaries);

  const named = NAMED.map(([, lat, lon]): Point => [lat, lon]);
  const points: Point[] = [
    ...named,
    ...NON_FINITE,
    ...edgePoints(boundaries, 3, [0.0004, -0.0004, 0.0015, -0.0015, 0.004, -0.004]),
    ...gridPoints(boundaries, 0.04),
  ];
  const legacy = legacyLookup(raw, points);
  const ported = portedLookup(index, points);
  assert.equal(firstDifference(legacy, ported, points), "", "strict lookup differs");

  // Named expectations, stated absolutely — these are facts about the map.
  const byLabel = new Map(NAMED.map(([label], i) => [label, ported[i]]));
  assert.equal(byLabel.get("Freiburg, Muenster"), "08311000");
  for (const label of [
    "Strasbourg, cathedral",
    "Basel, Marktplatz",
    "Mulhouse",
    "Colmar",
    "Neu-Ulm",
    "Ludwigshafen",
  ]) {
    assert.equal(byLabel.get(label), null, `${label} must not be assigned to a BW municipality`);
  }
  for (const [lat, lon] of NON_FINITE) assert.equal(index.agsAt(lat, lon), null);

  // Every branch must actually be exercised, or the parity above proves less
  // than it claims. Classified from RAW polygon hits — the old `pipAgs` (no
  // tolerance) on the point and its four probes — not from the code under
  // test. On that raw data the rule is stated independently as well: a point
  // outside every polygon is assigned iff all four probes hit one.
  const finite = points.filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
  const hitsByPoint = rawHits(raw, finite);
  let direct = 0;
  let tolerated = 0;
  let splitVote = 0;
  let rejectedAtEdge = 0;
  finite.forEach(([lat, lon], i) => {
    const hits = hitsByPoint[i];
    assert.ok(hits !== undefined);
    const [centre, ...probes] = hits;
    const result = index.agsAt(lat, lon);
    if (centre !== null) {
      direct += 1;
      assert.equal(result, centre, `direct hit at ${String(lat)}, ${String(lon)}`);
      return;
    }
    const allProbesHit = probes.every((probe) => probe !== null);
    assert.equal(result !== null, allProbesHit, `tolerance rule at ${String(lat)}, ${String(lon)}`);
    if (allProbesHit) {
      tolerated += 1;
      if (new Set(probes).size > 1) splitVote += 1;
    } else if (probes.some((probe) => probe !== null)) {
      rejectedAtEdge += 1;
    }
  });
  assert.ok(direct > 100, `direct polygon hits: ${String(direct)}`);
  assert.ok(tolerated > 0, "no point in a sliver between polygons was accepted by the tolerance");
  assert.ok(splitVote > 0, "no sliver point with disagreeing probes (majority vote) was exercised");
  assert.ok(rejectedAtEdge > 0, "no point just outside the covered area (notch, border) was rejected");
}

/**
 * `[centre, north, south, east, west]` first polygon hits per point, from the
 * old `pipAgs` in the vm — independent of src/kernel/geo.ts.
 */
function rawHits(rawBoundaries: unknown, points: readonly Point[]): (string | null)[][] {
  const result = evaluateSnippet(
    strictLookupSource(),
    { GRZ: rawBoundaries, PROBES: points },
    "PROBES.map((p) => [pipAgs(p[0], p[1]), pipAgs(p[0] + 0.003, p[1]), pipAgs(p[0] - 0.003, p[1]), " +
      "pipAgs(p[0], p[1] + 0.0045), pipAgs(p[0], p[1] - 0.0045)])",
  );
  const rows = normalize(result);
  assert.ok(Array.isArray(rows));
  return rows.map((row) => {
    assert.ok(Array.isArray(row));
    return row.map((hit) => (typeof hit === "string" ? hit : null));
  });
}

function fullBoundaryFileMatches(): void {
  const root = repositoryRoot();
  const raw: unknown = JSON.parse(readFileSync(join(root, "gui", "public", "bw-grenzen.json"), "utf8"));
  const rowsRaw: unknown = JSON.parse(readFileSync(join(root, "gui", "public", "bw-gemeinden.json"), "utf8"));
  const boundaries = parseBoundaries(raw).boundaries;
  const index = createGeoIndex(parseMunicipalities(rowsRaw).gemeinden, boundaries);
  const points: Point[] = [
    ...NAMED.map(([, lat, lon]): Point => [lat, lon]),
    ...edgePoints(boundaries, 41, [0.0004, -0.0004, 0.002, -0.002]),
    ...gridPoints(boundaries, 0.08),
  ];
  const legacy = legacyLookup(raw, points);
  const ported = portedLookup(index, points);
  assert.equal(
    firstDifference(legacy, ported, points),
    "",
    "strict lookup differs on the full boundary file",
  );
}

function forRunSkipsWithoutBoundariesUnlessOptional(): void {
  const rows = parseMunicipalities(readFixture("stammdaten-bw").payload).gemeinden;
  const shared = createSharedGeo(recordingLog());
  const log = recordingLog();
  const geo = shared.view(log, new MasterDataCheck());

  assert.equal(geo.forRun("Test"), null, "no master data: skip");
  assert.match(log.warnings()[0] ?? "", /^Test: bwGemeinden not in context yet/);

  shared.setMunicipalities(rows);
  assert.equal(geo.forRun("Test"), null, "no boundaries: skip by default");
  assert.match(
    log.warnings()[1] ?? "",
    /^Test: municipality boundaries \(bwGrenzen\) not loaded — run skipped/,
  );

  const lenient = geo.forRun("Test", { boundaries: "optional" });
  assert.ok(lenient !== null);
  assert.equal(
    lenient.agsAt(47.9956, 7.8522),
    null,
    "without boundaries nothing is assigned, nothing guessed",
  );
  assert.equal(log.warnings().length, 2);

  shared.setBoundaries(parseBoundaries(readFixture("grenzen-bw").payload).boundaries, 0);
  assert.equal(geo.forRun("Test")?.municipalityAt(47.9956, 7.8522)?.[1], "Freiburg im Breisgau");
}

export {
  snippetIsTheSameEverywhere as "strict lookup: STRICT_LOOKUP is the same text in every function node that embeds it",
  fixtureProbesMatchAndCoverEveryBranch as "strict lookup: old STRICT_LOOKUP and GeoIndex.agsAt agree on border, notch, sliver and grid probes",
  fullBoundaryFileMatches as "strict lookup: old and new agree on the full gui/public/bw-grenzen.json",
  forRunSkipsWithoutBoundariesUnlessOptional as "strict lookup: forRun skips with a warning unless boundaries are declared optional",
};
