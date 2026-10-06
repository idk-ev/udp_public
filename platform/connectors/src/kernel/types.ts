/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * THE CONTRACT of the connector service.
 *
 * Everything else in src/ implements this file; the ported connectors of phase 3
 * are written against it. It contains types and, as the single exception, the
 * one constant every entity carries ({@link NGSI_CONTEXT}); no logic and no
 * imports, so that importing the contract can never pull in a runtime.
 * A change here reaches every connector at once, which is exactly why
 * the migration plan freezes it after the kernel review
 * (docs/migration-konnektoren.md, "Sperre: Vertrag eingefroren"). Phase 3b
 * widened it once, where the ports had pinched: {@link ConnectorState},
 * `Ctx.rowBudget`, `RegistryEntry.sensorDetailFor`, request headers, the
 * concurrency cap, unpaced Orion reads and array SQL parameters. Persisting
 * the kernel state added one optional piece: {@link StateCodec}. The security
 * review added, all optional: `FetchOptions.maxBytes`/`signal`/`allowUrl` (and
 * `redirect: "error"` as the default), `RouteRequest.remoteAddress`/`signal`
 * and `RouteDefinition.readsBody`.
 *
 * Two rules carry the whole design:
 *
 *  1. **Transformation is a pure function.** `build(raw, geo, now)` receives raw
 *     data, geo context and a timestamp and returns entities — no network, no
 *     clock, no global state. Only that is diffable against the old Node-RED
 *     function node by the parity harness. All I/O lives in `run(ctx)`.
 *
 *  2. **External data enters as `unknown` and is narrowed, never asserted.**
 *     Hence `parse(raw: unknown): Raw` in the module contract and `unknown` as
 *     the result type wherever foreign JSON crosses the boundary. See
 *     src/kernel/parse.ts for the building blocks that make the honest way the
 *     short one.
 *
 * And one for everything that writes: **a change signature takes effect only
 * once the broker confirmed the write** ({@link UpsertPlan}, {@link
 * Orion.upsert}). The contract offers no way to store a new signature before
 * the upsert, because that is what froze values for weeks during Orion outages.
 *
 * Note on optional properties: `exactOptionalPropertyTypes` is on, and the wire
 * DTOs below therefore spell out `| undefined` on optional members. That is
 * deliberate. The old function nodes build properties via
 * `P = (v, u) => ({ type: 'Property', value: v, unitCode: u, observedAt: NOW })`
 * — `unitCode` is present and `undefined` when no unit applies. `JSON.stringify`
 * drops such keys, so the bytes on the wire are identical either way, but a port
 * must be free to reproduce the old key set exactly when the parity harness
 * compares before serialisation.
 */

/* ------------------------------------------------------------------ Primitives */

/** Registry key of a connector, e.g. `"parken-bw"`. */
export type ConnectorId = string;

/**
 * ISO-8601 timestamp in UTC, as produced by `new Date().toISOString()`.
 *
 * Deliberately a plain alias and not a branded type: a brand can only be
 * constructed with an assertion, and `as` is blocked service-wide.
 */
export type IsoTime = string;

/**
 * Official municipality key (Amtlicher Gemeindeschlüssel), 8 digits with a
 * leading zero in Baden-Württemberg, e.g. `"08111000"` for Stuttgart.
 */
export type Ags = string;

/** District key (Kreisschlüssel), the first 5 digits of an {@link Ags}. */
export type KreisCode = string;

/**
 * NGSI-LD entity id. The template literal is what turns the flow invariant
 * "no entity id built from slugged free text" into a compiler-checked shape:
 * a bare `string` no longer fits where an id is expected.
 */
export type EntityId = `urn:ngsi-ld:${string}`;

/**
 * JSON object. An interface rather than `Readonly<Record<string, JsonValue>>`
 * because a mapped type inside the recursive union below would make the alias
 * reference itself circularly.
 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** JSON value as it arrives from a source or leaves towards Orion-LD. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

/* ------------------------------------------------------------------ NGSI-LD */

/** The core context every entity carries inline, as in the old function nodes. */
export const NGSI_CONTEXT = "https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld";

/**
 * Typed timestamp value, the shape every connector writes into `dateObserved`:
 * `{ '@type': 'DateTime', '@value': now }`. Named here because an interface has
 * no implicit index signature and would otherwise not fit into {@link JsonValue}.
 */
export interface NgsiDateTime {
  readonly "@type": "DateTime";
  readonly "@value": IsoTime;
}

/** Value of an NGSI-LD attribute. */
export type NgsiValue = JsonValue | NgsiDateTime;

/**
 * NGSI-LD Property. `unitCode` follows UN/CEFACT (`C62` = dimensionless count,
 * `CEL` = degrees Celsius, …), `observedAt` is the measurement time — as opposed
 * to `dateObserved`, which the connectors carry as a separate attribute because
 * the dashboards read it.
 */
export interface Property<T extends NgsiValue = NgsiValue> {
  readonly type: "Property";
  readonly value: T;
  readonly unitCode?: string | undefined;
  readonly observedAt?: IsoTime | undefined;
}

/** GeoJSON geometry as accepted by an NGSI-LD GeoProperty. */
export interface GeoJsonPoint {
  readonly type: "Point";
  /** GeoJSON order: longitude first, then latitude. */
  readonly coordinates: readonly [lon: number, lat: number];
}

export interface GeoJsonPolygon {
  readonly type: "Polygon";
  readonly coordinates: readonly (readonly (readonly [lon: number, lat: number])[])[];
}

export type GeoJsonGeometry = GeoJsonPoint | GeoJsonPolygon;

export interface GeoProperty {
  readonly type: "GeoProperty";
  readonly value: GeoJsonGeometry;
  readonly observedAt?: IsoTime | undefined;
}

export interface Relationship {
  readonly type: "Relationship";
  readonly object: EntityId;
}

export type NgsiAttribute = Property | GeoProperty | Relationship;

/**
 * An NGSI-LD entity in normalised form, as the upsert endpoint expects it.
 *
 * The index signature is what allows a connector to declare its own attribute
 * set as a narrower interface and still hand it to `Orion.upsert`. Reading an
 * arbitrary attribute back off an `NgsiEntity` is deliberately awkward — the
 * connector that built it knows its own shape and should type it locally.
 */
export interface NgsiEntity {
  readonly id: EntityId;
  readonly type: string;
  readonly "@context": string;
  readonly [attribute: string]: NgsiAttribute | string | undefined;
}

/* ------------------------------------------------------------------ Geo context */

/**
 * One row of `bw-gemeinden.json` (generated by
 * scripts/generate-bw-municipalities.py, served by the cockpit).
 *
 * This tuple is the reason `noUncheckedIndexedAccess` is switched on. Its column
 * meaning used to live in a comment above the destructuring in the function node
 * (`// 0 id · 1 lat · 2 lon`); here the compiler carries it.
 *
 * Nine columns, not eight: the docstring of the generator and the destructuring
 * in FN_MUNI both stop at `dashboardUrl`, but the file has carried a ninth
 * column since the slug work (F2), and `carsharing-bw` / `ladesaeulen-bw` build
 * their entity ids from it (`g[8]`). Whoever reads only FN_MUNI misses it.
 */
export type MunicipalityRow = readonly [
  ags: Ags,
  name: string,
  lat: number,
  lon: number,
  kreisCode: KreisCode,
  /** `S` = Stadt, `G` = Gemeinde, `F` = gemeindefreies Gebiet. */
  municipalityType: string,
  population: number | null,
  dashboardUrl: string | null,
  /** URL slug of the municipality page, e.g. `"stuttgart"`. */
  slug: string,
];

