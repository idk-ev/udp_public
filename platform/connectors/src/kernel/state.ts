/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Per-connector in-memory state — `ctx.state` (see {@link ConnectorState} in
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
 * A key is declared once per module, `stateKey<T>(name, initial)`, and carries
 * `T`. The values live in the key, per owning {@link ConnectorState} — a
 * `WeakMap` whose value type is `T` — so reading one back needs no `as`. A
 * store keyed by name alone could only hand out `unknown`. The owner is the
 * connector's state object, which the kernel creates once per connector id
 * ({@link StateStore.scope}), so `run` and `routes` see the same values and no
 * other connector sees them.
 *
 * ## Lifetime
 *
 * In memory, lost on restart, exactly as the flow context was in Kubernetes
 * (no volume on `/data`). The signature store (src/kernel/change-gate.ts) and
 * the prune bookkeeping (src/kernel/prune.ts) live the same way; all three
 * move to Postgres together in phase 6 (docs/migration-konnektoren.md). Values
 * that are to survive that move must then be serialisable, which is why the
 * initial value is a factory: a fresh `Map`/`Set` per connector, never one
 * shared by all owners of a module-level key.
 */

import type { ConnectorId, ConnectorState, StateKey, StateSlot } from "./types.js";

class MemoryStateKey<T> implements StateKey<T> {
  readonly name: string;
  readonly #initial: () => T;
  readonly #cells = new WeakMap<ConnectorState, { value: T }>();

  constructor(name: string, initial: () => T) {
    this.name = name;
    this.#initial = initial;
  }

  slotIn(owner: ConnectorState): StateSlot<T> {
    let cell = this.#cells.get(owner);
    if (cell === undefined) {
      cell = { value: this.#initial() };
      this.#cells.set(owner, cell);
    }
    const held = cell;
    return {
      get: () => held.value,
      set: (value: T) => {
        held.value = value;
      },
    };
  }
}

/**
 * Declares a piece of connector state. Call once, at module level:
 *
 *     const RUNS = stateKey("runs", () => 0);
 *     const runs = ctx.state.slot(RUNS);   // StateSlot<number>
 *     runs.set(runs.get() + 1);
 *
 * `initial` runs once per connector, on first use.
 */
export function stateKey<T>(name: string, initial: () => T): StateKey<T> {
  return new MemoryStateKey(name, initial);
}

class MemoryConnectorState implements ConnectorState {
  /** Name -> the key that claimed it, so two keys cannot silently share a name. */
  readonly #claimed = new Map<string, object>();

  slot<T>(key: StateKey<T>): StateSlot<T> {
    const claimedBy = this.#claimed.get(key.name);
    if (claimedBy === undefined) this.#claimed.set(key.name, key);
    else if (claimedBy !== key) throw new Error(`state key "${key.name}" is declared twice`);
    return key.slotIn(this);
  }

  keys(): readonly string[] {
    return [...this.#claimed.keys()];
  }
}

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
  readonly #scopes = new Map<ConnectorId, ConnectorState>();

  scope(id: ConnectorId): ConnectorState {
    let state = this.#scopes.get(id);
    if (state === undefined) {
      state = createConnectorState();
      this.#scopes.set(id, state);
    }
    return state;
  }
}
