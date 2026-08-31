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
 * (docs/migration-konnektoren.md, "Sperre: Vertrag eingefroren").
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
 * the boundary cache. Ported from NEAREST_HELPER / PIP_ONLY in
 * scripts/generate-nodered-flows.py.
 */
export interface GeoIndex {
  readonly municipalities: readonly MunicipalityRow[];
  /** `null` until `grenzen-bw` has run; `nearest` then falls back to centroids. */
  readonly boundaries: BoundarySet | null;
  byAgs(ags: Ags): MunicipalityRow | undefined;
  /** Point in polygon over the simplified boundaries, centroid fallback. */
  nearest(lat: number, lon: number): MunicipalityRow | null;
  /** Point in polygon only — no fallback, `null` outside every municipality. */
  agsAt(lat: number, lon: number): Ags | null;
}

/**
 * Holder of the geo context. Replaces `global.get('bwGemeinden')` /
 * `global.set('bwGrenzen', …)` of the Node-RED flow context.
 *
 * `index()` returns `null` as long as `stammdaten-bw` has not run — the same
 * situation the old helper answered with
 * `node.warn('bwGemeinden noch nicht im Kontext — Stammdaten-Flow abwarten')`.
 * Connectors warn and skip; they must not invent a substitute.
 */
export interface GeoStore {
  setMunicipalities(rows: readonly MunicipalityRow[]): void;
  setBoundaries(boundaries: BoundarySet): void;
  index(): GeoIndex | null;
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
}

/**
 * Token bucket per host, replacing the 25 `delay` nodes.
 *
 * Those nodes run with `drop: false`, i.e. an unbounded queue — a source that
 * answers more slowly than it is polled grows the queue in memory without a
 * word. The bucket therefore has a cap and reports the overflow instead of
 * growing silently (docs/migration-konnektoren.md, risk "Taktung").
 */
export interface RateLimiter {
  /** Resolves once a token for `host` is free. Rejects on queue overflow. */
  acquire(host: string, options?: RateLimitOptions): Promise<void>;
  /** Convenience: acquire, then run. */
  run<T>(host: string, task: () => Promise<T>, options?: RateLimitOptions): Promise<T>;
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
  readonly entities: number;
  readonly chunks: number;
  readonly failedChunks: number;
}

export interface DeleteResult {
  readonly requested: number;
  readonly chunks: number;
  readonly failedChunks: number;
}

/** Query against `GET /ngsi-ld/v1/entities`. */
export interface OrionQuery {
  readonly type: string;
  readonly idPattern?: string | undefined;
  readonly attrs?: readonly string[] | undefined;
  readonly q?: string | undefined;
  readonly limit?: number | undefined;
  readonly count?: boolean | undefined;
}

export interface Orion {
  /** Batch upsert with `options=update`, chunked. */
  upsert(entities: readonly NgsiEntity[], options?: UpsertOptions): Promise<UpsertResult>;
  /** Batch delete, chunked at 200 ids as in FN_RW_EXPIRE. */
  delete(ids: readonly EntityId[]): Promise<DeleteResult>;
  /** Result stays `unknown`; the caller narrows it. */
  find(query: OrionQuery): Promise<JsonResponse>;
}

/* ------------------------------------------------------------------ Change gate */

export interface ChangeGateOptions {
  /**
   * `false` (default) merges the new signatures into the stored ones; `true`
   * replaces the whole table. See src/kernel/change-gate.ts for which connector
   * needs which — picking the wrong one either disables the gate or leaks.
   */
  readonly replace?: boolean | undefined;
}

/**
 * Change detection over value signatures. Port of `gateChanged` from
 * CHUNK_HELPER in scripts/generate-nodered-flows.py.
 */
export interface ChangeGate {
  /**
   * Returns the entities that have to go to Orion: changed ones in full,
   * unchanged ones reduced to their freshness stamp.
   *
   * @param key    Store key, one per connector (`'muniSig'`, `'pegelSig'`, …).
   * @param sigOf  Hashes the MEASURED VALUES, never `dateObserved`.
   */
  gateChanged<T extends NgsiEntity>(
    key: string,
    entities: readonly T[],
    sigOf: (entity: T) => string,
    options?: ChangeGateOptions,
  ): readonly NgsiEntity[];
}