/** Payload of `bw-gemeinden.json`. */
export interface MunicipalitiesFile {
  readonly stand: string;
  readonly quelle: string;
  readonly gemeinden: readonly MunicipalityRow[];
}

/**
 * One entry of `bw-grenzen.json`: bounding box plus simplified rings of a
 * municipality. Short keys because the file holds 1,103 of them.
 */
export interface BoundaryEntry {
  /** Bounding box `[west, south, east, north]` in degrees. */
  readonly b: readonly [west: number, south: number, east: number, north: number];
  /** Rings, each a list of `[lon, lat]` pairs. */
  readonly r: readonly (readonly (readonly [lon: number, lat: number])[])[];
}

/** Payload of `bw-grenzen.json`, keyed by {@link Ags}. */
export type BoundarySet = Readonly<Record<Ags, BoundaryEntry>>;

/**
 * The geo context almost every connector sits on: municipality master data plus
 * the boundary cache. Port of STRICT_LOOKUP and `geo_helper` in
 * the former Node-RED flow generator (see git history) (see src/kernel/geo.ts for the algorithm).
 *
 * There is deliberately NO centroid lookup here any more. The former helper
 * (NEAREST_HELPER) fell back to the nearest municipality centre, so points
 * outside Baden-Württemberg — rental bikes in Basel, particulate sensors in
 * Alsace — were silently counted in the nearest BW municipality, and without
 * boundaries every point was assigned by centroid. A point that lies in no
 * municipality polygon belongs to no BW municipality.
 *
 * The one connector that still falls back to centroids (`uba-bw`: stations
 * pre-selected by their DEBW code, guaranteed to be in BW) does so in its own
 * module, on top of {@link GeoIndex.municipalities}. The static invariant
 * tests (tests/static/connector-invariants.test.js) keep a whitelist of exactly
 * that module; the fallback is not offered here so that nobody picks it up by
 * accident.
 */
export interface GeoIndex {
  /** Empty when the run asked for `municipalities: "optional"` and none are loaded. */
  readonly municipalities: readonly MunicipalityRow[];
  /** `null` until `grenzen-bw` has run. */
  readonly boundaries: BoundarySet | null;
  /** `GRZ_OK` of the old prelude: a non-empty boundary set is loaded. */
  readonly hasBoundaries: boolean;
  byAgs(ags: Ags): MunicipalityRow | undefined;
  /**
   * `agsStrict` of the old flows: AGS of the municipality polygon containing
   * the point, with the sliver tolerance (four probes ~330 m N/S/E/W must ALL
   * hit a polygon; majority wins). `null` outside every municipality, for
   * non-finite coordinates, and whenever no boundaries are loaded.
   */
  agsAt(lat: number, lon: number): Ags | null;
  /**
   * `nearestStrict` of the old flows — despite the old name, nothing "nearest"
   * about it: the master data row of {@link agsAt}, or `null` (also when a
   * polygon has no master data row).
   */
  municipalityAt(lat: number, lon: number): MunicipalityRow | null;
}

/**
 * What a run needs from the geo context. Both default to `"required"`.
 *
 * `boundaries: "required"` is `geo_helper(label)` of the generator: while the
 * boundary cache is missing the run is SKIPPED with a warning — assigning by
 * centroid instead is exactly the error the strict lookup replaced. Used by
 * `sharing-bw`, `carsharing-bw`, `ladesaeulen-bw`, `feinstaub-bw`, `eco-bw`,
 * `baustellen-bw`, and (with `municipalities: "optional"`) by `pegel-bw`,
 * `pegel-lubw` and the three Overpass connectors (PIP_ONLY).
 *
 * `boundaries: "optional"` is `geo_helper(label, require_boundaries=False)`:
 * the run goes ahead, every lookup answers `null` until boundaries arrive. Only
 * for connectors that still produce something useful without an assignment —
 * `wetter-dwd-station` (station without municipality), `uba-bw` (own centroid
 * fallback), `parken-bw` (assigns by ARS first, counts the rest as
 * unassigned) — and for connectors that only read the master data rows from
 * the context (`mastr-bw`, `puls-bw`). Spelling it out is the point: the
 * lenient mode has to be asked for by name in the module. (`wetter-bw`,
 * `vorhersage-bw` and `warnungen-bw` fetch `bw-gemeinden.json` themselves and
 * need no geo context; `wetter-bw` also refreshes it via `setMunicipalities`.)
 *
 * `municipalities: "optional"` mirrors the nodes that read `bwGemeinden` with
 * `|| []` (the gauges use it only for display names; the Overpass nodes do not
 * read it at all); all others skip while the master data are missing.
 */
export interface GeoRequirements {
  readonly boundaries?: "required" | "optional" | undefined;
  readonly municipalities?: "required" | "optional" | undefined;
}

/**
 * Holder of the geo context. Replaces `global.get('bwGemeinden')` /
 * `global.set('bwGrenzen', …)` of the Node-RED flow context.
 *
 * Connectors get at the index only through {@link forRun}, which performs the
 * checks of the old prelude and logs the skip itself (under the connector's
 * name, so the health check groups it correctly). They must not invent a
 * substitute when it answers `null`.
 */
export interface GeoStore {
  setMunicipalities(rows: readonly MunicipalityRow[]): void;
  /**
   * `skippedEntries`: polygons the parser had to drop. Any such entry marks the
   * boundary set as DEGRADED: lookups still use the rest, but no prune runs on
   * it ({@link Pruner.masterDataPlausible} answers `false`). The old node
   * stored the broken entry and crashed on it, so it never pruned either.
   */
  setBoundaries(boundaries: BoundarySet, skippedEntries: number): void;
  /**
   * The geo index for one run, or `null` after a logged `[warn]` — the run is
   * then to be skipped (`return`). `label` prefixes the warning, as the label
   * argument of `geo_helper` did.
   *
   * Also advances the master data plausibility bookkeeping (PRUNE_OK), exactly
   * where the old prelude computed it; see {@link Pruner.masterDataPlausible}.
   */
  forRun(label: string, requirements?: GeoRequirements): GeoIndex | null;
}

/* ------------------------------------------------------------------ Logging */

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Structured logging.
 *
 * **The line prefixes `[warn]` and `[error]` are load-bearing.**
 * `scripts/healthcheck.sh` counts container log lines with exactly those markers
 * and groups the warnings by the component in the following brackets (a `sed`
 * over `[warn] [<component>]`). Renaming them silently blinds the health check —
 * the failure mode it was built for was precisely a source dropping out that
 * only ever showed up as `[warn]`. See src/kernel/log.ts for the exact line
 * format.
 */
export interface Log {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  /** `cause` is appended as a single line; stacks stay out of the counted line. */
  error(message: string, cause?: unknown): void;
  /**
   * Replacement for `node.status({ text })`. Node-RED showed this in the editor
   * and wrote nothing to the log, so it is emitted at `debug` and stays out of
   * the health check's counters at the default level.
   */
  status(text: string): void;
  /** Derives a logger for a sub-component; the names nest with `:`. */
  child(component: string): Log;
}

/* ------------------------------------------------------------------ Environment */

/** Access to process environment, replacing Node-RED's `env.get(…)`. */
export interface Env {
  get(name: string): string | undefined;
  /** Throws with a readable message instead of ingesting against a wrong target. */
  require(name: string): string;
  number(name: string, fallback: number): number;
  flag(name: string, fallback: boolean): boolean;
}

