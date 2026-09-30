/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Per-connector state — `ctx.state` (see {@link ConnectorState} in
 * src/kernel/types.ts).
 *
 * The old function nodes kept values that are neither change signatures nor
 * prune bookkeeping in their flow or global context: the stop directory of
 * the departures endpoint, the MaStR rotation position, the run counter of
 * the particulate sensors, the car-sharing station cache. The ports first
 * parked them in module-level `WeakMap<Ctx, …>`s, because the contract had no
 * slot for them; this is that slot.
 *
 * ## Typed without an assertion
 *
 * A key is declared once per module, `stateKey<T>(name, initial, codec?)`,
 * and carries `T`. The values live in the key, per owning
 * {@link ConnectorState} — a `WeakMap` whose value type is `T` — so reading
 * one back needs no `as`. A store keyed by name alone could only hand out
 * `unknown`. The owner is the connector's state object, which the kernel
 * creates once per connector id ({@link StateStore.scope}), so `run` and
 * `routes` see the same values and no other connector sees them.
 *
 * ## Lifetime
 *
 * A key declared WITH a codec ({@link persisted}) is persisted in PostgreSQL
 * together with the change signatures and the prune bookkeeping
 * (src/kernel/persistence.ts): it is restored before the connector's first
 * run and written back when it changed — after `set`, and at the end of every
 * run, which also catches a `Map`/`Set` changed in place. A key without a
 * codec is a cache that lives as long as the process; use that only for what
 * the next run rebuilds anyway (the stop directory, the station cache).
 *
 * While the connector's persisted state is not loaded (database unreachable,
 * another instance holds the writer lock), reading a persisted key throws
 * {@link StateUnavailableError}: starting the MaStR rotation from 0 or the
 * particulate cadence from scratch is exactly what persisting it prevents.
 * The kernel turns that into a skipped run.
 *
 * The initial value is a factory: a fresh `Map`/`Set` per connector, never
 * one shared by all owners of a module-level key.
 */

import { isArray } from "./parse.js";
import type { ConnectorId, ConnectorState, JsonValue, StateCodec, StateKey, StateSlot } from "./types.js";

/**
 * Thrown by the change gate and by persisted `ctx.state` keys while the
 * connector's persisted state is not usable. Running on without it would mean
 * running on EMPTY tables — every gated entity written in full, the flood the
 * persistence exists to prevent. The kernel's run wrapper catches it and logs
 * the skip (src/kernel/context.ts, `runConnector`).
 */
export class StateUnavailableError extends Error {
  constructor(reason: string) {
    super(`state store not usable (${reason})`);
    this.name = "StateUnavailableError";
  }
}

/**
 * What the persistence attaches to one connector's state (kernel-internal,
 * see src/kernel/persistence.ts). Without it the state is memory only and
 * always usable — the parity harness and the unit tests run that way.
 */
export interface StateHooks {
  /** Throws {@link StateUnavailableError} while the persisted state is not loaded. */
  assertUsable(): void;
  /** A persisted value was `set`; schedule a write. */
  changed(): void;
  /** A persisted value could not be decoded and starts from its initial value. */
  invalid(name: string): void;
}

/** The persisted cells of one connector, as the persistence reads and restores them. */
export interface StateSnapshotter {
  /** Encoded current value of every persisted key used so far. */
  snapshot(): ReadonlyMap<string, JsonValue>;
  /**
   * Replaces the persisted values with what the store returned (external,
   * `unknown`): existing cells are decoded in place, keys not used yet pick
   * their value up on first use. A key missing from `values` starts over
   * from its initial value.
   */
  restore(values: ReadonlyMap<string, unknown>): void;
}

interface PersistedCell {
  encode(): JsonValue;
  restore(raw: unknown): void;
}

class MemoryConnectorState implements ConnectorState, StateSnapshotter {
  /** Name -> the key that claimed it, so two keys cannot silently share a name. */
  readonly #claimed = new Map<string, object>();
  readonly #cells = new Map<string, PersistedCell>();
  #loaded: ReadonlyMap<string, unknown> = new Map();
  #hooks: StateHooks | null = null;

  slot<T>(key: StateKey<T>): StateSlot<T> {
    const claimedBy = this.#claimed.get(key.name);
    if (claimedBy === undefined) this.#claimed.set(key.name, key);
    else if (claimedBy !== key) throw new Error(`state key "${key.name}" is declared twice`);
    return key.slotIn(this);
  }

