/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import type { Handle, HandleServerError, ServerInit } from "@sveltejs/kit/hooks";
import { getApp, startApp } from "#lib/server/app.ts";
import { resolveSession } from "#lib/server/auth/sessions.ts";
import { createHandle } from "#lib/server/http/handle.ts";

export const init: ServerInit = async () => {
  await startApp();
};

let appHandle: Handle | undefined;

export const handle: Handle = (input) => {
  if (appHandle === undefined) {
    const { env, db } = getApp();
    appHandle = createHandle({
      publicOrigin: env.publicOrigin,
      resolveSession: (token) => resolveSession(db, token),
    });
  }
  return appHandle(input);
};

export const handleError: HandleServerError = ({ kind, error, event }) => {
  if (kind !== "unknown") return undefined;
  // The route, not the path, and only the message: no request data in the log.
  const reason = error instanceof Error ? error.message : "unknown error";
  console.error(`[admin] ${event.request.method} ${event.route.id ?? "(no route)"}: ${reason}`);
  return { message: "Interner Fehler", status: 500 };
};