/* ------------------------------------------------------------------ HTTP client */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface FetchOptions {
  readonly method?: HttpMethod | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  /** Default 30 s — the timeout the old ParkAPI node set on its raw socket. */
  readonly timeoutMs?: number | undefined;
  /** Additional attempts after the first one. Default 2. */
  readonly retries?: number | undefined;
  /** Overrides the service-wide User-Agent (Overpass demands a contact address). */
  readonly userAgent?: string | undefined;
  /**
   * Minimum spacing towards this host in milliseconds, i.e. the token bucket
   * replacing the `delay` node in front of the request. Default 1000 ms — the
   * "1 Anfrage/s" node that stood in front of 20 of the 25 delays.
   */
  readonly minIntervalMs?: number | undefined;
  /**
   * Requests towards this host in flight at once, across every connector —
   * see {@link RateLimitOptions.maxConcurrent}. Default: no cap. The Overpass
   * connectors use 1.
   */
  readonly maxConcurrent?: number | undefined;
  /**
   * The token bucket this request waits in. Default: the URL's host, shared by
   * every connector. `null` sends it unpaced — only for reads of this
   * platform's own broker ({@link Orion.find}, {@link Orion.list},
   * {@link Orion.count}): the old flows sent those without a delay node, and a
   * read must not queue behind a backlog of paced writes to the same host.
   */
  readonly bucket?: string | null | undefined;
  /**
   * Default `"error"`: a 3xx answer throws a `FetchRedirectError` naming the
   * target. The `http request` nodes followed every redirect; the service
   * does so only where a source is known to redirect and says so per call
   * (`uba-bw`, the GBFS feeds). A request carrying credentials (hystreet's
   * `X-API-Token`) must never follow — the token would travel to wherever the
   * `Location` points — and writes to Orion never do either: a redirected POST
   * would silently turn into a GET somewhere else, and a delete must never be
   * re-aimed. `"follow"` is followed hop by hop by the fetcher (at most 5),
   * each target checked against {@link allowUrl}.
   */
  readonly redirect?: "follow" | "error" | undefined;
  /**
   * Cap on the DECOMPRESSED body in bytes. Default 32 MiB. An announced
   * `Content-Length` above it is refused before reading; a body that grows
   * past it aborts the request. Either way a `FetchTooLargeError`, no retry —
   * a gzip body of 0.4 MB can inflate to 400 MB. The large sources set their
   * own, measured, finite cap.
   */
  readonly maxBytes?: number | undefined;
  /**
   * Aborts the request (and the wait for its rate-limit token) — e.g. when the
   * client of a public route disconnects. An abort throws a
   * `FetchAbortedError` and is not retried.
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * Checked for the request URL and for every redirect target before it is
   * contacted; `false` throws a `FetchUrlRefusedError` without a request. For
   * URLs that come out of foreign data (the GBFS system list).
   */
  readonly allowUrl?: ((url: URL) => boolean) | undefined;
}

export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface JsonResponse {
  readonly status: number;
  readonly ok: boolean;
  /** Narrow with src/kernel/parse.ts — never assert. */
  readonly body: unknown;
}

/**
 * HTTP client with timeout, retry and rate limiting.
 *
 * Non-2xx does **not** throw: the Node-RED `http request` nodes all ran with
 * `senderr: false` and handed the status on to the function node, which is why
 * every ported function starts with `if (msg.statusCode >= 400)`. Only network
 * errors and timeouts throw, and only after the retries are used up.
 */
export interface Fetcher {
  text(url: string, options?: FetchOptions): Promise<HttpResponse>;
  json(url: string, options?: FetchOptions): Promise<JsonResponse>;
}

/* ------------------------------------------------------------------ Rate limiting */

