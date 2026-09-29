/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The geo bootstrap: the kernel loads its own geo context, independent of
 * where `stammdaten-bw` and `grenzen-bw` run.
 *
 * ## Why
 *
 * The shared geo context ({@link SharedGeo}) used to be filled only by those
 * two connectors (and `wetter-bw` for the municipality rows) running in this
 * service. In Kubernetes Node-RED has no volume: its own geo context
 * (`global.bwGemeinden`/`bwGrenzen`) lives in the container and is refilled by
 * its `stammdaten-bw`/`grenzen-bw` flows after each restart. Those two flows
 * therefore have to stay in Node-RED until the LAST cutover group — and every
 * connector moved here before them would skip every run for want of a geo
 * context. So the kernel loads the two files itself.
 *
 * ## What
 *
 * `bw-gemeinden.json` and `bw-grenzen.json`, from the URLs the connectors use
 * (`COCKPIT_URL`, overridable by `UDP_MUNICIPALITIES_URL` /
 * `UDP_BOUNDARIES_URL`), through the kernel fetcher (paced per host, body
 * capped), parsed by the connectors' own `parse` functions — handed in as
 * {@link GeoSources} by src/connectors/index.ts, so the kernel imports no
 * connector and the parsing exists once. The result goes into the geo context
 * with the same calls the connectors make (`setMunicipalities`,
 * `setBoundaries(boundaries, skipped)`), so a boundary file with dropped
 * entries is just as degraded here and blocks every prune.
 *
 * It writes NOTHING to Orion. The `Municipality` entities stay the job of
 * `stammdaten-bw`, wherever it runs.
 *
 * ## When
 *
 * Once before the scheduler starts the connectors, then every
 * {@link GEO_REFRESH_MS} (6 h): the files are build artefacts of the cockpit
 * and change only when the platform is rebuilt and rolled out, so polling
 * them more often buys nothing. While the context is still incomplete (no
 * municipality rows or no polygon), the next attempt comes after
 * {@link GEO_RETRY_EMPTY_MS} (5 min) instead — a cockpit that starts after
 * this service must not leave the geo-dependent connectors skipping for 6 h.
 *
 * Only with at least one connector scheduled here ({@link startGeoBootstrap}
 * in src/kernel/context.ts): with no active connector the service stays idle
 * and sends no request at all.
 *
 * ## Failures
 *
 * A file that cannot be loaded or parsed leaves the previous context in place
 * and logs one `[warn]` per failure streak (and one info line when it loads
 * again); the next attempt is the regular one. Geo-dependent connectors keep
 * their own behaviour while the context is empty: `ctx.geo.forRun` logs and
 * skips.
 *
 * ## Next to the connectors
 *
 * When `stammdaten-bw` / `grenzen-bw` (or `wetter-bw`) run here as well, they
 * keep filling the context on their own schedule. Both read the same file
 * with the same parser, so it does not matter who wrote last: last write wins.
 */

import type { SharedGeo } from "./geo.js";
import type { BoundarySet, Env, Fetcher, Log, MunicipalitiesFile } from "./types.js";

/** Regular reload: the files change only with a rebuilt platform. */
export const GEO_REFRESH_MS = 6 * 3_600_000;

/** Next attempt while the context is still incomplete (cockpit not up yet). */
export const GEO_RETRY_EMPTY_MS = 5 * 60_000;

/** What `grenzen-bw`'s parser returns: the set plus the count of dropped entries. */
export interface ParsedBoundaries {
  readonly boundaries: BoundarySet;
  readonly skipped: number;
}

/** One of the two files: its name for log lines, its URL, the connector's parser. */
export interface GeoFileSource<T> {
  readonly file: string;
  readonly url: (env: Env) => string;
  /** Throws on a malformed file, as the connector's `parse` does. */
  readonly parse: (raw: unknown) => T;
}

export interface GeoSources {
  readonly municipalities: GeoFileSource<MunicipalitiesFile>;
  readonly boundaries: GeoFileSource<ParsedBoundaries>;
}

/** Schedules `callback` once after `ms`; returns the cancel. Injectable for tests. */
export type GeoTimer = (callback: () => Promise<void>, ms: number) => () => void;

const realTimer: GeoTimer = (callback, ms) => {
  const handle = setTimeout(() => {
    void callback();
  }, ms);
  // The HTTP servers keep the process alive; this timer must not on its own.
  handle.unref();
  return () => {
    clearTimeout(handle);
  };
};

