/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { readFileSync } from "node:fs";

/**
 * The municipalities and districts of the public pages: gui/public/bw-gemeinden.json,
 * copied into the image at build time (platform/admin/Dockerfile). The file is a
 * list of positional rows; this module is the one place that knows the positions.
 */
export interface Gemeinde {
  ags: string;
  name: string;
  kreisKey: string;
  slug: string;
  /** S: town, G: municipality, F: unincorporated area. */
  type: string;
}

export interface Kreis {
  key: string;
  name: string;
  /** Landkreis, or Stadtkreis: one municipality without a district page of its own. */
  type: "LK" | "SK";
  slug: string;
}

export interface CityCatalog {
  gemeinden: readonly Gemeinde[];
  kreise: readonly Kreis[];
}

export type BlockKind = "gemeinde" | "kreis";

/** What can be taken offline: one page of the public site. */
export interface BlockTarget {
  kind: BlockKind;
  key: string;
  slug: string;
  name: string;
}

const AGS = /^[0-9]{8}$/;
const KREIS_KEY = /^[0-9]{5}$/;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRows(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function cell(row: readonly unknown[], index: number, what: string, pattern?: RegExp): string {
  const value = row[index];
  if (typeof value !== "string" || (pattern !== undefined && !pattern.test(value))) {
    throw new TypeError(`city catalogue: invalid ${what} in row ${JSON.stringify(row[0])}`);
  }
  return value;
}

function rowsOf(source: Readonly<Record<string, unknown>>, name: string): readonly (readonly unknown[])[] {
  const rows = source[name];
  if (!isRows(rows) || !rows.every(isRows)) throw new TypeError(`city catalogue: ${name} is not a list of rows`);
  return rows.filter(isRows);
}

export function parseCatalog(raw: unknown): CityCatalog {
  if (!isRecord(raw)) throw new TypeError("city catalogue: not an object");
  const gemeinden = rowsOf(raw, "gemeinden").map((row) => ({
    ags: cell(row, 0, "AGS", AGS),
    name: cell(row, 1, "name"),
    kreisKey: cell(row, 4, "district key", KREIS_KEY),
    slug: cell(row, 8, "slug", SLUG_PATTERN),
    type: cell(row, 5, "municipality type"),
  }));
  const kreise = rowsOf(raw, "kreise").map((row): Kreis => {
    const type = cell(row, 4, "district type");
    if (type !== "LK" && type !== "SK") throw new TypeError(`city catalogue: unknown district type ${type}`);
    return {
      key: cell(row, 0, "district key", KREIS_KEY),
      name: cell(row, 1, "name"),
      type,
      slug: cell(row, 7, "slug", SLUG_PATTERN),
    };
  });
  if (gemeinden.length === 0) throw new TypeError("city catalogue: no municipalities");
  return { gemeinden, kreise };
}

export function loadCatalog(path: string): CityCatalog {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parseCatalog(raw);
}

/** The name the public pages use for a district. */
export function kreisDisplayName(kreis: Kreis): string {
  if (kreis.type === "SK") return `Stadtkreis ${kreis.name}`;
  return /kreis$/i.test(kreis.name) ? kreis.name : `Landkreis ${kreis.name}`;
}

function gemeindeTarget(gemeinde: Gemeinde): BlockTarget {
  return { kind: "gemeinde", key: gemeinde.ags, slug: gemeinde.slug, name: gemeinde.name };
}

/**
 * A Landkreis is its own page. A Stadtkreis has none: its only page is the
 * municipality's (/kreis-stuttgart redirects to /stuttgart in the cockpit's nginx),
 * so every way of naming it leads to that municipality.
 */
function kreisTarget(catalog: CityCatalog, kreis: Kreis): BlockTarget | null {
  if (kreis.type === "LK") {
    return { kind: "kreis", key: kreis.key, slug: kreis.slug, name: kreisDisplayName(kreis) };
  }
  const gemeinde = catalog.gemeinden.find((candidate) => candidate.kreisKey === kreis.key);
  return gemeinde === undefined ? null : gemeindeTarget(gemeinde);
}

/**
 * The page behind what an operator typed: a slug, a municipality key (AGS) or a
 * district key. Null when the catalogue does not know it; nothing is guessed.
 */
export function resolveCity(catalog: CityCatalog, input: string): BlockTarget | null {
  const value = input.trim().toLowerCase();
  const gemeinde = catalog.gemeinden.find((candidate) => candidate.slug === value || candidate.ags === value);
  if (gemeinde !== undefined) return gemeindeTarget(gemeinde);
  const kreis = catalog.kreise.find(
    (candidate) => candidate.key === value || (candidate.type === "LK" && candidate.slug === value),
  );
  if (kreis !== undefined) return kreisTarget(catalog, kreis);
  // /kreis-stuttgart: a Stadtkreis under the address that redirects to its page.
  // After the Landkreise: /kreis-heilbronn is a real page, next to the town Heilbronn.
  const stadtkreis = value.startsWith("kreis-")
    ? catalog.kreise.find((candidate) => candidate.type === "SK" && candidate.slug === value.slice("kreis-".length))
    : undefined;
  return stadtkreis === undefined ? null : kreisTarget(catalog, stadtkreis);
}

function knownSlug(catalog: CityCatalog, block: Pick<BlockTarget, "kind" | "key">): string | undefined {
  return block.kind === "gemeinde"
    ? catalog.gemeinden.find((gemeinde) => gemeinde.ags === block.key)?.slug
    : catalog.kreise.find((kreis) => kreis.key === block.key)?.slug;
}

/**
 * The address a block takes offline. A page the catalogue knows: its current slug. One
 * it no longer knows: the slug it had, unless that now belongs to another page, which
 * a block of somebody else must never touch. Then it has no address at all (null).
 */
export function publicSlug(catalog: CityCatalog, block: BlockTarget): string | null {
  const known = knownSlug(catalog, block);
  if (known !== undefined) return known;
  const taken =
    catalog.gemeinden.some((gemeinde) => gemeinde.slug === block.slug) ||
    catalog.kreise.some((kreis) => kreis.type === "LK" && kreis.slug === block.slug);
  return taken ? null : block.slug;
}

/** The panel's address of a page: its slug, or the key once the catalogue lost it. */
export function pageParam(catalog: CityCatalog, block: Pick<BlockTarget, "kind" | "key">): string {
  return knownSlug(catalog, block) ?? block.key;
}

const CATEGORY: Readonly<Record<string, string>> = {
  S: "Stadt",
  G: "Gemeinde",
  F: "Gemeindefreies Gebiet",
};

export interface CityDescription {
  /** "Stadt", "Landkreis", ...; null when the catalogue no longer has the page. */
  category: string | null;
  /** The district a municipality belongs to. */
  context: string | null;
  /** The name, with the district where the name alone does not say which page. */
  label: string;
}

export function describeCity(catalog: CityCatalog, block: BlockTarget): CityDescription {
  if (block.kind === "kreis") {
    const known = knownSlug(catalog, block) !== undefined;
    return { category: known ? "Landkreis" : null, context: null, label: block.name };
  }
  const gemeinde = catalog.gemeinden.find((candidate) => candidate.ags === block.key);
  if (gemeinde === undefined) return { category: null, context: null, label: block.name };
  const kreis = catalog.kreise.find((candidate) => candidate.key === gemeinde.kreisKey);
  const context = kreis === undefined ? null : kreisDisplayName(kreis);
  const duplicate = catalog.gemeinden.filter((candidate) => candidate.name === gemeinde.name).length > 1;
  return {
    category: CATEGORY[gemeinde.type] ?? "Gemeinde",
    context,
    label: duplicate && context !== null ? `${gemeinde.name} (${context})` : gemeinde.name,
  };
}

/** What a person types to confirm: nine names occur twice, so the name alone is not enough. */
export function confirmationText(catalog: CityCatalog, block: BlockTarget): string {
  return describeCity(catalog, block).label;
}
