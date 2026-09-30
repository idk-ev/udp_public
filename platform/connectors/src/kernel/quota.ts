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
}

export const QUOTA_STATE_KEY = "kernel.hostQuota";

/** `YYYY-MM-DD` of `ms` in UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Stored as `{ "<host>": { "day": "YYYY-MM-DD", "units": n } }`. */
const codec: StateCodec<ReadonlyMap<string, DayUnits>> = {
  encode: (value) => Object.fromEntries([...value].map(([host, entry]) => [host, { ...entry }])),
  decode: (raw) => {
    if (!isRecord(raw)) return undefined;
    const out = new Map<string, DayUnits>();
    for (const [host, entry] of Object.entries(raw)) {
      if (!isRecord(entry) || isArray(entry)) return undefined;
      const { day, units } = entry;
      if (typeof day !== "string" || typeof units !== "number" || !Number.isFinite(units) || units < 0) {
        return undefined;
      }
      out.set(host, { day, units });
    }
    return out;
  },
};

const QUOTA = stateKey<ReadonlyMap<string, DayUnits>>(QUOTA_STATE_KEY, () => new Map(), codec, {
  bestEffort: true,
});

function unitsOn(entry: DayUnits | undefined, day: string): number {
  return entry?.day === day ? entry.units : 0;
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
    for (const id of ids) sum += this.#share(id, host, day, stored);
    return sum;
  }

  /** Charges `units` to `host` for connector `id` and persists its share in `state`. */
  charge(id: ConnectorId, state: ConnectorState, host: string, units: number): void {
    if (!Number.isFinite(units) || units <= 0) return;
    const day = utcDay(this.#nowMs());
    const next: DayUnits = { day, units: this.#share(id, host, day, this.#stored()) + units };
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
  ): number {
    return Math.max(unitsOn(this.#memory.get(id)?.get(host), day), unitsOn(stored.get(id)?.get(host), day));
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