export interface GeoBootstrapOptions {
  readonly log: Log;
  readonly fetch: Fetcher;
  readonly geo: SharedGeo;
  readonly env: Env;
  readonly sources: GeoSources;
  readonly nowMs?: (() => number) | undefined;
  /** Aborts a load in flight and stops rescheduling (the kernel's shutdown). */
  readonly signal?: AbortSignal | undefined;
  readonly timer?: GeoTimer | undefined;
}

interface SourceState {
  loadedAt: number | null;
  error: string | null;
  failingSince: number | null;
}

export interface GeoSourceHealth {
  readonly url: string;
  readonly loadedAt: string | null;
  readonly error: string | null;
  readonly failingSince: string | null;
}

export interface GeoBootstrapHealth {
  readonly active: boolean;
  readonly nextLoadAt: string | null;
  readonly municipalities: GeoSourceHealth;
  readonly boundaries: GeoSourceHealth;
}

/** The `geo` section of `/healthz`. */
export interface GeoHealth {
  /** Rows in the context, `null` = never set. */
  readonly municipalities: number | null;
  /** Polygons in the context, `null` = never set. */
  readonly boundaries: number | null;
  /** The parser dropped a polygon: no prune anywhere. */
  readonly boundariesDegraded: boolean;
  /** `null` without a bootstrap (test kernels). */
  readonly bootstrap: GeoBootstrapHealth | null;
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function countText(count: number | null): string {
  return count === null ? "no" : String(count);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GeoBootstrap {
  readonly #log: Log;
  readonly #fetch: Fetcher;
  readonly #geo: SharedGeo;
  readonly #env: Env;
  readonly #sources: GeoSources;
  readonly #nowMs: () => number;
  readonly #signal: AbortSignal | undefined;
  readonly #timer: GeoTimer;
  readonly #municipalities: SourceState = { loadedAt: null, error: null, failingSince: null };
  readonly #boundaries: SourceState = { loadedAt: null, error: null, failingSince: null };
  /** Warned-about problem of the last boundary file (degraded / empty), to warn once. */
  #boundaryIssue: string | null = null;
  #active = false;
  #stopped = false;
  #cancel: (() => void) | null = null;
  #nextLoadAt: number | null = null;
  #inFlight: Promise<void> | null = null;

  constructor(options: GeoBootstrapOptions) {
    this.#log = options.log;
    this.#fetch = options.fetch;
    this.#geo = options.geo;
    this.#env = options.env;
    this.#sources = options.sources;
    this.#nowMs = options.nowMs ?? Date.now;
    this.#signal = options.signal;
    this.#timer = options.timer ?? realTimer;
  }

  /** Started (and not stopped): loads and reschedules. */
  get active(): boolean {
    return this.#active;
  }

  /**
   * The first load, awaited by the caller before the scheduler starts, then
   * the reload cycle. Idempotent; never throws.
   */
  async start(): Promise<void> {
    if (this.#active || this.#stopped) return;
    this.#active = true;
    await this.load();
    this.#schedule();
  }

  /** Cancels the next load; one in flight finishes, but is not rescheduled. */
  stop(): void {
    this.#stopped = true;
    this.#active = false;
    this.#cancel?.();
    this.#cancel = null;
    this.#nextLoadAt = null;
  }

  /** One load of both files. Never throws; concurrent calls share one load. */
  load(): Promise<void> {
    this.#inFlight ??= this.#loadBoth().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  health(): GeoBootstrapHealth {
    return {
      active: this.#active,
      nextLoadAt: isoOrNull(this.#nextLoadAt),
      municipalities: this.#sourceHealth(this.#sources.municipalities.url(this.#env), this.#municipalities),
      boundaries: this.#sourceHealth(this.#sources.boundaries.url(this.#env), this.#boundaries),
    };
  }

  #sourceHealth(url: string, state: SourceState): GeoSourceHealth {
    return {
      url,
      loadedAt: isoOrNull(state.loadedAt),
      error: state.error,
      failingSince: isoOrNull(state.failingSince),
    };
  }

  /** Complete = rows and at least one polygon; otherwise retry soon. */
  #contextComplete(): boolean {
    const rows = this.#geo.municipalities;
    const boundaries = this.#geo.boundaries;
    return rows !== null && rows.length > 0 && boundaries !== null && Object.keys(boundaries).length > 0;
  }

  #schedule(): void {
    if (this.#stopped || this.#signal?.aborted === true) return;
    const delay = this.#contextComplete() ? GEO_REFRESH_MS : GEO_RETRY_EMPTY_MS;
    this.#nextLoadAt = this.#nowMs() + delay;
    this.#cancel = this.#timer(async () => {
      this.#cancel = null;
      await this.load();
      this.#schedule();
    }, delay);
  }