export interface RateLimitOptions {
  /** One request per this many milliseconds. Default 1000. */
  readonly minIntervalMs?: number | undefined;
  /** Tokens available at once after an idle period. Default 1. */
  readonly burst?: number | undefined;
  /** Waiters allowed to queue before `acquire` rejects. Default 500. */
  readonly maxQueue?: number | undefined;
  /**
   * Holders of this bucket at once: a waiter gets its token only while fewer
   * than this many earlier acquisitions are unreleased. Default: no cap. Like
   * the interval, the strictest value seen for a bucket wins, so one connector
   * cannot loosen another's cap. The delay nodes only spaced STARTS; this is
   * what keeps a slow Overpass answer from overlapping the next request.
   */
  readonly maxConcurrent?: number | undefined;
  /** Ends the wait for a token (`RateLimitAbortedError`); a granted token stays granted. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Ends one acquisition of {@link RateLimiter.acquire}. Idempotent. Only
 * matters for a bucket with {@link RateLimitOptions.maxConcurrent}, but always
 * call it — {@link RateLimiter.run} and the fetcher do.
 */
export type RateLimitRelease = () => void;

/**
 * Token bucket per host, replacing the 25 `delay` nodes.
 *
 * Those nodes run with `drop: false`, i.e. an unbounded queue — a source that
 * answers more slowly than it is polled grows the queue in memory without a
 * word. The bucket therefore has a cap and reports the overflow instead of
 * growing silently (docs/migration-konnektoren.md, risk "Taktung").
 */
export interface RateLimiter {
  /**
   * Resolves once a token for `host` is free (and, with a concurrency cap, a
   * slot). Rejects on queue overflow. Release the result when the request is
   * done.
   */
  acquire(host: string, options?: RateLimitOptions): Promise<RateLimitRelease>;
  /** Convenience: acquire, run, release — also when `task` throws. */
  run<T>(host: string, task: () => Promise<T>, options?: RateLimitOptions): Promise<T>;
  /**
   * No token for `host` for the next `ms` milliseconds — the provider asked
   * for a break (HTTP 429 with `Retry-After`). Shared like the bucket: every
   * connector waiting for the host waits. Only ever lengthens a pause.
   */
  pause(host: string, ms: number): void;
}

/**
 * Daily call budget per host, shared by every connector — `ctx.quota`, see
 * src/kernel/quota.ts. Counts per UTC day and survives a restart.
 */
export interface HostQuota {
  /** Units charged to `host` today, by every connector. */
  used(host: string): number;
  /** Charges `units` to `host` on behalf of this connector. */
  charge(host: string, units: number): void;
  /** Whether the provider said today (UTC) that `host`'s daily limit is used up. */
  exhausted(host: string): boolean;
  /** Records that the provider said so; persisted, cleared by the next UTC day. */
  exhaust(host: string): void;
}

/* ------------------------------------------------------------------ Change gate */

/** A stored value signature: what the broker is known to hold for a field. */
export type SignatureValue = string | number;

/**
 * A signature that takes effect only once the broker confirmed the write of
 * `entityId` — `sigPending(key, field, value, id)` of CHUNK_HELPER.
 *
 * `field` is usually the entity id itself (that is what the change gate
 * stores), but tables keyed otherwise exist: `sharing-bw` keeps
 * `ffLast:<system>` keyed by AGS, `efa-abfahrten` one table per stop keyed by
 * attribute. `value: null` REMOVES the field on commit (what the confirmed
 * zero of `sharing-bw` did before it deleted emptied summaries instead).
 */
export type PendingSignature = readonly [
  key: string,
  field: string,
  value: SignatureValue | null,
  entityId: EntityId,
];

/**
 * One write towards Orion together with the signatures riding on it.
 *
 * This pairing is the whole fix of the "frozen values" incident: a signature
 * says "this value is in the broker", so it may only be stored once the broker
 * accepted the write. Storing it before the upsert froze entities for weeks
 * whenever Orion-LD hung — the next run saw an unchanged signature and sent a
 * freshness stamp at most, never the value that had been lost. The plan carries
 * its pending signatures into {@link Orion.upsert}, which commits exactly those
 * the broker confirmed; there is no separate commit call to forget or to make in
 * the wrong order.
 */
export interface UpsertPlan {
  readonly entities: readonly NgsiEntity[];
  readonly pending: readonly PendingSignature[];
}

export interface ChangeGateOptions {
  /**
   * `false` (default) merges into the stored table; `true` replaces it with the
   * signatures seen in this call. `true` if and only if the connector sees its
   * WHOLE stock in this one call — see src/kernel/change-gate.ts; picking the
   * wrong one either disables the gate or leaks.
   */
  readonly replace?: boolean | undefined;
  /**
   * Refresh the `dateObserved` of an UNCHANGED entity only in every k-th run
   * (stable per entity, `freshTurn` of CHUNK_HELPER) instead of every run.
   * Default 1 = every run. `carsharing-bw` and `ladesaeulen-bw` use 3.
   */
  readonly freshEvery?: number | undefined;
  /** Run period for {@link freshEvery}. Default 3,600,000 ms (hourly). */
  readonly periodMs?: number | undefined;
  /**
   * The values change in most runs by nature (averaged measurements): no
   * `[warn]` when more than half of the entities changed. Entities WITHOUT a
   * stored signature still warn — that is lost state, not a volatile source.
   */
  readonly volatile?: boolean | undefined;
}

/**
 * Change detection over value signatures, two-phase. Port of `gateChanged`,
 * `sigPending` and SIG_COMMIT in the former Node-RED flow generator (see git history).
 *
 * Phase one is {@link check}: it decides what to send and returns the new
 * signatures as PENDING. Phase two, the commit, is not on this interface on
 * purpose — it happens inside {@link Orion.upsert} for the ids the broker
 * confirmed, so a connector cannot commit early or forget it.
 */
export interface ChangeGate {
  /**
   * Returns the plan to hand to {@link Orion.upsert}: changed entities in full,
   * unchanged ones reduced to their freshness stamp (`id`, `type`,
   * `dateObserved`, `@context`), and the pending signatures of the changed
   * ones. The OLD signature of a changed entity is dropped right away, so a
   * failed upsert leaves it "changed" and the next run sends it again.
   *
   * @param key    Store key, one per table (`'muniSig'`, `'pegelSig'`, …).
   * @param sigOf  Hashes the MEASURED VALUES, never `dateObserved`.
   */
  check<T extends NgsiEntity>(
    key: string,
    entities: readonly T[],
    sigOf: (entity: T) => SignatureValue,
    options?: ChangeGateOptions,
  ): UpsertPlan;
  /**
   * A plan that writes `entities` in full and carries no signature — for the
   * connectors without a gate (road works, warnings, …). Spelled out so an
   * ungated write is a visible decision in the module, not an accident.
   */
  ungated(entities: readonly NgsiEntity[]): UpsertPlan;
  /**
   * A copy of a table, for the connectors that keep their own (`parken-bw`:
   * `parkStatik`/`parkFrei`, `sharing-bw`: `ffLast:<system>`, `efa-abfahrten`:
   * one per stop). Empty if the table does not exist. New values for such a
   * table go into the plan as {@link PendingSignature}s.
   */
  table(key: string): Map<string, SignatureValue>;
  /**
   * Keeps only the entries for which `keep(field, value)` holds and removes the
   * rest (a table left empty is dropped) — `flow.set(key, carriedOver)` of
   * `parken-bw`, `flow.set('ffLast:<sys>', undefined)` of `sharing-bw`.
   *
   * There is deliberately no way to WRITE a value here: a new value goes into
   * the plan as a {@link PendingSignature} and takes effect on confirmation,
   * or the frozen values described at {@link UpsertPlan} come back. Call it
   * before the upsert; called after, it can only drop what was just committed,
   * which costs a resend, never a frozen value.
   */
  retain(key: string, keep: (field: string, value: SignatureValue) => boolean): void;
  /**
   * The keys of THIS connector's tables. Tables are namespaced per connector,
   * so two connectors cannot collide on a key, and neither sees the other's.
   */
  keys(): readonly string[];
}

/* ------------------------------------------------------------------ Orion-LD */

export interface UpsertOptions {
  /**
   * Entities per request. Default 150 — the size FN_MUNI passes to
   * `emitChunks`; other connectors used 50 or 100 and say so explicitly.
   */
  readonly chunkSize?: number | undefined;
}

export interface UpsertResult {
  /** Entities sent. 0 means there was nothing to write. */
  readonly entities: number;
  readonly chunks: number;
  /** Chunks the broker did not confirm at all (non-2xx, timeout, refused). */
  readonly failedChunks: number;
  /**
   * Ids the broker confirmed: the whole chunk on 2xx, per entity on 207
   * (`success`, else everything not in `errors`; unreadable body = none).
   */
  readonly confirmed: ReadonlySet<EntityId>;
  /** Pending signatures committed resp. dropped (the entity goes out again). */
  readonly committed: number;
  readonly dropped: number;
}

export interface DeleteOptions {
  /** Ids per request. Default 200 as in FN_RW_EXPIRE; the prune uses 100. */
  readonly chunkSize?: number | undefined;
  /** Prefix of the warnings (`<label> delete HTTP 500`), e.g. `"<prune label>: prune"`. Default `"orion"`. */
  readonly label?: string | undefined;
}

export interface DeleteResult {
  readonly requested: number;
  readonly chunks: number;
  readonly failedChunks: number;
  /** Ids the broker confirmed as deleted (204/200, or the success part of a 207). */
  readonly deleted: ReadonlySet<EntityId>;
}

/**
 * Per-call limits of {@link Orion.find}. Reads are never paced (see
 * {@link FetchOptions.bucket}); these bound how long one may take. A route
 * answering through nginx (60 s upstream timeout) passes `retries: 0`.
 */
export interface OrionReadOptions {
  /** Default 30 s, as every fetch. */
  readonly timeoutMs?: number | undefined;
  /** Default 2, as every fetch. */
  readonly retries?: number | undefined;
}

/** Query against `GET /ngsi-ld/v1/entities`. */
export interface OrionQuery {
  readonly type: string;
  readonly idPattern?: string | undefined;
  readonly attrs?: readonly string[] | undefined;
  readonly q?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  readonly count?: boolean | undefined;
  /** `options=` — `sysAttrs` for `modifiedAt`/`createdAt`, `keyValues` for the simplified form. */
  readonly options?: "sysAttrs" | "keyValues" | undefined;
}

export interface ListOptions {
  /** Page size. Default 1000. */
  readonly pageSize?: number | undefined;
  /** Hard stop: the prune reads up to 100 pages, the city pulse 50. */
  readonly maxPages: number;
  /**
   * Deduplicate by id. Offset paging has no stable order while other connectors
   * write, so an entity can show up on two pages; the city pulse deduplicates
   * and lets a then-skipped entity fail the count check. The prune does not.
   */
  readonly dedupe?: boolean | undefined;
}

/**
 * Result of a COMPLETE listing, or why there is none. Incomplete counts as
 * failed: acting on a partial picture is what both callers exist to avoid (the
 * pulse used to score with `limit=1000` cutting ChargingSummary off; a prune on
 * a partial listing would delete what it did not see).
 */
export type ListResult =
  | {
      readonly ok: true;
      /** Raw records — narrow them. */
      readonly entities: readonly unknown[];
      /** `NGSILD-Results-Count`, or `null` if the header was missing. */
      readonly total: number | null;
    }
  | {
      readonly ok: false;
      /** `"HTTP 503"`, `"is not an array"`, `"incomplete (900/1200)"`, `"failed (…)"`. */
      readonly reason: string;
    };

/**
 * {@link Orion.seedSignatures}: which broker entities, and how each empty
 * table's signature is derived from one of them.
 */
export interface SeedOptions {
  /** Log prefix. */
  readonly label: string;
  /**
   * The listings — one per entity type, each with an anchored id pattern
   * (`^…$`) that only this connector writes. ALL must list completely, or
   * nothing is seeded.
   */
  readonly queries: readonly { readonly type: string; readonly pattern: string }[];
  /** Attributes to list: exactly what the signatures read (plus what `accept` reads). */
  readonly attrs: readonly string[];
  /** Extra ownership check on the listed record, e.g. by `dataProvider`. */
  readonly accept?: ((id: string, entity: Readonly<Record<string, unknown>>) => boolean) | undefined;
  /**
   * Per gate table: the signature this connector would have stored for the
   * entity the broker holds, or `null` when it cannot be derived exactly
   * (the entity is then left out, and written in full as before).
   */
  readonly tables: Readonly<
    Record<string, (entity: Readonly<Record<string, unknown>>) => SignatureValue | null>
  >;
}

export interface SeedResult {
  /** Signatures put into the tables. */
  readonly seeded: number;
  /** Own entities the listings returned; `null` if none was completed. */
  readonly listed: number | null;
  /** Why nothing was seeded, or `null`. */
  readonly skipped: string | null;
}

export interface Orion {
  /**
   * Batch upsert with `options=update`, chunked, THEN commit of the plan's
   * pending signatures for the confirmed ids — one call, no order to get
   * wrong. Only a plan is accepted: {@link ChangeGate.check} for a gated write,
   * {@link ChangeGate.ungated} for one without signatures.
   *
   * Never throws for a broker fault: a non-2xx answer, a timeout or a refused
   * connection marks that chunk unconfirmed, drops its pending signatures with
   * a `[warn]`, and the remaining chunks still go out — as the old upsert nodes
   * did with `senderr: false`.
   */
  upsert(plan: UpsertPlan, options?: UpsertOptions): Promise<UpsertResult>;
  /**
   * check → upsert → commit in one call: {@link ChangeGate.check} followed by
   * {@link upsert}. The shape almost every gated connector needs
   * (`gateChanged` + `emitChunks` + `upsert_commit` in the old flows).
   */
  upsertChanged<T extends NgsiEntity>(
    key: string,
    entities: readonly T[],
    sigOf: (entity: T) => SignatureValue,
    options?: ChangeGateOptions & UpsertOptions,
  ): Promise<UpsertResult>;
  /** Batch delete, chunked. Never throws for a broker fault; see {@link DeleteResult.deleted}. */
  delete(ids: readonly EntityId[], options?: DeleteOptions): Promise<DeleteResult>;
  /**
   * Removes one attribute of one entity (`DELETE …/entities/{id}/attrs/{attr}`)
   * — the only way to withdraw a value, since Orion-LD refuses a `null` value
   * in a batch upsert. `true` when the broker no longer holds it (204, or 404
   * ResourceNotFound for a missing attribute or entity); `false` with a `[warn]`
   * otherwise. Sent with the core context as `Link`, as the entities are written.
   * Paced as a write, no retry. Never throws for a broker fault.
   */
  deleteAttribute(id: EntityId, attribute: string, label?: string): Promise<boolean>;
  /**
   * One request. Result stays `unknown`; the caller narrows it.
   *
   * Reads (`find`, `list`, `count`) are not paced and so never wait behind a
   * write backlog: `parken-bw` alone queues ~320 upsert chunks at one per
   * second, and a `/warnungen.ics` request behind them would outlast the
   * proxy's timeout. Writes stay paced.
   */
  find(query: OrionQuery, options?: OrionReadOptions): Promise<JsonResponse>;
  /** All pages of a query (`count=true`, `limit`/`offset`), checked against `NGSILD-Results-Count`. */
  list(query: OrionQuery, options: ListOptions): Promise<ListResult>;
  /**
   * `NGSILD-Results-Count` of a query (`count=true&limit=1`), or `null` if
   * Orion did not answer with a readable count.
   */
  count(query: OrionQuery): Promise<number | null>;
  /**
   * Fills EMPTY gate tables from what the broker holds (fresh install,
   * cutover, lost state), so that the next write is not a full rewrite of
   * every entity. A signature says "this value is in the broker" — derived
   * from the broker itself, it is true by construction. Tables that hold
   * anything are left alone; a listing that fails or is incomplete seeds
   * nothing (the entities are written in full, as without it). One complete
   * attempt per table and process. Never throws for a broker fault.
   */
  seedSignatures(options: SeedOptions): Promise<SeedResult>;
}

/* ------------------------------------------------------------------ Prune */

/**
 * Options of {@link Pruner.stale} — `pruneStale(o)` of PRUNE_HELPER.
 *
 * Every guard exists because the thing it prevents is worse than an entity
 * left standing: a prune deletes live data from the broker, and a wrong one
 * is only noticed when a municipality page goes blank.
 */
export interface PruneOptions {
  /**
   * Log prefix. The interval bookkeeping is keyed by label, type and pattern
   * together, so reusing a label for a different prune cannot share (and thus
   * satisfy) another prune's interval guard.
   */
  readonly label: string;
  readonly type: string;
  /**
   * Anchored id pattern (`^…$`) that ONLY this connector writes. Sent as
   * `idPattern` and checked again locally on every listed id — foreign ids are
   * never touched, whatever the broker returns. An unanchored pattern is
   * refused (the prune is skipped with a warning): `bw-svz-1` would also match
   * `bw-svz-10` and every id that merely contains it.
   */
  readonly pattern: string;
  /** Attributes to list. Default `["ags"]`; add what `accept` or the age check reads. */
  readonly attrs?: readonly string[] | undefined;
  /** Regex of ids to leave out although they match `pattern` (e.g. a current sub-scheme). */
  readonly exclude?: string | undefined;
  /**
   * Extra ownership check on the listed record, e.g. by `dataProvider`
   * (request it via `attrs`): municipal connectors write the same types with
   * slug-prefixed ids and must never be touched.
   */
  readonly accept?: ((id: string, entity: Readonly<Record<string, unknown>>) => boolean) | undefined;
  /** Ids produced by this run; never deleted. */
  readonly keep?: ReadonlySet<string> | undefined;
  /**
   * Only entities whose newest timestamp (`modifiedAt`, `observedAt`,
   * `dateObserved`) is older than this. No timestamp = keep.
   */
  readonly graceMs?: number | undefined;
  /**
   * For sources without refreshed timestamps: an id must be a candidate in at
   * least two CONSECUTIVE runs and for at least `confirmMs` (default 24 h). Any
   * skipped run clears the candidates — "consecutive" means consecutive.
   */
  readonly confirmKey?: string | undefined;
  readonly confirmMs?: number | undefined;
  /**
   * Age-only mode: at least one own entity must have been written within this
   * window, otherwise the connector itself is down and nothing is "stale".
   */
  readonly liveMs?: number | undefined;
  /**
   * Never delete more RECENT candidates than this share of the fresh stock
   * (the own entities that are no candidate; at least 3). Default 0.3;
   * clamped to (0, 1] — anything else falls back to the default. 1 means no
   * cap at all (and so no backlog: every candidate counts as recent).
   */
  readonly maxFraction?: number | undefined;
  /**
   * The previous run of this prune must lie at most 2.5 intervals back, so a
   * first run after an outage or a restart never acts on a single snapshot.
   * Default: the connector's own registry interval (a cron connector counts as
   * daily); `ctx.intervalMs(4)` for a prune that runs every fourth run
   * (`feinstaub-bw`). The check cannot be switched off: 0, a negative value or
   * NaN fall back to the default.
   */
  readonly intervalMs?: number | undefined;
  /** This connector's change gate table whose entries of deleted ids are forgotten (`sigKey`). */
  readonly signatureKey?: string | undefined;
  /** Further tables of the same kind (a split gate keeps two per entity). */
  readonly signatureKeys?: readonly string[] | undefined;
  /**
   * Age from which a candidate counts as BACKLOG rather than recent (default
   * 7 days). The {@link maxFraction} cap applies to recent candidates only;
   * the backlog is drained oldest first, {@link backlogBatch} per run, and
   * only while the fresh stock holds (see src/kernel/prune.ts).
   */
  readonly backlogMs?: number | undefined;
  /** Backlog deletions per run. Default 1,000. */
  readonly backlogBatch?: number | undefined;
  /** Prefix of the status line, usually the run's own status text. */
  readonly status?: string | undefined;
}

export interface PruneResult {
  /** Ids the broker confirmed as deleted. */
  readonly deleted: number;
  /** Outcome of a complete listing (`o.listed`); `null` if none was reached. */
  readonly listed: { readonly mine: number; readonly candidates: number } | null;
  /** Why nothing was attempted, or `null`. Already logged. */
  readonly skipped: string | null;
  /** Of {@link deleted}: how many came from the backlog. Absent when none was attempted. */
  readonly backlogDeleted?: number | undefined;
}

/**
 * Automatic removal of stale own entities — port of PRUNE_HELPER and
 * PRUNE_OK_JS.
 *
 * The connectors only upsert. An entity a run no longer produces — the object
 * left the source, or it was wrongly assigned before the strict lookup — would
 * otherwise stay in the broker forever. Only ids the broker confirms as deleted
 * count and lose their change signature; the TRoE history is left untouched.
 *
 * State (interval bookkeeping, confirmation tables, the last plausible
 * municipality count) is kept per connector and persisted in PostgreSQL, so a
 * restart does not reset it; a municipality count that was never persisted is
 * seeded from Orion — see src/kernel/prune.ts and src/kernel/persistence.ts.
 */
export interface Pruner {
  /**
   * PRUNE_OK: the master data are complete enough to trust a deletion — at
   * least 1,000 municipalities, not fewer than 95 % of the last plausible
   * count, boundaries for at least 99 % of their AGS (by key, not by count),
   * and no boundary entry dropped by the parser.
   *
   * The "last plausible count" is persisted with the rest of the prune
   * bookkeeping. Where none was persisted yet (first start, new connector) it
   * is seeded from the number of `Municipality` entities in Orion; while Orion
   * cannot answer, the answer is `false` — no prune. Asynchronous for that
   * reason. Also `false` while the connector's persisted state is not loaded. {@link stale} checks it itself; call it directly only to
   * decide the else branch (e.g. {@link resetConfirmations} on an incomplete
   * run).
   */
  masterDataPlausible(): Promise<boolean>;
  /**
   * Never throws; failures are logged as `[warn]` and reported as skipped.
   * Implausible master data skip without a request and clear the
   * `confirmKey` table, as the else branch of the old call sites did. While
   * the connector's persisted state is not loaded the prune is skipped with
   * a `[warn]` and its bookkeeping is left untouched.
   */
  stale(options: PruneOptions): Promise<PruneResult>;
  /** Clears a confirmation table — an incomplete run breaks "consecutive". */
  resetConfirmations(confirmKey: string): void;
  /**
   * Deletes ids the CONNECTOR knows are gone (e.g. missing from a complete
   * per-system list in consecutive runs) — with the prune's discipline, not
   * its listing: state usable, master data plausible, every id matching the
   * anchored `pattern` (else nothing is deleted), their signatures out of the
   * store first, only confirmed deletions count (but every attempted id
   * loses its signatures). Never throws.
   */
  remove(options: RemoveOptions): Promise<RemoveResult>;
}

export interface RemoveOptions {
  readonly label: string;
  /** Anchored id pattern every id must match. */
  readonly pattern: string;
  readonly ids: readonly EntityId[];
  /** Gate tables whose entries of deleted ids are forgotten. */
  readonly signatureKeys?: readonly string[] | undefined;
}

export interface RemoveResult {
  /** Ids the broker confirmed as deleted. */
  readonly deleted: ReadonlySet<EntityId>;
  /** Why nothing was attempted, or `null`. Already logged. */
  readonly skipped: string | null;
}

/* ------------------------------------------------------------------ Registry */

/**
 * Per-municipality parameters from the registry, e.g. `efa-abfahrten`:
 * `params.stopId["08111000"] === "de:08111:6115"`, `params.coords[…]` a
 * `[lon, lat]` pair. Two levels: parameter name, then AGS.
 */
export type ConnectorParams = Readonly<Record<string, Readonly<Record<Ags, JsonValue>>>>;

/** NGSI-LD entity type, e.g. `"ParkingSite"`. */
export type EntityType = string;

/**
 * `rowBudget24h` of a registry entry: expected TRoE rows per day, keyed by
 * entity type — `{ "ParkingSite": 25000, "BikeParking": 8000 }`. Whole,
 * non-negative row counts. The standing fuse from the ParkAPI incident: the
 * generator sums the budgets of all connectors per type (several may write the
 * same type) and the TRoE statistics warn when a type exceeds its sum.
 */
export type RowBudget = Readonly<Record<EntityType, number>>;

/**
 * One entry of platform/config/connectors.json, after narrowing.
 *
 * Only the fields the service actually reads are typed. The file carries more
 * (`_doc`, `supersededBy`, …); unknown members are ignored rather than
 * rejected, because the registry is also read by the status export for the
 * frontend and keeps fields this service does not care about.
 */
export interface RegistryEntry {
  readonly id: ConnectorId;
  readonly name: string;
  readonly scope: string;
  /** `"*"` = all municipalities, an AGS list, or `null` for stateless connectors. */
  readonly enabledFor: "*" | readonly Ags[] | null;
  readonly intervalSeconds: number | null;
  /**
   * `intervalOffsetSeconds`: the interval runs on wall-clock slots — at every
   * multiple of `intervalSeconds` since 00:00 UTC plus this offset — instead
   * of counting from the start of the service. Two connectors sharing a
   * provider keep their distance across restarts that way. `null` = counted
   * from the first run.
   */
  readonly intervalOffsetSeconds: number | null;
  /** Five-field cron in local time (`TZ=Europe/Berlin` in the image). */
  readonly cron: string | null;
  /**
   * `false` means **fire delayed, not skip** — unless the connector's last
   * run, persisted, is younger than its interval: then a restart adds no
   * run. See {@link Schedule} and src/kernel/scheduler.ts.
   */
  readonly refireOnRestart: boolean | null;
  /**
   * `false`: no run on service start at all — the interval or cron is the
   * only trigger. For nightly jobs whose schedule is enough and whose run is
   * expensive (a database maintenance pass, ~1,500 requests to one source).
   * Missing means `true`. Unlike `refireOnRestart: false` (delayed, not
   * skipped) this does skip; the registry refuses it on an entry without an
   * interval or cron, which would then never run.
   */
  readonly fireOnStart: boolean;
  readonly active: boolean;
  readonly requiresSecret: string | null;
  readonly pending: boolean;
  readonly sollMinutes: number | null;
  readonly sampleEntity: EntityId | null;
  readonly healthUrl: string | null;
  readonly attribution: string | null;
  readonly provides: readonly string[];
  /** Expected TRoE rows per day and entity type, the ParkAPI fuse. `null` = no budget. */
  readonly rowBudget24h: RowBudget | null;
  /**
   * `sensorDetailFor` (read by `feinstaub-bw`): the municipalities whose single
   * sensors become entities — `"*"` for all, or a list of AGS. Missing means
   * none, as the generator's `.get("sensorDetailFor", [])`.
   */
  readonly sensorDetailFor: "*" | readonly Ags[];
  readonly params: ConnectorParams;
  /**
   * `excludeSystems` (read by the GBFS connectors `sharing-bw` and
   * `carsharing-bw`): systems of the source list that are never fetched nor
   * written, each with the reason (licence terms of the provider). Missing
   * means none.
   */
  readonly excludeSystems: readonly SystemExclusion[];
}

/**
 * One exclusion rule of `excludeSystems`: a system id pattern (letters,
 * digits, `_`, `-`; `*` matches any run of characters) and why it is excluded.
 */
export interface SystemExclusion {
  readonly pattern: string;
  readonly reason: string;
}

export interface Registry {
  readonly entries: readonly RegistryEntry[];
  byId(id: ConnectorId): RegistryEntry | undefined;
  /** Active entries — exactly what this service runs (given a module exists). */
  activeEntries(): readonly RegistryEntry[];
}

/* ------------------------------------------------------------------ Scheduler */

export type ScheduleKind = "interval" | "cron" | "manual";

/**
 * Resolved schedule of one connector.
 *
 * `startupDelaySeconds` is where the migration's smallest, most easily botched
 * decision lives. In the flows the inject node fires on start (`once: true`)
 * after `onceDelay` seconds. Connectors with `refireOnRestart: false` do not
 * lose that start — the generator only pushes their delay out to 600 s:
 *
 *   > Seltene Quellen (Overpass u. a.) sollen nicht sofort bei jedem Neustart
 *   > feuern […]. Sie ganz vom Start auszunehmen war aber der falsche Schluss:
 *   > Wer öfter neu startet als das Abrufintervall lang ist, lässt den Konnektor
 *   > verhungern (wetter-bw stand nach einem Abend mit vielen Neustarts 11 h
 *   > ohne Daten da).
 *
 * Reading `refireOnRestart: false` as "does not fire on start" starves
 * `rathaus-bw`, `ausflug-bw`, `wetter-bw` and `vorhersage-bw`.
 */
export interface Schedule {
  readonly kind: ScheduleKind;
  readonly intervalSeconds: number | null;
  readonly cron: string | null;
  readonly fireOnStart: boolean;
  readonly startupDelaySeconds: number;
  /**
   * Interval on wall-clock slots: offset of the slots from 00:00 UTC in
   * seconds ({@link RegistryEntry.intervalOffsetSeconds}). Missing/`null` =
   * the interval counts from the first run.
   */
  readonly offsetSeconds?: number | null | undefined;
  /**
   * `refireOnRestart: false`: the start run consults the persisted last run
   * of the connector and adds no run within the interval (src/kernel/scheduler.ts).
   */
  readonly resume?: boolean | undefined;
}

/** Outcome of {@link Scheduler.trigger}. */
export type TriggerResult =
  | { readonly outcome: "started" }
  | { readonly outcome: "unknown" }
  | { readonly outcome: "running" }
  | { readonly outcome: "cooldown"; readonly retryAfterSeconds: number };

export interface ScheduledJob {
  readonly id: ConnectorId;
  readonly schedule: Schedule;
}

export interface Scheduler {
  add(id: ConnectorId, schedule: Schedule, task: () => Promise<void>): void;
  /**
   * `lastRunMs`: start of the last completed run of a connector, persisted
   * (src/kernel/run-log.ts); `null` = unknown. Read once, for jobs with
   * {@link Schedule.resume}.
   */
  start(lastRunMs?: (id: ConnectorId) => number | null): void;
  stop(): void;
  /**
   * Manual run, behind `POST /trigger/:id` on the admin port. Refused while a
   * run of the connector is active, and within `cooldownMs` of the previous
   * manual trigger — a trigger is an operator's "run it now", not a way to
   * hammer a source.
   */
  trigger(id: ConnectorId, cooldownMs: number): TriggerResult;
  jobs(): readonly ScheduledJob[];
}

/* ------------------------------------------------------------------ HTTP server */

export interface RouteRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  /** Path parameters of the matched pattern, e.g. `:id` in `/trigger/:id`. */
  readonly params: Readonly<Record<string, string>>;
  /**
   * Request headers, names lowercased (as Node delivers them), a repeated
   * header joined with `", "`. Read-only.
   */
  readonly headers: Readonly<Record<string, string>>;
  /** Empty unless the route declares {@link RouteDefinition.readsBody}. */
  readonly body: string;
  /**
   * Peer address of the TCP connection as Node reports it (`127.0.0.1`,
   * `::1`, `::ffff:10.0.0.7`, …) — NOT a forwarded header, so a client cannot
   * choose it. `undefined` when unknown; a check on it must then refuse.
   */
  readonly remoteAddress?: string | undefined;
  /**
   * Aborted when the client goes away before the answer is sent. Hand it to
   * `FetchOptions.signal` so an upstream request nobody waits for is dropped.
   */
  readonly signal?: AbortSignal | undefined;
}

