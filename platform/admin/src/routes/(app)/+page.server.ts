/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { getApp } from "#lib/server/app.ts";
import { listBlocks, publishStatus } from "#lib/server/cities/blocks.ts";
import { describeCity, pageParam, publicSlug, type BlockTarget } from "#lib/server/cities/catalog.ts";
import { checkPage } from "#lib/server/cities/live-check.ts";
import type { PageServerLoad } from "./$types";

/** Live checks per view; more blocks than this have not happened yet, and may wait. */
const MAX_LIVE_CHECKS = 25;
/** Fewer than on the page of one city: this runs for every block. */
const SAMPLES = 3;

export const load: PageServerLoad = async () => {
  const { db, env, catalog } = getApp();
  const [blocks, status] = await Promise.all([listBlocks(db), publishStatus(db)]);
  const checks = await Promise.all(
    blocks.slice(0, MAX_LIVE_CHECKS).map((block) => {
      const slug = publicSlug(catalog, block);
      return slug === null ? Promise.resolve(null) : checkPage(env.cockpitUrl, slug, true, SAMPLES);
    }),
  );
  const link = (block: BlockTarget): { param: string; label: string } => ({
    param: pageParam(catalog, block),
    label: describeCity(catalog, block).label,
  });
  const blockedKeys = new Set(blocks.map((block) => block.key));
  return {
    blocks: blocks.map((block, index) => ({
      ...link(block),
      key: `${block.kind}:${block.key}`,
      reason: block.reason,
      blockedBy: block.blockedBy,
      blockedAt: block.blockedAt,
      live: checks[index] ?? null,
    })),
    held: status.held.map((block) => ({ ...link(block), key: `${block.kind}:${block.key}` })),
    reimposed: status.reimposed
      .filter((block) => blockedKeys.has(block.key))
      .map((block) => ({ ...link(block), key: `${block.kind}:${block.key}` })),
    publishFailed: status.lastError !== null,
    publishWarning: status.lastWarning !== null,
  };
};