  async #loadBoth(): Promise<void> {
    // In parallel; both go to the cockpit and queue in its host bucket anyway.
    const [municipalities, boundaries] = await Promise.all([
      this.#fetchFile(this.#sources.municipalities, this.#municipalities, () => this.#keptMunicipalities()),
      this.#fetchFile(this.#sources.boundaries, this.#boundaries, () => this.#keptBoundaries()),
    ]);
    if (municipalities !== null) this.#geo.setMunicipalities(municipalities.gemeinden);
    if (boundaries !== null) this.#applyBoundaries(boundaries);
    if (municipalities !== null || boundaries !== null) {
      this.#log.info(
        `geo context loaded: ${countText(this.#geo.municipalities?.length ?? null)} municipalities, ` +
          `${countText(this.#boundaryCount())} polygons`,
      );
    }
  }

  #boundaryCount(): number | null {
    const boundaries = this.#geo.boundaries;
    return boundaries === null ? null : Object.keys(boundaries).length;
  }

  #applyBoundaries(parsed: ParsedBoundaries): void {
    // Set even when empty or degraded, exactly as grenzen-bw does: an empty
    // set makes the strict connectors skip, a degraded one blocks the prunes —
    // instead of carrying on with boundaries the source no longer vouches for.
    this.#geo.setBoundaries(parsed.boundaries, parsed.skipped);
    const file = this.#sources.boundaries.file;
    const issue =
      Object.keys(parsed.boundaries).length === 0
        ? `${file} contained no usable polygon — connectors with strict lookup skip their runs`
        : parsed.skipped > 0
          ? `${file}: ${String(parsed.skipped)} unusable entries skipped — no prune while degraded`
          : null;
    // Once per problem, not every 6 h.
    if (issue !== null && issue !== this.#boundaryIssue) this.#log.warn(`geo bootstrap: ${issue}`);
    this.#boundaryIssue = issue;
  }

  #keptMunicipalities(): string {
    const rows = this.#geo.municipalities;
    return rows === null
      ? "no municipality rows yet, geo-dependent connectors skip their runs"
      : `previous ${String(rows.length)} municipality rows kept`;
  }

  #keptBoundaries(): string {
    const count = this.#boundaryCount();
    return count === null
      ? "no boundaries yet, connectors with strict lookup skip their runs"
      : `previous ${String(count)} polygons kept`;
  }

  /** The parsed file, or `null` after a failure (already logged). */
  async #fetchFile<T>(source: GeoFileSource<T>, state: SourceState, kept: () => string): Promise<T | null> {
    const url = source.url(this.#env);
    let failure: string;
    try {
      const response = await this.#fetch.json(url, { signal: this.#signal });
      if (response.ok) {
        const parsed = source.parse(response.body);
        if (state.error !== null) this.#log.info(`geo bootstrap: ${source.file} loadable again`);
        state.loadedAt = this.#nowMs();
        state.error = null;
        state.failingSince = null;
        return parsed;
      }
      failure = `HTTP ${String(response.status)}`;
    } catch (error) {
      // Shutdown: not a fault of the source.
      if (this.#signal?.aborted === true) return null;
      failure = messageOf(error);
    }
    // One [warn] per failure streak; the context stays as it is.
    const text = `geo bootstrap: ${source.file} not loadable (${failure}) — ${kept()}`;
    if (state.error === null) this.#log.warn(text);
    else this.#log.debug(text);
    state.error = failure;
    state.failingSince ??= this.#nowMs();
    return null;
  }
}

export function createGeoBootstrap(options: GeoBootstrapOptions): GeoBootstrap {
  return new GeoBootstrap(options);
}

/** The geo context as `/healthz` reports it — filled by the bootstrap or by connectors. */
export function geoHealth(geo: SharedGeo, bootstrap: GeoBootstrap | undefined): GeoHealth {
  const rows = geo.municipalities;
  const boundaries = geo.boundaries;
  return {
    municipalities: rows === null ? null : rows.length,
    boundaries: boundaries === null ? null : Object.keys(boundaries).length,
    boundariesDegraded: geo.boundariesDegraded,
    bootstrap: bootstrap === undefined ? null : bootstrap.health(),
  };
}