export interface RouteResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/**
 * A route contributed by a connector. `abfahrten-on-demand` brings
 * `GET /abfahrten`, the warning connector brings `GET /warnungen.ics` — the two
 * `http in` nodes of the old flows.
 *
 * The server answers around a route what Express answered around those nodes
 * (src/kernel/http.ts): `HEAD` on a `GET` route (same status and headers, no
 * body), `OPTIONS` with `Allow`, and a 304 for a `GET`/`HEAD` whose
 * `If-None-Match` matches the `ETag` a route set on a 2xx answer.
 */
export interface RouteDefinition {
  readonly method: HttpMethod;
  /** Pattern with `:name` segments, e.g. `/trigger/:id`. */
  readonly path: string;
  /**
   * `true` to receive the request body (at most 1 MB, beyond that 413).
   * Default `false`: the body is never read, and a request that carries one is
   * answered with `Connection: close` so nothing is left on the socket.
   * None of today's routes needs a body.
   */
  readonly readsBody?: boolean | undefined;
  handle(request: RouteRequest): Promise<RouteResponse>;
}

export interface RouteRegistry {
  register(route: RouteDefinition): void;
}

/* ------------------------------------------------------------------ Database */

/**
 * A value bound to a `$n` placeholder. A string array binds as a Postgres
 * array (`$1::text[]`), serialised by node-postgres as it always was.
 */