  keys(): readonly string[] {
    return [...this.#claimed.keys()];
  }

  attach(hooks: StateHooks): void {
    this.#hooks = hooks;
  }

  snapshot(): ReadonlyMap<string, JsonValue> {
    return new Map([...this.#cells].map(([name, cell]) => [name, cell.encode()]));
  }

  restore(values: ReadonlyMap<string, unknown>): void {
    this.#loaded = values;
    for (const [name, cell] of this.#cells) cell.restore(values.get(name));
  }

  /* ── used by MemoryStateKey for keys with a codec ── */

  assertUsable(): void {
    this.#hooks?.assertUsable();
  }

  changed(): void {
    this.#hooks?.changed();
  }

  invalid(name: string): void {
    this.#hooks?.invalid(name);
  }

  loadedValue(name: string): unknown {
    return this.#loaded.get(name);
  }

  register(name: string, cell: PersistedCell): void {
    this.#cells.set(name, cell);
  }
}

class MemoryStateKey<T> implements StateKey<T> {
  readonly name: string;
  readonly #initial: () => T;
  readonly #codec: StateCodec<T> | undefined;
  readonly #cells = new WeakMap<ConnectorState, { value: T }>();

  constructor(name: string, initial: () => T, codec: StateCodec<T> | undefined) {
    this.name = name;
    this.#initial = initial;
    this.#codec = codec;
  }

  slotIn(owner: ConnectorState): StateSlot<T> {
    const codec = this.#codec;
    const persistedIn = codec !== undefined && owner instanceof MemoryConnectorState ? owner : null;
    persistedIn?.assertUsable();
    let cell = this.#cells.get(owner);
    if (cell === undefined) {
      const created = { value: this.#initial() };
      cell = created;
      this.#cells.set(owner, created);
      if (persistedIn !== null && codec !== undefined) {
        const decode = (raw: unknown): T => {
          if (raw === undefined) return this.#initial();
          const decoded = codec.decode(raw);
          if (decoded !== undefined) return decoded;
          persistedIn.invalid(this.name);
          return this.#initial();
        };
        created.value = decode(persistedIn.loadedValue(this.name));
        persistedIn.register(this.name, {
          encode: () => codec.encode(created.value),
          restore: (raw) => {
            created.value = decode(raw);
          },
        });
      }
    }
    const held = cell;
    return {
      get: () => held.value,
      set: (value: T) => {
        held.value = value;
        persistedIn?.changed();
      },
    };
  }
}

/**
 * Declares a piece of connector state. Call once, at module level:
 *
 *     const RUNS = stateKey("runs", () => 0, persisted.number);
 *     const runs = ctx.state.slot(RUNS);   // StateSlot<number>
 *     runs.set(runs.get() + 1);
 *
 * `initial` runs once per connector, on first use. With a `codec` the value
 * is persisted and survives a restart; without one it is a process-lifetime
 * cache (see the module header for which to choose).
 */
export function stateKey<T>(name: string, initial: () => T, codec?: StateCodec<T>): StateKey<T> {
  return new MemoryStateKey(name, initial, codec);
}

function finiteNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** Pairs `[[key, value], …]`, not an object: keeps the insertion order a `Map` iterates in. */
function decodePairs<V>(raw: unknown, value: (raw: unknown) => V | undefined): Map<string, V> | undefined {
  if (!isArray(raw)) return undefined;
  const map = new Map<string, V>();
  for (const pair of raw) {
    if (!isArray(pair) || pair.length !== 2) return undefined;
    const [key, rawValue] = pair;
    const decoded = value(rawValue);
    if (typeof key !== "string" || decoded === undefined) return undefined;
    map.set(key, decoded);
  }
  return map;
}

const numberCodec: StateCodec<number> = {
  encode: (value) => (Number.isFinite(value) ? value : null),
  decode: finiteNumber,
};

const booleanCodec: StateCodec<boolean> = {
  encode: (value) => value,
  decode: (raw) => (typeof raw === "boolean" ? raw : undefined),
};

const numberMapCodec: StateCodec<Map<string, number>> = {
  encode: (value) => [...value].map(([key, n]) => [key, n]),
  decode: (raw) => decodePairs(raw, finiteNumber),
};

function stringList(raw: unknown): readonly string[] | undefined {
  if (!isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return undefined;
    out.push(item);
  }
  return out;
}

const stringListMapCodec: StateCodec<Map<string, readonly string[]>> = {
  encode: (value) => [...value].map(([key, list]) => [key, [...list]]),
  decode: (raw) => decodePairs(raw, stringList),
};

/** Codecs for the value shapes persisted connector state actually has. */
export const persisted = {
  number: numberCodec,
  boolean: booleanCodec,
  /** A `Map` of numbers, stored as pairs so it iterates in the same order after a restart. */
  numberMap: numberMapCodec,
  /** A `Map` of string lists, stored as pairs as well. */
  stringListMap: stringListMapCodec,
} as const;

/** A connector state of its own — for tests and for {@link StateStore}. */
export function createConnectorState(): ConnectorState {
  return new MemoryConnectorState();
}

/**
 * The state of every connector, one {@link ConnectorState} per id — the
 * counterpart of the signature store's `scope(id)`. A second ctx for the same
 * id (a test, a route built separately) sees the same state.
 */
export class StateStore {
  readonly #scopes = new Map<ConnectorId, MemoryConnectorState>();

  #owner(id: ConnectorId): MemoryConnectorState {
    let state = this.#scopes.get(id);
    if (state === undefined) {
      state = new MemoryConnectorState();
      this.#scopes.set(id, state);
    }
    return state;
  }

  scope(id: ConnectorId): ConnectorState {
    return this.#owner(id);
  }

  /** Kernel-internal: connects `id`'s persisted keys to the state store. */
  attach(id: ConnectorId, hooks: StateHooks): StateSnapshotter {
    const owner = this.#owner(id);
    owner.attach(hooks);
    return owner;
  }
}
