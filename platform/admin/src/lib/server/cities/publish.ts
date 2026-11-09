/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { audit } from "../audit.ts";
import type { Db, Queryable } from "../db/client.ts";
import { integer, single, text } from "../db/rows.ts";
import { resolveCity, type BlockKind, type BlockTarget, type CityCatalog } from "./catalog.ts";
import {
  blockId,
  buildFiles,
  markerOf,
  parsePublication,
  PUBLICATION_FILE,
  RECOVERED,
  type Publication,
} from "./files.ts";
import type { Publisher } from "./publisher.ts";

export interface CityDeps {
  db: Db;
  catalog: CityCatalog;
  publisher: Publisher;
}

export type PublishOutcome =
  /** released: `release` named a block that was published until now. */
  | { kind: "published"; changed: boolean; released: boolean }
  /** The database is behind the published files; these blocks stay enforced. */
  | { kind: "held"; orphans: readonly BlockTarget[]; released: boolean }
  | { kind: "failed"; message: string };

export interface PublishOptions {
  /** Operator CLI, `city publish --accept-database`: the database wins. */
  acceptDatabase?: boolean;
  /** An explicit unblock of this page: it goes, and only it, even while others are held. */
  release?: Pick<BlockTarget, "kind" | "key">;
}

/** Any fixed number; publishes from the panel and from the CLI take turns. */
const PUBLISH_LOCK = 7_301_943;

export function parseKind(value: string): BlockKind {
  if (value === "gemeinde" || value === "kreis") return value;
  throw new TypeError(`unknown block kind in the database: ${value}`);
}

async function readBlocks(db: Queryable): Promise<readonly BlockTarget[]> {
  const rows = await db.query("SELECT kind, key, slug, name FROM city_blocks ORDER BY kind, key");
  return rows.map((row) => ({
    kind: parseKind(text(row, "kind")),
    key: text(row, "key"),
    slug: text(row, "slug"),
    name: text(row, "name"),
  }));
}

/**
 * The slug of the current catalogue where it knows the page: a renamed page must be
 * blocked under the address it has now.
 */
function currentSlug(catalog: CityCatalog, block: BlockTarget): BlockTarget {
  const slug =
    block.kind === "gemeinde"
      ? catalog.gemeinden.find((gemeinde) => gemeinde.ags === block.key)?.slug
      : catalog.kreise.find((kreis) => kreis.key === block.key)?.slug;
  return slug === undefined ? block : { ...block, slug };
}

interface Published {
  marker: Publication | null;
  /** Blocks whose files exist although the marker does not list them. */
  unexplained: readonly BlockTarget[];
  /** Everything the public site enforces right now, as far as it can be named. */
  blocks: readonly BlockTarget[];
  warnings: readonly string[];
}

/** Reads what is published. Marker files count even if the marker is lost or damaged. */
function readPublished(files: ReadonlyMap<string, string>, catalog: CityCatalog): Published {
  const { publication: marker, dropped } = parsePublication(files.get(PUBLICATION_FILE));
  const warnings: string[] = [];
  if (dropped > 0) warnings.push(`${String(dropped)} invalid entries in ${PUBLICATION_FILE} ignored`);
  if (marker === null && files.has(PUBLICATION_FILE)) warnings.push(`${PUBLICATION_FILE} is unreadable`);

  const known = marker?.blocks ?? [];
  const explained = new Set(known.flatMap((block) => [`slug:${block.slug}`, `key:${block.key}`]));
  const unexplained = new Map<string, BlockTarget>();
  for (const name of files.keys()) {
    const found = markerOf(name);
    if (found === null) continue;
    const value = "slug" in found ? found.slug : found.ags;
    if (explained.has("slug" in found ? `slug:${value}` : `key:${value}`)) continue;
    const city = resolveCity(catalog, value);
    // A file for an address nobody has: there is no page behind it to keep offline.
    if (city === null) warnings.push(`${name} names no known page and was dropped`);
    else unexplained.set(blockId(city), city);
  }
  if (unexplained.size > 0) warnings.push(`marker files without an entry in ${PUBLICATION_FILE}`);
  const blocks = [...known, ...unexplained.values()];
  return { marker, unexplained: [...unexplained.values()], blocks, warnings };
}

/**
 * What to publish. A published block the database does not have is either an ordinary
 * unblock, or the database lost it (restored from a backup, emptied, replaced). The
 * published marker tells them apart: it names the change it came from. If the database
 * does not have that change, or the files say more than the marker, nothing is lifted:
 * those pages stay offline, new blocks still go out, and the marker stays as it was,
 * so that the next run reaches the same conclusion for as long as it takes.
 */
function plan(
  published: Published,
  head: Publication,
  descends: boolean,
  options: PublishOptions,
): { publication: Publication; orphans: readonly BlockTarget[]; behind: boolean } {
  const { marker, unexplained } = published;
  const behind = unexplained.length > 0 || (marker !== null && !descends);
  const wanted = new Set(head.blocks.map(blockId));
  const released = options.release === undefined ? null : blockId(options.release);
  const orphans = behind
    ? published.blocks.filter((block) => !wanted.has(blockId(block)) && blockId(block) !== released)
    : [];
  if (orphans.length === 0 || options.acceptDatabase === true) return { publication: head, orphans: [], behind };
  const origin = marker !== null && unexplained.length === 0 ? marker : RECOVERED;
  return {
    publication: { generation: origin.generation, change: origin.change, blocks: [...head.blocks, ...orphans] },
    orphans,
    behind,
  };
}