export type SqlParam = string | number | boolean | null | readonly string[];

/** A notice the server sent while a statement ran (`WARNING`, `NOTICE`, …). */
export interface DbNotice {
  /** `WARNING`, `NOTICE`, `INFO`, … as the server names it. */
  readonly severity: string;
  readonly message: string;
}

export interface DbQueryResult {
  /** Narrow them — column types are whatever the SQL says. */
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number | null;
  /**
   * Notices the server sent during this statement. A statement can succeed
   * and still only warn — `VACUUM` of a table the user does not own skips it
   * with a `WARNING` and reports success.
   */
  readonly notices?: readonly DbNotice[] | undefined;
}

export interface DbSession {
  query(sql: string, params?: readonly SqlParam[]): Promise<DbQueryResult>;
}

/**
 * Per-session settings, as the old nodes set them on their `pg.Client`.
 * `statement_timeout` cancels on the SERVER; `query_timeout` only makes the
 * client give up and would leave the query running — so both, the server one
 * shorter.
 */
export interface DbSessionOptions {
  /** `application_name`, visible in `pg_stat_activity` (`udp-troe-stats`). */
  readonly applicationName: string;
  readonly statementTimeoutMs: number;
  readonly queryTimeoutMs: number;
  /** Default 10 s. */
  readonly connectionTimeoutMs?: number | undefined;
  /**
   * `lock_timeout` on the server: a statement that waits longer for a lock
   * fails with SQLSTATE 55P03 instead of queueing — and making every later
   * writer of the same table queue behind it. Unset: no limit (the server's
   * default).
   */
  readonly lockTimeoutMs?: number | undefined;
}

