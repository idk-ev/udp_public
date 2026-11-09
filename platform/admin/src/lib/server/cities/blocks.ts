/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { audit, type AuditActor } from "../audit.ts";
import type { Queryable } from "../db/client.ts";
import { integer, nullableTimestamp, single, text } from "../db/rows.ts";
import { confirmationText, resolveCity, type BlockTarget, type CityCatalog } from "./catalog.ts";
import { parseBlocks } from "./files.ts";
import { parseKind, publishBlocks, type CityDeps, type PublishOutcome } from "./publish.ts";

/**
 * Taking public pages offline and bringing them back. Used by the panel with the
 * logged-in user as the actor, and by the operator CLI. The database change stands
 * even if publishing fails: the panel retries every minute.
 */

export const MAX_REASON_LENGTH = 500;

/** How the CLI appears as an author. Not a possible username: those have no spaces. */
const OPERATOR_NAME = "Betrieb (Kommandozeile)";

export type BlockResult =
  | { kind: "ok"; city: BlockTarget; publish: PublishOutcome }
  | { kind: "unknown_city" }
  | { kind: "invalid_reason" }
  | { kind: "wrong_confirmation"; city: BlockTarget }
  | { kind: "already_blocked"; city: BlockTarget };

export type UnblockResult =
  | { kind: "ok"; city: BlockTarget; publish: PublishOutcome }
  | { kind: "unknown_city" }
  | { kind: "invalid_reason" }
  | { kind: "not_blocked"; city: BlockTarget }
  /** Not in the database, and the published state could not be read to look there. */
  | { kind: "publish_failed"; city: BlockTarget; message: string };

export interface BlockChange {
  /** Slug, municipality key or district key; see resolveCity. */
  city: string;
  reason: string;
  actor: AuditActor;
  /** What the person typed, where a person confirms (the panel). */
  confirmation?: string;
}

function comparable(value: string): string {
  return value.trim().replace(/\s+/g, " ").normalize("NFC").toLocaleLowerCase("de");
}

/** Confirms the page by its name; a slip of the case or of spaces does not matter. */
export function confirmsCity(catalog: CityCatalog, city: BlockTarget, typed: string): boolean {
  return comparable(typed) === comparable(confirmationText(catalog, city));
}

function normalizeReason(reason: string): string | null {
  const value = reason.trim();
  const lengthOk = value.length >= 1 && value.length <= MAX_REASON_LENGTH;
  // One line of text: it is shown in tables and written to terminals.
  return lengthOk && !/\p{Cc}/u.test(value) ? value : null;
}

function actorName(actor: AuditActor): string {
  if ("id" in actor) return actor.username;
  return actor.label === "cli" ? OPERATOR_NAME : actor.label;
}

async function nextGeneration(tx: Queryable): Promise<void> {
  await tx.query(
    `WITH raised AS (UPDATE city_block_state SET generation = generation + 1 RETURNING generation)
     INSERT INTO city_block_changes (generation) SELECT generation FROM raised`,
  );
}

export async function blockCity(deps: CityDeps, change: BlockChange): Promise<BlockResult> {
  const city = resolveCity(deps.catalog, change.city);
  if (city === null) return { kind: "unknown_city" };
  const reason = normalizeReason(change.reason);
  if (reason === null) return { kind: "invalid_reason" };
  if (change.confirmation !== undefined && !confirmsCity(deps.catalog, city, change.confirmation)) {
    return { kind: "wrong_confirmation", city };
  }
  const inserted = await deps.db.transaction(async (tx) => {
    const rows = await tx.query(
      `INSERT INTO city_blocks (kind, key, slug, name, reason, blocked_by)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (kind, key) DO NOTHING RETURNING key`,
      [city.kind, city.key, city.slug, city.name, reason, actorName(change.actor)],
    );
    if (rows.length === 0) return false;
    await nextGeneration(tx);
    await audit(tx, { actor: change.actor, action: "city.blocked", target: city.slug, details: { reason } });
    return true;
  });
  if (!inserted) return { kind: "already_blocked", city };
  return { kind: "ok", city, publish: await publishBlocks(deps) };
}

/**
 * A block by the catalogue, or else by what the database and the published state still
 * have: its key can have left the catalogue, and it must still be possible to lift it.
 * The catalogue goes first: a slug reassigned to another page means that page.
 */
