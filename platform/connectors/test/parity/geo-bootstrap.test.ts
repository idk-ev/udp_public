/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The kernel's geo bootstrap (src/kernel/geo-bootstrap.ts): the service loads
 * `bw-gemeinden.json` and `bw-grenzen.json` itself, so the geo-dependent
 * connectors run here while `stammdaten-bw` / `grenzen-bw` still run in
 * Node-RED.
 *
 * Real kernel services throughout (shared geo, change gate, Orion client,
 * pruner, a real connector module); only the network is scripted and the
 * reload timer is captured, so a test fires the next load itself instead of
 * waiting 5 minutes or 6 hours.
 */

import assert from "node:assert/strict";
import { GEO_SOURCES } from "../../src/connectors/index.js";
import { DEFAULT_URL as BOUNDARIES_URL, parse as parseBoundaries } from "../../src/connectors/grenzen-bw.js";
import { run as runPegel } from "../../src/connectors/pegel-bw.js";
import {
  DEFAULT_URL as MUNICIPALITIES_URL,
  parse as parseMunicipalities,
} from "../../src/connectors/stammdaten-bw.js";
import { adminRoutes } from "../../src/kernel/admin.js";
import { SignatureStore } from "../../src/kernel/change-gate.js";
import { createCtx, startGeoBootstrap } from "../../src/kernel/context.js";
import type { Kernel } from "../../src/kernel/context.js";
import { createDb } from "../../src/kernel/db.js";
import { createSharedGeo } from "../../src/kernel/geo.js";
import {
  createGeoBootstrap,
  GEO_REFRESH_MS,
  GEO_RETRY_EMPTY_MS,
  geoHealth,
} from "../../src/kernel/geo-bootstrap.js";
import type { GeoBootstrap, GeoTimer } from "../../src/kernel/geo-bootstrap.js";
import { createHttpServer } from "../../src/kernel/http.js";
import { createRegistry } from "../../src/kernel/registry.js";
import { createScheduler } from "../../src/kernel/scheduler.js";
import { StateStore } from "../../src/kernel/state.js";
import type { BoundarySet, Ctx, Env, HttpResponse, MunicipalityRow } from "../../src/kernel/types.js";
import { readFixture } from "../harness/fixtures.js";
import { httpResponse, recordingLog, scriptedFetcher } from "../harness/kernel.js";
import type { RecordedLog, SeenRequest } from "../harness/kernel.js";
import { isRecord } from "../harness/normalize.js";
import type { FixtureGeo } from "../harness/water-warnings-rig.js";
import {
  fixtureGeo,
  fullGeo,
  passThroughLimiter,
  registryEntry,
  upsertBodies,
} from "../harness/water-warnings-rig.js";

/** An environment with exactly these variables (the process env must not leak in). */
function fakeEnv(values: Readonly<Record<string, string>> = {}): Env {
  return {
    get: (name) => values[name],
    require: (name) => {
      const value = values[name];
      if (value === undefined) throw new Error(`environment variable ${name} is not set`);
      return value;
    },
    number: (_name, fallback) => fallback,
    flag: (_name, fallback) => fallback,
  };
}

interface CapturedTimer {
  readonly ms: number;
  readonly fire: () => Promise<void>;
  cancelled: boolean;
}

interface Rig {
  readonly kernel: Kernel;
  readonly bootstrap: GeoBootstrap;
  /** A real connector's ctx on the same kernel (pegel-bw: strict lookup, gated upsert). */
  readonly ctx: Ctx;
  readonly log: RecordedLog;
  readonly seen: SeenRequest[];
  readonly timers: CapturedTimer[];
  /** What the cockpit answers for the two files; change it between loads. */
  readonly serve: { municipalities: HttpResponse | Error; boundaries: HttpResponse | Error };
}

function json(body: unknown): HttpResponse {
  return httpResponse(200, JSON.stringify(body));
}

