/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { fail, redirect } from "@sveltejs/kit";
import { getApp } from "#lib/server/app.ts";
import { changePassword } from "#lib/server/auth/account.ts";
import { BusyError } from "#lib/server/auth/limiter.ts";
import { POLICY_MESSAGES } from "#lib/server/auth/policy.ts";
import { field, requireUser, setSessionCookie } from "#lib/server/http/forms.ts";
import type { Actions } from "./$types";

export const actions: Actions = {
  default: async (event) => {
    const user = requireUser(event.locals);
    const form = await event.request.formData();
    const next = field(form, "next");
    if (next !== field(form, "confirm")) {
      return fail(400, { message: "Die beiden neuen Passwörter stimmen nicht überein." });
    }
    let result;
    try {
      result = await changePassword(getApp().db, user, field(form, "current"), next);
    } catch (error) {
      if (error instanceof BusyError) {
        return fail(503, { message: "Gerade ist viel los. Bitte versuche es gleich noch einmal." });
      }
      throw error;
    }
    switch (result.kind) {
      case "wrong_password":
        return fail(400, { message: "Das aktuelle Passwort ist falsch." });
      case "same_password":
        return fail(400, { message: "Das neue Passwort muss sich vom aktuellen unterscheiden." });
      case "throttled":
        return fail(429, {
          message: `Zu viele Versuche. Bitte warte ${String(result.retryAfterSeconds)} Sekunden.`,
        });
      case "policy":
        return fail(400, { message: POLICY_MESSAGES[result.violation] });
      case "ok":
        setSessionCookie(event, result.sessionToken);
        // The forced change is done: the rest of the panel opens.
        if (user.mustChangePassword) redirect(303, "/");
        return { changed: true };
    }
  },
};