/**
 * TimescaleDB access — the `pg` module the two SQL nodes loaded through
 * `libs`. Host `TROE_DB_HOST` (default `timescale`), port 5432, database
 * `orion`, user `TROE_DB_USER` (default `udp`), password `TROE_DB_PASSWORD`.
 * One connection per session, opened when the session starts and closed when
 * `work` settles, as the old nodes connected per run.
 */
export interface Db {
  session<T>(options: DbSessionOptions, work: (session: DbSession) => Promise<T>): Promise<T>;
}

/* ------------------------------------------------------------------ Connector state */

/**
 * One value of a connector's state, as {@link ConnectorState.slot} hands it
 * out. A mutable container (a `Map`, a `Set`) may also be changed in place.
 */
export interface StateSlot<T> {
  get(): T;
  set(value: T): void;
}

/**
 * How a piece of connector state is written to and read back from the state
 * store. `decode` gets what the database returned — external data, hence
 * `unknown` — and answers `undefined` for anything it does not recognise; the
 * slot then starts from its initial value.
 */
export interface StateCodec<T> {
  encode(value: T): JsonValue;
  decode(raw: unknown): T | undefined;
}

/**
 * Declares one piece of connector state: its name, its type and how its
 * initial value is made. Created ONCE, at module level, with
 * `stateKey(name, initial, codec?)` from src/kernel/state.ts. The key carries
 * the type, which is what lets {@link ConnectorState.slot} return the value
 * typed without an assertion.
 */
