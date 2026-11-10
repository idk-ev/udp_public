/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { getApp } from "#lib/server/app.ts";
import { listBlocks, publishStatus } from "#lib/server/cities/blocks.ts";
import { MAX_HITS, MAX_QUERY_LENGTH, searchCities } from "#lib/server/cities/search.ts";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url }) => {
  const { db, catalog } = getApp();
  const query = (url.searchParams.get("q") ?? "").slice(0, MAX_QUERY_LENGTH);
  const hits = searchCities(catalog, query);
  const [blocks, status] = await Promise.all([listBlocks(db), publishStatus(db)]);
  const id = (block: { kind: string; key: string }): string => `${block.kind}:${block.key}`;
  const blocked = new Set(blocks.map(id));
  const held = new Set(status.held.map(id));
  return {
    query,
    maxHits: MAX_HITS,
    hits: hits.map((hit) => ({ ...hit, blocked: blocked.has(id(hit)), held: held.has(id(hit)) })),
  };
};
