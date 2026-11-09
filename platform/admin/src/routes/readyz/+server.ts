/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { getApp } from "#lib/server/app.ts";
import type { RequestHandler } from "./$types";

/** Readiness: the database answers. The reason stays in the logs, not the response. */
export const GET: RequestHandler = async () => {
  const headers = { "Content-Type": "text/plain" };
  try {
    await getApp().db.query("SELECT 1");
    return new Response("ok", { headers });
  } catch (error) {
    console.error(`[admin] readiness: ${error instanceof Error ? error.message : String(error)}`);
    return new Response("unavailable", { status: 503, headers });
  }
};