async function findTarget(deps: CityDeps, input: string): Promise<BlockTarget | null> {
  const known = resolveCity(deps.catalog, input);
  if (known !== null) return known;
  const value = input.trim().toLowerCase();
  const [blocks, status] = await Promise.all([listBlocks(deps.db), publishStatus(deps.db)]);
  return [...blocks, ...status.held].find((block) => block.key === value || block.slug === value) ?? null;
}

/**
 * An explicit unblock lifts this page and only this page, whether the database has it
 * or it is held from a state the database lost.
 */
export async function unblockCity(deps: CityDeps, change: BlockChange): Promise<UnblockResult> {
  const city = await findTarget(deps, change.city);
  if (city === null) return { kind: "unknown_city" };
  const reason = normalizeReason(change.reason);
  if (reason === null) return { kind: "invalid_reason" };
  const record = (tx: Queryable): Promise<void> =>
    audit(tx, { actor: change.actor, action: "city.unblocked", target: city.slug, details: { reason } });
  const removed = await deps.db.transaction(async (tx) => {
    const rows = await tx.query("DELETE FROM city_blocks WHERE kind = $1 AND key = $2 RETURNING key", [
      city.kind,
      city.key,
    ]);
    if (rows.length === 0) return false;
    await nextGeneration(tx);
    await record(tx);
    return true;
  });
  const publish = await publishBlocks(deps, { release: city });
  if (removed) return { kind: "ok", city, publish };
  if (publish.kind === "failed") return { kind: "publish_failed", city, message: publish.message };
  if (!publish.released) return { kind: "not_blocked", city };
  await record(deps.db);
  return { kind: "ok", city, publish };
}

/** Lets the database win over a published state it is behind (see publishBlocks). */
export async function acceptDatabase(deps: CityDeps, actor: AuditActor): Promise<PublishOutcome> {
  const outcome = await publishBlocks(deps, { acceptDatabase: true });
  if (outcome.kind === "published") await audit(deps.db, { actor, action: "city.publication_accepted" });
  return outcome;
}

export interface CityBlock extends BlockTarget {
  reason: string;
  blockedBy: string;
  blockedAt: Date;
}

export interface PublishStatus {
  generation: number;
  lastAttemptAt: Date | null;
  lastPublishedAt: Date | null;
  lastError: string | null;
  lastWarning: string | null;
  /** Blocks enforced although the database no longer has them. */
  held: readonly BlockTarget[];
  /** Brought back by a restored database in the last 14 days. */
  reimposed: readonly BlockTarget[];
}

export async function listBlocks(db: Queryable): Promise<readonly CityBlock[]> {
  const rows = await db.query(
    "SELECT kind, key, slug, name, reason, blocked_by, blocked_at FROM city_blocks ORDER BY blocked_at DESC, key",
  );
  return rows.map((row) => {
    const blockedAt = nullableTimestamp(row, "blocked_at");
    if (blockedAt === null) throw new TypeError("column blocked_at: expected timestamp");
    return {
      kind: parseKind(text(row, "kind")),
      key: text(row, "key"),
      slug: text(row, "slug"),
      name: text(row, "name"),
      reason: text(row, "reason"),
      blockedBy: text(row, "blocked_by"),
      blockedAt,
    };
  });
}

function optional(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export async function publishStatus(db: Queryable): Promise<PublishStatus> {
  const row = single(
    await db.query(
      `SELECT generation, last_attempt_at, last_published_at, last_error, last_warning, held::text AS held,
         (CASE WHEN reimposed_at > now() - interval '14 days' THEN reimposed ELSE '[]'::jsonb END)::text AS reimposed
       FROM city_block_state`,
    ),
  );
  const held: unknown = JSON.parse(text(row, "held"));
  const reimposed: unknown = JSON.parse(text(row, "reimposed"));
  return {
    generation: integer(row, "generation"),
    lastAttemptAt: nullableTimestamp(row, "last_attempt_at"),
    lastPublishedAt: nullableTimestamp(row, "last_published_at"),
    lastError: optional(row.last_error),
    lastWarning: optional(row.last_warning),
    held: parseBlocks(held),
    reimposed: parseBlocks(reimposed),
  };
}
