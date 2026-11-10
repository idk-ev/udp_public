/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { error, fail, redirect } from "@sveltejs/kit";
import { getApp } from "#lib/server/app.ts";
import { blockCity, listBlocks, publishStatus, unblockCity } from "#lib/server/cities/blocks.ts";
import { describeCity, pageParam, publicSlug, resolveCity, type BlockTarget } from "#lib/server/cities/catalog.ts";
import { checkPage } from "#lib/server/cities/live-check.ts";
import { field, requireUser } from "#lib/server/http/forms.ts";
import type { Actions, PageServerLoad } from "./$types";

const REASON_MESSAGE = "Bitte einen Grund in einer Zeile angeben, höchstens 500 Zeichen.";
const NOT_FOUND = "Diese Seite gibt es nicht";

export const load: PageServerLoad = async ({ params, url }) => {
  const { db, catalog, env } = getApp();
  const [blocks, status] = await Promise.all([listBlocks(db), publishStatus(db)]);
  // One address per page: the slug, or the key of a block the catalogue no longer has.
  const known = resolveCity(catalog, params.slug);
  const stale: BlockTarget | undefined = [...blocks, ...status.held].find((block) => block.key === params.slug);
  const city = known ?? stale ?? null;
  if (city === null || pageParam(catalog, city) !== params.slug) error(404, NOT_FOUND);

  const block = blocks.find((candidate) => candidate.kind === city.kind && candidate.key === city.key) ?? null;
  const held = status.held.some((candidate) => candidate.kind === city.kind && candidate.key === city.key);
  const blocked = block !== null || held;
  const done = url.searchParams.get("erledigt");
  const changed = done === "gesperrt" || done === "freigegeben" ? done : null;
  // Only asked when it can say something: right after a change, or for a block.
  const slug = publicSlug(catalog, city);
  const live = slug !== null && (changed !== null || blocked) ? await checkPage(env.cockpitUrl, slug, blocked) : null;
  return {
    city: { name: city.name, slug: city.slug },
    description: describeCity(catalog, city),
    inCatalogue: known !== null,
    addressReassigned: known === null && slug === null,
    changed,
    live,
    block: block === null ? null : { reason: block.reason, blockedBy: block.blockedBy, blockedAt: block.blockedAt },
    held,
    anyHeld: status.held.length > 0,
    publishFailed: status.lastError !== null,
  };
};

export const actions: Actions = {
  sperren: async (event) => {
    const user = requireUser(event.locals);
    const form = await event.request.formData();
    const reason = field(form, "reason");
    const confirmation = field(form, "confirmation");
    const result = await blockCity(getApp(), { city: event.params.slug, reason, confirmation, actor: user });
    switch (result.kind) {
      case "unknown_city":
        error(404, NOT_FOUND);
        break;
      case "invalid_reason":
        return fail(400, { action: "sperren", message: REASON_MESSAGE, reason });
      case "wrong_confirmation":
        return fail(400, {
          action: "sperren",
          message: `Zur Bestätigung bitte genau „${describeCity(getApp().catalog, result.city).label}“ eintippen.`,
          reason,
        });
      case "already_blocked":
      case "ok":
        redirect(303, `/staedte/${pageParam(getApp().catalog, result.city)}?erledigt=gesperrt`);
    }
  },
  freigeben: async (event) => {
    const user = requireUser(event.locals);
    const form = await event.request.formData();
    const reason = field(form, "reason");
    const result = await unblockCity(getApp(), { city: event.params.slug, reason, actor: user });
    switch (result.kind) {
      case "unknown_city":
        error(404, NOT_FOUND);
        break;
      case "invalid_reason":
        return fail(400, { action: "freigeben", message: REASON_MESSAGE, reason });
      case "publish_failed":
        return fail(503, {
          action: "freigeben",
          message: "Der veröffentlichte Stand ist gerade nicht lesbar. Bitte gleich noch einmal versuchen.",
          reason,
        });
      case "not_blocked":
      case "ok":
        redirect(303, `/staedte/${pageParam(getApp().catalog, result.city)}?erledigt=freigegeben`);
    }
  },
};
