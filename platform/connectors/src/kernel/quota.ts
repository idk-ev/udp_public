/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Daily call budget per host — `ctx.quota`.
 *
 * Some providers limit what one client may send per day, across everything
 * it sends (Open-Meteo's free tier: 10,000 calls per day, one call per
 * coordinate). Several connectors can share such a host, so the counter is
 * kept per HOST, and it survives a restart: a restart that forgot the
 * morning's calls would plan the evening against an empty counter.
 *
 * ## Persisted per connector, summed per host
 *
 * Each connector persists only what IT charged — per host the day and the
 * units — under the key {@link QUOTA_STATE_KEY} in its own state. The book
 * sums every connector's share: per connector the larger of what this
 * process counted and what was stored before the restart (the process
 * starts counting from the stored value on the connector's first charge,
 * so the larger one is always the complete one). A connector that has not
 * run since the restart is still counted — its stored value is read, not
 * its memory.
 *
 * The key is best effort (src/kernel/state.ts): the budget must not stop a
 * connector while the database is down. The price: what a connector charges
 * while its state is not loaded is lost as soon as the stored value turns
 * out larger (the larger one wins, they are not added), and a restart during
 * such an outage starts from what was stored last. The soft caps leave room
 * for that.
 *
 * ## The day
 *
 * The UTC day. Open-Meteo documents no reset time; counting per UTC day is
 * the assumption, and the soft caps below the provider's limit leave room
 * for a different reset hour.
 */

import { isArray, isRecord } from "./parse.js";
import { createConnectorState, stateKey } from "./state.js";
import type { StateStore } from "./state.js";
import type { ConnectorId, ConnectorState, HostQuota, StateCodec } from "./types.js";

/** Units one connector charged to one host on one day. */
interface DayUnits {
  /** `YYYY-MM-DD`, UTC. */
  readonly day: string;
  readonly units: number;
  /** The provider said the day's limit is used up ({@link QuotaBook.exhaust}). */
  readonly exhausted?: true | undefined;
}

export const QUOTA_STATE_KEY = "kernel.hostQuota";

/** `YYYY-MM-DD` of `ms` in UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Stored as `{ "<host>": { "day": "YYYY-MM-DD", "units": n, "exhausted": true? } }`. */
const codec: StateCodec<ReadonlyMap<string, DayUnits>> = {
  encode: (value) =>
    Object.fromEntries(
      [...value].map(([host, entry]) => [
        host,
        entry.exhausted === true
          ? { day: entry.day, units: entry.units, exhausted: true }
          : { day: entry.day, units: entry.units },
      ]),
    ),
  decode: (raw) => {
    if (!isRecord(raw)) return undefined;
    const out = new Map<string, DayUnits>();
    for (const [host, entry] of Object.entries(raw)) {
      if (!isRecord(entry) || isArray(entry)) return undefined;
      const { day, units, exhausted } = entry;
      if (typeof day !== "string" || typeof units !== "number" || !Number.isFinite(units) || units < 0) {
        return undefined;
      }
      if (exhausted !== undefined && exhausted !== true) return undefined;
      out.set(host, exhausted === true ? { day, units, exhausted } : { day, units });
    }
    return out;
  },
};

const QUOTA = stateKey<ReadonlyMap<string, DayUnits>>(QUOTA_STATE_KEY, () => new Map(), codec, {
  bestEffort: true,
});

/** `entry` if it is of `day`. */
function onDay(entry: DayUnits | undefined, day: string): DayUnits | undefined {
  return entry?.day === day ? entry : undefined;
}

/** One per kernel: the counters of every connector and host. */
export class QuotaBook {
  readonly #store: StateStore | null;
  readonly #nowMs: () => number;
  /** Connector -> host -> what this process knows the connector charged. */
  readonly #memory = new Map<ConnectorId, Map<string, DayUnits>>();

  /** `store`: where the stored shares are read from; `null` = memory only (tests). */
  constructor(store: StateStore | null, nowMs: () => number = Date.now) {
    this.#store = store;
    this.#nowMs = nowMs;
  }