async function descendsFrom(tx: Queryable, marker: Publication | null): Promise<boolean> {
  if (marker === null) return false;
  const [row] = await tx.query("SELECT change_id::text AS change FROM city_block_changes WHERE generation = $1", [
    marker.generation,
  ]);
  return row !== undefined && text(row, "change") === marker.change;
}

/**
 * Blocks in the database the public site no longer had: lifted after the backup that
 * was restored. They take effect again, which fails closed, but someone should know.
 * Reported once per published state. The first change after a restore can be among
 * them; nothing tells those apart.
 */
async function reportReimposed(tx: Queryable, published: Published, head: Publication): Promise<void> {
  const identity = published.marker === null ? "none" : `${String(published.marker.generation)}:${published.marker.change}`;
  const [row] = await tx.query("SELECT reported_marker FROM city_block_state");
  if (row?.reported_marker === identity) return;
  const had = new Set(published.blocks.map(blockId));
  const reimposed = head.blocks.filter((block) => !had.has(blockId(block)));
  await tx.query(
    `UPDATE city_block_state SET reported_marker = $1,
       reimposed = CASE WHEN $2::boolean THEN $3::jsonb ELSE reimposed END,
       reimposed_at = CASE WHEN $2::boolean THEN now() ELSE reimposed_at END`,
    [identity, reimposed.length > 0, JSON.stringify(reimposed)],
  );
  if (reimposed.length === 0) return;
  const pages = reimposed.map((block) => block.slug).join(", ");
  await audit(tx, { actor: { label: "system" }, action: "city.blocks_restored", details: { pages } });
  console.error(`[admin] CITY BLOCKS RESTORED: the database is older and brought back: ${pages}`);
}

async function recordSuccess(
  tx: Queryable,
  result: { held: readonly BlockTarget[]; warning: string | null; accepted: boolean },
): Promise<void> {
  await tx.query(
    `UPDATE city_block_state SET
       last_attempt_at = now(), last_published_at = now(), last_error = NULL,
       last_warning = $1, held = $2::jsonb,
       reimposed = CASE WHEN $3::boolean THEN '[]'::jsonb ELSE reimposed END`,
    [result.warning, JSON.stringify(result.held), result.accepted],
  );
}

/**
 * Makes the published files match the database. Idempotent; the panel calls it after
 * each change and every minute, so a failed attempt repairs itself. Never rejects:
 * failures are logged, stored for the panel and returned.
 */
export async function publishBlocks(deps: CityDeps, options: PublishOptions = {}): Promise<PublishOutcome> {
  const { db, catalog, publisher } = deps;
  try {
    const outcome = await db.transaction(async (tx): Promise<PublishOutcome> => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [PUBLISH_LOCK]);
      // Files first: a change committed after this read can only make the database
      // look newer than the files, never behind them.
      const current = await publisher.read();
      const published = readPublished(current, catalog);
      const state = single(
        await tx.query(
          `SELECT s.generation, c.change_id::text AS change FROM city_block_state s
           JOIN city_block_changes c ON c.generation = s.generation`,
        ),
      );
      const head: Publication = {
        generation: integer(state, "generation"),
        change: text(state, "change"),
        blocks: (await readBlocks(tx)).map((block) => currentSlug(catalog, block)),
      };
      const descends = await descendsFrom(tx, published.marker);
      const { publication, orphans, behind } = plan(published, head, descends, options);
      if (behind && options.acceptDatabase !== true) await reportReimposed(tx, published, head);

      const changed = await publisher.write(buildFiles(catalog, publication), current);
      const accepted = options.acceptDatabase === true;
      const warning = published.warnings.length > 0 ? published.warnings.join("; ") : null;
      if (warning !== null) console.warn(`[admin] published city blocks: ${warning}`);
      await recordSuccess(tx, { held: orphans, warning, accepted });
      const releasedId = options.release === undefined ? null : blockId(options.release);
      const released = published.blocks.some((block) => blockId(block) === releasedId);
      return orphans.length > 0 ? { kind: "held", orphans, released } : { kind: "published", changed, released };
    });
    if (outcome.kind === "held") {
      const names = outcome.orphans.map((block) => block.slug).join(", ");
      console.error(
        `[admin] CITY BLOCKS HELD: the database is behind the published state and no longer has: ${names}. ` +
          "These pages stay offline. Lift one with city unblock; if the database is right about all of them: " +
          "city publish --accept-database",
      );
    }
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[admin] publishing city blocks failed: ${message}`);
    // Outside the failed transaction, and what is held stays as it was. If the
    // database is the problem, the log has to do.
    await db
      .query("UPDATE city_block_state SET last_attempt_at = now(), last_error = $1", [message])
      .catch(() => undefined);
    return { kind: "failed", message };
  }
}