function servedFiles(geo: FixtureGeo): { municipalities: HttpResponse; boundaries: HttpResponse } {
  return { municipalities: json({ gemeinden: geo.rawRows }), boundaries: json(geo.rawBoundaries) };
}

function geoRig(geo: FixtureGeo = fixtureGeo()): Rig {
  const log = recordingLog();
  const env = fakeEnv();
  const serve: Rig["serve"] = servedFiles(geo);
  const pegel = readFixture("pegel-bw").payload;
  const municipalityCount = geo.rows.length;
  const { fetcher, seen } = scriptedFetcher((request) => {
    const url = request.url.href;
    if (url === MUNICIPALITIES_URL) return serve.municipalities;
    if (url === BOUNDARIES_URL) return serve.boundaries;
    if (request.url.host === "www.pegelonline.wsv.de") return json(pegel);
    // Orion: the Municipality count seeds the prune's 95 % reference.
    if (request.method === "GET" && request.url.searchParams.get("type") === "Municipality") {
      return httpResponse(200, "[]", { "ngsild-results-count": String(municipalityCount) });
    }
    return httpResponse(204);
  });
  const timers: CapturedTimer[] = [];
  const timer: GeoTimer = (callback, ms) => {
    const entry: CapturedTimer = { ms, fire: callback, cancelled: false };
    timers.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const clock = { now: Date.parse("2026-09-29T06:00:00Z") };
  const shared = createSharedGeo(log);
  const shutdown = new AbortController();
  const bootstrap = createGeoBootstrap({
    log,
    fetch: fetcher,
    geo: shared,
    env,
    sources: GEO_SOURCES,
    nowMs: () => clock.now,
    signal: shutdown.signal,
    timer,
  });
  const entry = registryEntry("pegel-bw");
  const kernel: Kernel = {
    log,
    env,
    limiter: passThroughLimiter,
    fetch: fetcher,
    orionUrl: "http://orion-ld:1026",
    signatures: new SignatureStore(),
    state: new StateStore(),
    geo: shared,
    geoBootstrap: bootstrap,
    registry: createRegistry([entry]),
    publicHttp: createHttpServer(log),
    adminHttp: createHttpServer(log),
    scheduler: createScheduler(log, () => clock.now),
    db: createDb(env),
    shutdown,
    nowMs: () => clock.now,
  };
  return { kernel, bootstrap, ctx: createCtx(kernel, entry), log, seen, timers, serve };
}

// Read through functions: a narrowing assert on a getter would stick.
function rowsOf(r: Rig): readonly MunicipalityRow[] | null {
  return r.kernel.geo.municipalities;
}

function boundariesOf(r: Rig): BoundarySet | null {
  return r.kernel.geo.boundaries;
}

function degradedOf(r: Rig): boolean {
  return r.kernel.geo.boundariesDegraded;
}

function cockpitRequests(seen: readonly SeenRequest[]): string[] {
  return seen.filter((request) => request.url.host === "cockpit:8080").map((request) => request.url.href);
}

function lastTimer(r: Rig): CapturedTimer {
  const timer = r.timers.at(-1);
  assert.ok(timer !== undefined, "no reload scheduled");
  return timer;
}

/** `/healthz` as the admin route answers it, parsed. */
async function healthz(kernel: Kernel): Promise<Record<string, unknown>> {
  const route = adminRoutes(kernel, { version: "test", started: 0, cooldownMs: 60_000 }).find(
    (candidate) => candidate.path === "/healthz",
  );
  assert.ok(route !== undefined);
  const response = await route.handle({
    method: "GET",
    path: "/healthz",
    query: new URLSearchParams(),
    params: {},
    headers: {},
    body: "",
  });
  assert.equal(response.status, 200);
  const body: unknown = JSON.parse(response.body);
  assert.ok(isRecord(body));
  return body;
}

/* ── tests ───────────────────────────────────────────────────────────────────*/

async function fillsTheContextBeforeTheFirstRun(): Promise<void> {
  const r = geoRig();
  assert.equal(rowsOf(r), null);

  await startGeoBootstrap(r.kernel, 1);

  // Filled by the time startGeoBootstrap resolves, i.e. before scheduler.start().
  assert.equal(rowsOf(r)?.length, 167);
  const boundaries = boundariesOf(r);
  assert.ok(boundaries !== null);
  assert.equal(Object.keys(boundaries).length, 167);
  assert.equal(degradedOf(r), false);
  // Exactly the two files — nothing to Orion, no Municipality upsert.
  assert.deepEqual(cockpitRequests(r.seen).sort(), [BOUNDARIES_URL, MUNICIPALITIES_URL].sort());
  assert.equal(r.seen.length, 2);
  assert.deepEqual(r.log.warnings(), []);
  assert.ok(r.log.lines.some((line) => line.text === "geo context loaded: 167 municipalities, 167 polygons"));
  // Complete context: the next load in 6 h.
  assert.equal(r.timers.length, 1);
  assert.equal(lastTimer(r).ms, GEO_REFRESH_MS);

  const health = await healthz(r.kernel);
  assert.deepEqual(health.geo, geoHealth(r.kernel.geo, r.bootstrap));
  const geo = health.geo;
  assert.ok(isRecord(geo));
  assert.equal(geo.municipalities, 167);
  assert.equal(geo.boundaries, 167);
  assert.equal(geo.boundariesDegraded, false);
  assert.ok(isRecord(geo.bootstrap));
  assert.equal(geo.bootstrap.active, true);
  assert.equal(
    geo.bootstrap.nextLoadAt,
    new Date(Date.parse("2026-09-29T06:00:00Z") + GEO_REFRESH_MS).toISOString(),
  );
  assert.ok(isRecord(geo.bootstrap.municipalities));
  assert.equal(geo.bootstrap.municipalities.loadedAt, "2026-09-29T06:00:00.000Z");
  assert.equal(geo.bootstrap.municipalities.error, null);
  assert.equal(geo.bootstrap.municipalities.url, MUNICIPALITIES_URL);

  // A second start is a no-op; stop cancels the pending reload.
  await r.bootstrap.start();
  assert.equal(r.seen.length, 2);
  r.bootstrap.stop();
  assert.equal(lastTimer(r).cancelled, true);
  assert.equal(r.bootstrap.active, false);
}

async function noAppConnectorNoRequest(): Promise<void> {
  const r = geoRig();
  await startGeoBootstrap(r.kernel, 0);
  assert.equal(r.seen.length, 0, "the service must stay idle without a runtime=app connector");
  assert.equal(r.timers.length, 0);
  assert.equal(r.bootstrap.active, false);
  assert.equal(rowsOf(r), null);
  assert.equal(boundariesOf(r), null);
  const health = await healthz(r.kernel);
  const geo = health.geo;
  assert.ok(isRecord(geo));
  assert.equal(geo.municipalities, null);
  assert.ok(isRecord(geo.bootstrap));
  assert.equal(geo.bootstrap.active, false);
  assert.equal(geo.bootstrap.nextLoadAt, null);
}

async function failedLoadKeepsTheContextAndRetries(): Promise<void> {
  const r = geoRig();
  const good = servedFiles(fixtureGeo());
  r.serve.municipalities = httpResponse(503, "busy");
  r.serve.boundaries = new Error("connect ECONNREFUSED cockpit:8080");

  // Cockpit not up yet: one warning per file, nothing set, retry in 5 min.
  await startGeoBootstrap(r.kernel, 1);
  assert.equal(rowsOf(r), null);
  assert.equal(boundariesOf(r), null);
  assert.deepEqual(r.log.warnings(), [
    "geo bootstrap: bw-gemeinden.json not loadable (HTTP 503) — no municipality rows yet, geo-dependent connectors skip their runs",
    "geo bootstrap: bw-grenzen.json not loadable (connect ECONNREFUSED cockpit:8080) — no boundaries yet, connectors with strict lookup skip their runs",
  ]);
  assert.equal(lastTimer(r).ms, GEO_RETRY_EMPTY_MS);

  // Still failing: same streak, no second warning, again 5 min.
  await lastTimer(r).fire();
  assert.equal(r.seen.length, 4);
  assert.equal(r.log.warnings().length, 2);
  assert.equal(lastTimer(r).ms, GEO_RETRY_EMPTY_MS);

  // Only the municipalities come back: still incomplete, still 5 min.
  r.serve.municipalities = good.municipalities;
  await lastTimer(r).fire();
  assert.equal(rowsOf(r)?.length, 167);
  assert.equal(boundariesOf(r), null);
  assert.equal(lastTimer(r).ms, GEO_RETRY_EMPTY_MS);

  // Both loadable: filled, recovery logged once per file, back to 6 h.
  r.serve.boundaries = good.boundaries;
  await lastTimer(r).fire();
  const rows = rowsOf(r);
  const boundaries = boundariesOf(r);
  assert.ok(rows !== null && boundaries !== null);
  assert.equal(Object.keys(boundaries).length, 167);
  const infos = r.log.lines.filter((line) => line.level === "info").map((line) => line.text);
  assert.deepEqual(
    infos.filter((text) => text.endsWith("loadable again")),
    ["geo bootstrap: bw-gemeinden.json loadable again", "geo bootstrap: bw-grenzen.json loadable again"],
  );
  assert.equal(lastTimer(r).ms, GEO_REFRESH_MS);

  // A later failure keeps the previous context (the very same objects) and
  // warns once; the context is complete, so the retry is the regular 6 h.
  r.serve.municipalities = httpResponse(404, "not found");
  r.serve.boundaries = httpResponse(404, "not found");
  await lastTimer(r).fire();
  assert.equal(rowsOf(r), rows);
  assert.equal(boundariesOf(r), boundaries);
  assert.deepEqual(r.log.warnings().slice(2), [
    "geo bootstrap: bw-gemeinden.json not loadable (HTTP 404) — previous 167 municipality rows kept",
    "geo bootstrap: bw-grenzen.json not loadable (HTTP 404) — previous 167 polygons kept",
  ]);
  assert.equal(lastTimer(r).ms, GEO_REFRESH_MS);

  // A malformed master data file is a failure as well: parsed by stammdaten-bw's
  // strict parser, which throws — the rows stay.
  r.serve.municipalities = json({ gemeinden: [["08111000", "Stuttgart"]] });
  await lastTimer(r).fire();
  assert.equal(rowsOf(r), rows);
  const health = r.bootstrap.health();
  assert.match(health.municipalities.error ?? "", /gemeinden\[0\]/);
  assert.equal(health.boundaries.error, "HTTP 404");
  assert.equal(health.boundaries.failingSince, "2026-09-29T06:00:00.000Z");
  assert.equal(health.boundaries.loadedAt, "2026-09-29T06:00:00.000Z");
  assert.equal(r.log.warnings().length, 4, "still the same failure streak");
}

async function degradedBoundaryFileBlocksPrunes(): Promise<void> {
  const full = fullGeo();
  const r = geoRig(full);
  await startGeoBootstrap(r.kernel, 1);
  assert.equal(degradedOf(r), false);
  assert.equal(await r.ctx.prune.masterDataPlausible(), true, "the full files must be plausible");

  // One broken polygon entry: dropped by grenzen-bw's parser and counted, the
  // set marked degraded — no prune anywhere, as when grenzen-bw loads it.
  assert.ok(isRecord(full.rawBoundaries));
  r.serve.boundaries = json({ ...full.rawBoundaries, "08999999": { b: [1, 2, 3], r: [] } });
  await lastTimer(r).fire();
  assert.equal(degradedOf(r), true);
  assert.equal(await r.ctx.prune.masterDataPlausible(), false, "a dropped polygon must stop the prune");
  assert.deepEqual(r.log.warnings(), [
    "geo bootstrap: bw-grenzen.json: 1 unusable entries skipped — no prune while degraded",
  ]);
  const health = r.bootstrap.health();
  assert.equal(health.boundaries.error, null, "degraded is loaded, not failed");
  assert.equal(geoHealth(r.kernel.geo, r.bootstrap).boundariesDegraded, true);

  // The same degraded file again: no second warning. Repaired: plausible again.
  await lastTimer(r).fire();
  assert.equal(r.log.warnings().length, 1);
  r.serve.boundaries = json(full.rawBoundaries);
  await lastTimer(r).fire();
  assert.equal(degradedOf(r), false);
  assert.equal(await r.ctx.prune.masterDataPlausible(), true);
}

async function geoConnectorRunsOnTheBootstrapAlone(): Promise<void> {
  const r = geoRig();

  // Without the bootstrap: pegel-bw skips, as today.
  await runPegel(r.ctx);
  assert.equal(upsertBodies(r.seen).length, 0);
  assert.match(r.log.warnings()[0] ?? "", /PEGELONLINE: municipality boundaries \(bwGrenzen\) not loaded/);

  // Only the bootstrap fills the context (stammdaten-bw/grenzen-bw never run
  // here) — and the real connector runs through.
  await startGeoBootstrap(r.kernel, 1);
  const warningsBefore = r.log.warnings().length;
  await runPegel(r.ctx);
  assert.equal(r.log.warnings().length, warningsBefore, r.log.warnings().join("\n"));
  const written = upsertBodies(r.seen).flat();
  assert.ok(written.length > 0, "pegel-bw wrote nothing");
  // Only the connector's own entities — the bootstrap wrote no Municipality.
  for (const entity of written) {
    assert.ok(isRecord(entity));
    assert.equal(entity.type, "WaterLevelObserved");
  }
}

function sourcesAreTheConnectorsOwn(): void {
  // Same parsers — not a copy.
  assert.equal(GEO_SOURCES.municipalities.parse, parseMunicipalities);
  assert.equal(GEO_SOURCES.boundaries.parse, parseBoundaries);
  // Same URLs, including the overrides the connectors honour.
  assert.equal(GEO_SOURCES.municipalities.url(fakeEnv()), MUNICIPALITIES_URL);
  assert.equal(GEO_SOURCES.boundaries.url(fakeEnv()), BOUNDARIES_URL);
  const env = fakeEnv({
    UDP_MUNICIPALITIES_URL: "http://localhost:5173/bw-gemeinden.json",
    UDP_BOUNDARIES_URL: "http://localhost:5173/bw-grenzen.json",
  });
  assert.equal(GEO_SOURCES.municipalities.url(env), "http://localhost:5173/bw-gemeinden.json");
  assert.equal(GEO_SOURCES.boundaries.url(env), "http://localhost:5173/bw-grenzen.json");
}

export {
  fillsTheContextBeforeTheFirstRun as "geo bootstrap: fills municipalities and boundaries before the first run, writes nothing to Orion, reports /healthz",
  noAppConnectorNoRequest as "geo bootstrap: without a runtime=app connector not a single request",
  failedLoadKeepsTheContextAndRetries as "geo bootstrap: a failed load keeps the previous context, warns once per streak and retries (5 min while empty, else 6 h)",
  degradedBoundaryFileBlocksPrunes as "geo bootstrap: a boundary file with a dropped polygon marks the context degraded and blocks prunes",
  geoConnectorRunsOnTheBootstrapAlone as "geo bootstrap: pegel-bw runs on a geo context only the bootstrap filled",
  sourcesAreTheConnectorsOwn as "geo bootstrap: URLs (with overrides) and parsers are those of stammdaten-bw and grenzen-bw",
};