/* ------------------------------------------------------------------ Registry */

/**
 * Which runtime a connector belongs to. Missing field means `"nodered"` — the
 * cutover in phase 4 sets `"app"` per connector, and turning the field back is
 * the way out (platform/connectors/README.md).
 */
export type ConnectorRuntime = "nodered" | "app";

/**
 * Per-municipality parameters from the registry, e.g. `efa-abfahrten`:
 * `params.stopId["08111000"] === "de:08111:6115"`, `params.coords[…]` a
 * `[lon, lat]` pair. Two levels: parameter name, then AGS.
 */
export type ConnectorParams = Readonly<Record<string, Readonly<Record<Ags, JsonValue>>>>;

/**
 * One entry of platform/config/connectors.json, after narrowing.
 *
 * Only the fields the service actually reads are typed. The file carries more
 * (`nodePrefixes`, `_doc`, `supersededBy`, …); unknown members are ignored
 * rather than rejected, because the registry is also read by the flow generator
 * and the frontend export and will keep fields this service does not care about.
 */
export interface RegistryEntry {
  readonly id: ConnectorId;
  readonly name: string;
  readonly scope: string;
  /** `"*"` = all municipalities, an AGS list, or `null` for stateless connectors. */
  readonly enabledFor: "*" | readonly Ags[] | null;
  readonly intervalSeconds: number | null;
  /** Five-field cron in local time (`TZ=Europe/Berlin` in the image). */
  readonly cron: string | null;
  /**
   * `false` means **fire delayed, not skip**. See {@link Schedule} and
   * src/kernel/scheduler.ts.
   */
  readonly refireOnRestart: boolean | null;
  readonly active: boolean;
  readonly runtime?: ConnectorRuntime | undefined;
  readonly requiresSecret: string | null;
  readonly pending: boolean;
  readonly sollMinutes: number | null;
  readonly sampleEntity: EntityId | null;
  readonly healthUrl: string | null;
  readonly attribution: string | null;
  readonly provides: readonly string[];
  /** Expected TRoE rows per day and entity type, the ParkAPI fuse. */
  readonly rowBudget24h: Readonly<Record<string, number>> | null;
  readonly params: ConnectorParams;
}

export interface Registry {
  readonly entries: readonly RegistryEntry[];
  byId(id: ConnectorId): RegistryEntry | undefined;
  /** Active entries whose `runtime` is `"app"` — exactly what this service runs. */
  appEntries(): readonly RegistryEntry[];
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
}

export interface ScheduledJob {
  readonly id: ConnectorId;
  readonly schedule: Schedule;
}

export interface Scheduler {
  add(id: ConnectorId, schedule: Schedule, task: () => Promise<void>): void;
  start(): void;
  stop(): void;
  /** Manual run, behind `POST /trigger/:id`. `false` if the id is unknown. */
  trigger(id: ConnectorId): boolean;
  jobs(): readonly ScheduledJob[];
}

/* ------------------------------------------------------------------ HTTP server */

export interface RouteRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  /** Path parameters of the matched pattern, e.g. `:id` in `/trigger/:id`. */
  readonly params: Readonly<Record<string, string>>;
  readonly body: string;
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
 */
export interface RouteDefinition {
  readonly method: HttpMethod;
  /** Pattern with `:name` segments, e.g. `/trigger/:id`. */
  readonly path: string;
  handle(request: RouteRequest): Promise<RouteResponse>;
}

export interface RouteRegistry {
  register(route: RouteDefinition): void;
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
  readonly orion: Orion;
  readonly gate: ChangeGate;
  readonly geo: GeoStore;
  readonly params: ConnectorParams;
  readonly enabledFor: "*" | readonly Ags[] | null;
  /** The clock. Only `run` may call it — `build` receives the value as an argument. */
  now(): IsoTime;
  /** Aborted on shutdown; hand it to long loops so a stop is not blocked. */
  readonly signal: AbortSignal;
}

/** What the service needs in order to schedule a connector. */
export interface ConnectorRunner {
  readonly id: ConnectorId;
  run(ctx: Ctx): Promise<void>;
  /** Endpoints this connector serves, registered at startup. */
  readonly routes?: readonly RouteDefinition[] | undefined;
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
