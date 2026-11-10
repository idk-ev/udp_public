/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import type { RequestHandler } from "./$types";

/** Liveness: only that the process answers. A restart does not fix a database. */
export const GET: RequestHandler = () => new Response("ok", { headers: { "Content-Type": "text/plain" } });
