/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { getApp } from "#lib/server/app.ts";
import { listAudit, type AuditView } from "#lib/server/audit.ts";
import type { PageServerLoad } from "./$types";

const PAGE_SIZE = 50;

/** Only a plain positive number; anything else is the first page. */
function parseBefore(value: string | null): number | null {
  if (value === null || !/^[1-9][0-9]{0,14}$/.test(value)) return null;
  return Number(value);
}

export const load: PageServerLoad = async ({ url }) => {
  const view: AuditView = url.searchParams.get("ansicht") === "anmeldungen" ? "logins" : "changes";
  const before = parseBefore(url.searchParams.get("vor"));
  const { entries, nextBefore } = await listAudit(getApp().db, { view, before, limit: PAGE_SIZE });
  return { view, entries, nextBefore, firstPage: before === null };
};
