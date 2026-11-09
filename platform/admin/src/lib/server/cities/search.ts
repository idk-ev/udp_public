/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { describeCity, kreisDisplayName, type BlockKind, type CityCatalog } from "./catalog.ts";

/** Search on the server: the browser never gets the list of all municipalities. */
export interface CityHit {
  kind: BlockKind;
  key: string;
  slug: string;
  name: string;
  /** "Stadt", "Gemeinde", "Landkreis", ... */
  category: string;
  /** The district a municipality belongs to. */
  context: string | null;
}

export const MAX_QUERY_LENGTH = 100;
export const MAX_HITS = 30;

/** Lower case without accents, so "tubingen" finds Tübingen. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .replaceAll("ß", "ss");
}

/** German spelling without umlauts, so "tuebingen" finds Tübingen as well. */
function transliterate(value: string): string {
  return value.toLowerCase().replaceAll("ä", "ae").replaceAll("ö", "oe").replaceAll("ü", "ue").replaceAll("ß", "ss");
}

function allHits(catalog: CityCatalog): readonly CityHit[] {
  return [
    ...catalog.gemeinden.map((gemeinde): CityHit => {
      const target = { kind: "gemeinde", key: gemeinde.ags, slug: gemeinde.slug, name: gemeinde.name } as const;
      const { category, context } = describeCity(catalog, target);
      return { ...target, category: category ?? "Gemeinde", context };
    }),
    // A Stadtkreis has no page of its own: its town is in the list above.
    ...catalog.kreise
      .filter((kreis) => kreis.type === "LK")
      .map(
        (kreis): CityHit => ({
          kind: "kreis",
          key: kreis.key,
          slug: kreis.slug,
          name: kreisDisplayName(kreis),
          category: "Landkreis",
          context: null,
        }),
      ),
  ];
}

/**
 * Municipalities and Landkreise by name or slug: names that start with the text
 * first, then names and slugs that contain it, alphabetically within each.
 */
export function searchCities(catalog: CityCatalog, query: string): readonly CityHit[] {
  const term = normalize(query.trim());
  if (term === "" || query.length > MAX_QUERY_LENGTH) return [];
  const spelled = transliterate(query.trim());
  const scored = allHits(catalog).flatMap((hit) => {
    const name = normalize(hit.name);
    const startsWith = name.startsWith(term) || transliterate(hit.name).startsWith(spelled);
    if (startsWith) return [{ hit, rank: 0 }];
    return name.includes(term) || hit.slug.includes(term) || hit.slug.includes(spelled) ? [{ hit, rank: 1 }] : [];
  });
  return scored
    .sort((a, b) => a.rank - b.rank || a.hit.name.localeCompare(b.hit.name, "de"))
    .slice(0, MAX_HITS)
    .map(({ hit }) => hit);
}
