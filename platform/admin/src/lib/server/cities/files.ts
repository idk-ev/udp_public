/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import type { BlockKind, BlockTarget, CityCatalog } from "./catalog.ts";
import { kreisDisplayName, publicSlug, SLUG_PATTERN } from "./catalog.ts";

/**
 * The files the public site reads, computed from the blocks. Names are valid
 * ConfigMap keys (letters, digits, - . _), and nginx (cockpit.conf.template) knows
 * them by exactly these names:
 *
 *   slug-<slug>        exists -> /<slug> and /g/<slug>/ answer 410
 *   ags-<ags>          exists -> /stadt.html?ags=<ags> answers 410
 *   city-blocks.json   served as /city-blocks.json, read by the public pages
 *   sitemap.xml        served instead of the image's sitemap; only while blocks exist
 *   publication.json   never served; lets the next publish compare (publish.ts)
 */
export const PUBLIC_FILE = "city-blocks.json";
export const SITEMAP_FILE = "sitemap.xml";
export const PUBLICATION_FILE = "publication.json";

const SLUG_FILE = /^slug-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const AGS_FILE = /^ags-([0-9]{8})$/;

/** The placeholder of gui/public/sitemap.xml; nginx replaces it per response. */
const ORIGIN_PLACEHOLDER = "__PUBLIC_ORIGIN__";

/** Exactly the names above, and nothing else can ever be published. */
export function isPublishedFile(name: string): boolean {
  return (
    name === PUBLIC_FILE ||
    name === SITEMAP_FILE ||
    name === PUBLICATION_FILE ||
    SLUG_FILE.test(name) ||
    AGS_FILE.test(name)
  );
}

/** The slug or municipality key a marker file stands for. */
export function markerOf(name: string): { slug: string } | { ags: string } | null {
  const slug = SLUG_FILE.exec(name)?.[1];
  if (slug !== undefined) return { slug };
  const ags = AGS_FILE.exec(name)?.[1];
  return ags === undefined ? null : { ags };
}

/**
 * Where a publication came from: a row of city_block_changes. A publication that had
 * to be rebuilt from its marker files has none, see RECOVERED.
 */
export interface Publication {
  generation: number;
  change: string;
  blocks: readonly BlockTarget[];
}

/** Descends from no state of any database, so the next run stays careful as well. */
export const RECOVERED = { generation: -1, change: "recovered" } as const;

export function blockId(block: Pick<BlockTarget, "kind" | "key">): string {
  return `${block.kind}:${block.key}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isKind(value: unknown): value is BlockKind {
  return value === "gemeinde" || value === "kreis";
}

function keyFits(kind: BlockKind, key: string): boolean {
  return kind === "gemeinde" ? /^[0-9]{8}$/.test(key) : /^[0-9]{5}$/.test(key);
}

/** A block read from outside the database, or null if it could not have been written. */
export function parseBlock(value: unknown): BlockTarget | null {
  if (!isRecord(value)) return null;
  const { kind, key, slug, name } = value;
  if (!isKind(kind) || typeof key !== "string" || typeof slug !== "string" || typeof name !== "string") return null;
  return keyFits(kind, key) && SLUG_PATTERN.test(slug) ? { kind, key, slug, name } : null;
}

export function parseBlocks(value: unknown): readonly BlockTarget[] {
  return isList(value) ? value.map(parseBlock).filter((block) => block !== null) : [];
}

/**
 * The marker of the previous publish. Entries that are not valid are dropped and
 * counted: a damaged file can never stop publishing, and never becomes a file name.
 */
export function parsePublication(text: string | undefined): { publication: Publication | null; dropped: number } {
  if (text === undefined) return { publication: null, dropped: 0 };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { publication: null, dropped: 0 };
  }
  if (!isRecord(raw)) return { publication: null, dropped: 0 };
  const { generation, change, blocks } = raw;
  const usable = typeof generation === "number" && Number.isInteger(generation) && Math.abs(generation) < 2 ** 31;
  if (!usable || typeof change !== "string" || !isList(blocks)) {
    return { publication: null, dropped: 0 };
  }
  const valid = parseBlocks(blocks);
  return { publication: { generation, change, blocks: valid }, dropped: blocks.length - valid.length };
}

/** Where a blocked page sends people: its district's page, unless that is blocked too. */
function kreisLink(
  catalog: CityCatalog,
  block: BlockTarget,
  blockedIds: ReadonlySet<string>,
): { slug: string; name: string } | null {
  if (block.kind !== "gemeinde") return null;
  const kreisKey = catalog.gemeinden.find((gemeinde) => gemeinde.ags === block.key)?.kreisKey;
  const kreis = catalog.kreise.find((candidate) => candidate.key === kreisKey);
  if (kreis?.type !== "LK" || blockedIds.has(blockId({ kind: "kreis", key: kreis.key }))) return null;
  return { slug: kreis.slug, name: kreisDisplayName(kreis) };
}

/**
 * What browsers may know: which pages are offline and where to go instead. Reason
 * and author stay out.
 */
function publicJson(catalog: CityCatalog, blocks: readonly BlockTarget[]): string {
  const blockedIds = new Set(blocks.map(blockId));
  const entries = blocks.map((block) => {
    const kreis = kreisLink(catalog, block, blockedIds);
    return {
      slug: block.slug,
      ...(block.kind === "gemeinde" ? { ags: block.key } : {}),
      ...(kreis === null ? {} : { kreisSlug: kreis.slug, kreisName: kreis.name }),
    };
  });
  return `${JSON.stringify({ version: 1, blocked: entries })}\n`;
}

/** Same pages in the same order as scripts/generate-city-pages.py, minus the blocked. */
export function sitemap(catalog: CityCatalog, blocks: readonly BlockTarget[]): string {
  const blockedSlugs = new Set(blocks.map((block) => block.slug));
  const pages = [
    ...catalog.gemeinden.map((gemeinde) => gemeinde.slug),
    ...catalog.kreise.filter((kreis) => kreis.type === "LK").map((kreis) => kreis.slug),
  ]
    .filter((slug) => !blockedSlugs.has(slug))
    .map((slug) => `/${slug}`);
  const urls = ["/", ...pages].map((path) => `  <url><loc>${ORIGIN_PLACEHOLDER}${path}</loc></url>\n`);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join("") +
    "</urlset>\n"
  );
}

/**
 * The files of a publication. Only blocks with an address of their own have an effect
 * on the public site: a block whose key has left the catalogue stays on record, but
 * if its old slug now belongs to another page, that page is not touched.
 */
export function buildFiles(catalog: CityCatalog, publication: Publication): ReadonlyMap<string, string> {
  const effective = publication.blocks.flatMap((block) => {
    if (parseBlock(block) === null) throw new TypeError(`invalid block: ${blockId(block)}`);
    const slug = publicSlug(catalog, block);
    return slug === null ? [] : [{ ...block, slug }];
  });
  const files = new Map<string, string>([
    [PUBLIC_FILE, publicJson(catalog, effective)],
    [PUBLICATION_FILE, `${JSON.stringify(publication)}\n`],
  ]);
  if (publication.blocks.length > 0) files.set(SITEMAP_FILE, sitemap(catalog, effective));
  for (const block of effective) {
    files.set(`slug-${block.slug}`, "1\n");
    if (block.kind === "gemeinde") files.set(`ags-${block.key}`, "1\n");
  }
  return files;
}
