/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { redirect } from "@sveltejs/kit";
import { getApp } from "#lib/server/app.ts";
import { audit } from "#lib/server/audit.ts";
import { revokeSession, SESSION_COOKIE } from "#lib/server/auth/sessions.ts";
import { clearSessionCookie, requireUser } from "#lib/server/http/forms.ts";
import type { RequestHandler } from "./$types";

/** POST only: a link or an image on another page cannot log anybody out. */
export const POST: RequestHandler = async (event) => {
  const { id, username } = requireUser(event.locals);
  const { db } = getApp();
  const token = event.cookies.get(SESSION_COOKIE);
  if (token !== undefined) await revokeSession(db, token);
  await audit(db, { actor: { id, username }, action: "logout" });
  clearSessionCookie(event);
  redirect(303, "/login");
};