  /** Units charged to `host` today by every connector. */
  used(host: string): number {
    const day = utcDay(this.#nowMs());
    const stored = this.#stored();
    const ids = new Set([...this.#memory.keys(), ...stored.keys()]);
    let sum = 0;
    for (const id of ids) sum += this.#share(id, host, day, stored).units;
    return sum;
  }

  /** Whether any connector learned today (UTC) that `host`'s daily limit is used up. */
  exhausted(host: string): boolean {
    const day = utcDay(this.#nowMs());
    const stored = this.#stored();
    const ids = new Set([...this.#memory.keys(), ...stored.keys()]);
    for (const id of ids) if (this.#share(id, host, day, stored).exhausted === true) return true;
    return false;
  }

  /** Charges `units` to `host` for connector `id` and persists its share in `state`. */
  charge(id: ConnectorId, state: ConnectorState, host: string, units: number): void {
    if (!Number.isFinite(units) || units <= 0) return;
    const day = utcDay(this.#nowMs());
    const share = this.#share(id, host, day, this.#stored());
    this.#put(id, state, host, { ...share, units: share.units + units });
  }

  /**
   * Marks `host`'s limit as used up for the rest of the UTC day — the
   * provider said so. Persisted with the connector's share, so a restart
   * keeps it; the next day starts clean.
   */
  exhaust(id: ConnectorId, state: ConnectorState, host: string): void {
    const day = utcDay(this.#nowMs());
    this.#put(id, state, host, { ...this.#share(id, host, day, this.#stored()), exhausted: true });
  }

  #put(id: ConnectorId, state: ConnectorState, host: string, next: DayUnits): void {
    const day = next.day;
    let hosts = this.#memory.get(id);
    if (hosts === undefined) {
      hosts = new Map();
      this.#memory.set(id, hosts);
    }
    hosts.set(host, next);
    const slot = state.slot(QUOTA);
    // Other hosts stay; an entry of an earlier day is dropped with the next charge.
    const persisted = new Map([...slot.get()].filter(([, entry]) => entry.day === day));
    persisted.set(host, next);
    slot.set(persisted);
  }

  /** The {@link HostQuota} of one connector — `ctx.quota`. */
  forConnector(id: ConnectorId, state: ConnectorState): HostQuota {
    return {
      used: (host) => this.used(host),
      charge: (host, units) => {
        this.charge(id, state, host, units);
      },
      exhausted: (host) => this.exhausted(host),
      exhaust: (host) => {
        this.exhaust(id, state, host);
      },
    };
  }

  #stored(): ReadonlyMap<ConnectorId, ReadonlyMap<string, DayUnits>> {
    const out = new Map<ConnectorId, ReadonlyMap<string, DayUnits>>();
    if (this.#store === null) return out;
    for (const [id, raw] of this.#store.loadedValues(QUOTA_STATE_KEY)) {
      const decoded = codec.decode(raw);
      if (decoded !== undefined) out.set(id, decoded);
    }
    return out;
  }

  #share(
    id: ConnectorId,
    host: string,
    day: string,
    stored: ReadonlyMap<ConnectorId, ReadonlyMap<string, DayUnits>>,
  ): DayUnits {
    const memory = onDay(this.#memory.get(id)?.get(host), day);
    const loaded = onDay(stored.get(id)?.get(host), day);
    const units = Math.max(memory?.units ?? 0, loaded?.units ?? 0);
    const exhausted = memory?.exhausted === true || loaded?.exhausted === true;
    return exhausted ? { day, units, exhausted } : { day, units };
  }
}

const books = new WeakMap<StateStore, QuotaBook>();

/** The one book of the connectors whose state `store` holds — one per kernel. */
export function quotaBookOf(store: StateStore, nowMs: () => number = Date.now): QuotaBook {
  let book = books.get(store);
  if (book === undefined) {
    book = new QuotaBook(store, nowMs);
    books.set(store, book);
  }
  return book;
}

/** A quota of its own, memory only — for tests and hand-built contexts. */
export function memoryQuota(id: ConnectorId = "test", nowMs: () => number = Date.now): HostQuota {
  return new QuotaBook(null, nowMs).forConnector(id, createConnectorState());
}
