/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Change detection over value signatures — port of `gateChanged` from
 * CHUNK_HELPER in scripts/generate-nodered-flows.py.
 *
 * Why it exists, in the words of the original:
 *
 *   > Nur Entitäten mit geänderter Wertsignatur behalten. Orion-LD schreibt bei
 *   > options=update je Attribut eine TRoE-Zeile — unabhängig davon, ob sich der
 *   > Wert geändert hat. Ein über Stunden konstanter Pegel/Warnstatus/Median
 *   > erzeugt so unnötig Volumen. sigOf(e) muss die Messwerte hashen, NICHT den
 *   > dateObserved-Zeitstempel.
 *
 * An unchanged entity is not dropped: it is reduced to `{ id, type,
 * dateObserved, @context }`. With `options=update` Orion replaces only the
 * attributes actually sent, so the value rows are saved while the health check
 * and the frontend still see that the data is current. An entity that is
 * unchanged AND carries no `dateObserved` falls out entirely — there would be
 * nothing left to send.
 *
 * ## merge vs. replace
 *
 * The default is MERGING, and the reason is worth reading twice:
 *
 *   > Flows wie das GBFS-Carsharing rufen die Erkennung einmal je System auf und
 *   > tragen jeweils nur einen Teilbestand bei; ein Ersetzen würde die Tabelle
 *   > bei jedem System auf dessen Stationen eindampfen und die Erkennung
 *   > wirkungslos machen. Für Flows, die den GANZEN Bestand in einem Lauf sehen
 *   > (Parken landesweit), ist Mergen dagegen ein Leck: Entitäten, die aus der
 *   > Quelle verschwinden, bleiben für immer in der Signaturtabelle stehen.
 *
 * So: `replace: true` if and only if the connector sees the whole stock in one
 * call. Choosing wrongly either disables the gate (replace on a partial run) or
 * leaks memory forever (merge on a full run).
 *
 * ## Why in memory, for now
 *
 * The store lives in the process and is lost on restart — the same behaviour as
 * today, where the Node-RED flow context is deliberately not persisted in
 * Kubernetes (no volume on /data). Postgres would fix that, and the migration
 * plan explicitly defers it until parity is green:
 *
 *   > Erst *nach* grüner Parität umstellen — vorher verfälscht es genau die
 *   > Diffs, mit denen geprüft wird.
 *
 * A persistent store would mean the first run after a restart sees a populated
 * signature table where the old runtime saw an empty one, and the two sides
 * would legitimately produce different entity arrays. The safety net has to be
 * in place before the thing it measures is changed.
 */

import type { ChangeGate, ChangeGateOptions, Log, NgsiEntity } from "./types.js";

/** Signatures of one store key: entity id to value signature. */
type SignatureTable = Map<string, string>;

class MemoryChangeGate implements ChangeGate {
  readonly #log: Log;
  readonly #tables = new Map<string, SignatureTable>();

  constructor(log: Log) {
    this.#log = log;
  }

  gateChanged<T extends NgsiEntity>(
    key: string,
    entities: readonly T[],
    sigOf: (entity: T) => string,
    options?: ChangeGateOptions,
  ): readonly NgsiEntity[] {
    const replace = options?.replace ?? false;
    const previous = this.#tables.get(key) ?? new Map<string, string>();
    const next: SignatureTable = new Map();
    const out: NgsiEntity[] = [];
    let changed = 0;

    for (const entity of entities) {
      const signature = sigOf(entity);
      next.set(entity.id, signature);
      if (previous.get(entity.id) !== signature) {
        out.push(entity);
        changed += 1;
        continue;
      }
      const dateObserved = entity.dateObserved;
      if (dateObserved === undefined) continue;
      // Freshness only: id, type, dateObserved, context. Nothing else, or the
      // saved TRoE rows come straight back.
      out.push({
        id: entity.id,
        type: entity.type,
        dateObserved,
        "@context": entity["@context"],
      });
    }

    if (replace) {
      this.#tables.set(key, next);
    } else {
      for (const [id, signature] of next) previous.set(id, signature);
      this.#tables.set(key, previous);
    }

    this.#log.status(`${String(changed)}/${String(entities.length)} changed (rest: freshness only)`);
    return out;
  }
}

export function createChangeGate(log: Log): ChangeGate {
  return new MemoryChangeGate(log);
}