export interface StateKey<T> {
  readonly name: string;
  /**
   * The slot of this key within `owner`. Called by {@link ConnectorState.slot};
   * a connector goes through `ctx.state.slot(key)`.
   */
  slotIn(owner: ConnectorState): StateSlot<T>;
}

/**
 * Per-connector state that is neither a change signature nor prune
 * bookkeeping — the flow and global context values the old function nodes
 * kept (`oepnvHalte`, `mastrPos`, `scTakt`, `csStationen`, `parkLegacyDone`,
 * …). Shared by `run` and the connector's `routes`, which receive the same
 * ctx; invisible to every other connector.
 *
 * A key declared with a {@link StateCodec} is persisted in PostgreSQL together
 * with the change signatures and the prune bookkeeping, and survives a
 * restart; a key without one is a cache that lives as long as the process
 * (see src/kernel/state.ts). Reading a persisted key while the connector's
 * state is not loaded throws, and the kernel skips the run.
 */
export interface ConnectorState {
  /**
   * The slot of `key`, created with the key's initial value on first use.
   * Two different keys with the same name in one connector are a programming
   * error and throw.
   */
  slot<T>(key: StateKey<T>): StateSlot<T>;
  /** Names of the keys used so far. */
  keys(): readonly string[];
}

/* ------------------------------------------------------------------ Connector */

/**
 * Everything a connector's `run` gets handed. Assembled per connector in
 * src/kernel/context.ts.
 */
export interface Ctx {
  readonly id: ConnectorId;
  readonly entry: RegistryEntry;
  readonly log: Log;
  readonly env: Env;
  readonly fetch: Fetcher;
  readonly limiter: RateLimiter;
  /** Writes commit the change gate's pending signatures; see {@link Orion.upsert}. */
  readonly orion: Orion;
  readonly gate: ChangeGate;
  /** Use {@link GeoStore.forRun} at the top of `run`; it logs the skip itself. */
  readonly geo: GeoStore;
  readonly prune: Pruner;
  /**
   * TimescaleDB, for the two connectors that talk SQL (`troe-stats`,
   * `troe-retention`). Connects lazily; nobody else needs to touch it.
   */
  readonly db: Db;
  readonly params: ConnectorParams;
  readonly enabledFor: "*" | readonly Ags[] | null;
  /** State of this connector, shared by `run` and its `routes`; see {@link ConnectorState}. */
  readonly state: ConnectorState;
  /** Daily call budget per host, shared by every connector; see {@link HostQuota}. */
  readonly quota: HostQuota;
  /**
   * `rowBudget24h` of EVERY registry entry summed per entity type —
   * `ROW_BUDGET` of the generator, computed by the kernel from the registry
   * it loaded at startup. Read by `troe-stats`.
   */
  readonly rowBudget: RowBudget;
  /** The clock. Only `run` may call it — `build` receives the value as an argument. */
  now(): IsoTime;
  /**
   * The connector's run interval in milliseconds, times `runs` (default 1) —
   * `interval_ms(conn_id, runs)` of the generator: `intervalSeconds`, a cron
   * connector counts as daily. E.g. `intervalMs(4)` for the prune of
   * `feinstaub-bw`, which runs every fourth run.
   */
  intervalMs(runs?: number): number;
  /** Aborted on shutdown; hand it to long loops so a stop is not blocked. */
  readonly signal: AbortSignal;
}

/** What the service needs in order to schedule a connector. */
export interface ConnectorRunner {
  readonly id: ConnectorId;
  run(ctx: Ctx): Promise<void>;
  /**
   * Endpoints this connector serves on the public port, built with the
   * connector's own `ctx` at startup — `/abfahrten` needs the shared rate
   * limiter and the stop directory (`ctx.state`), `/warnungen.ics` needs
   * `orion.find`.
   */
  readonly routes?: ((ctx: Ctx) => readonly RouteDefinition[]) | undefined;
}

/**
 * A ported connector.
 *
 * The split is the point: `parse` and `build` are pure and are what the parity
 * harness runs against the recorded fixture, `run` does the I/O around them. A
 * `build` that reads the clock or the network cannot be diffed against the old
 * function node and therefore cannot be shown to be a faithful port.
 *
 * `Built` is generic because not every connector produces entities — `grenzen-bw`
 * builds the boundary set for the geo context and returns exactly that.
 */
export interface ConnectorModule<Raw, Built = readonly NgsiEntity[]> extends ConnectorRunner {
  /** `unknown` in, typed out, loud on malformed input. No assertions. */
  parse(raw: unknown): Raw;
  /** Pure: no network, no clock, no global state. */
  build(raw: Raw, geo: GeoIndex | null, now: IsoTime): Built;
}
