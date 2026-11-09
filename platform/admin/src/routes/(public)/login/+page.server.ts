/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { fail, redirect } from "@sveltejs/kit";
import { getApp } from "#lib/server/app.ts";
import { BusyError } from "#lib/server/auth/limiter.ts";
import { login } from "#lib/server/auth/login.ts";
import { SESSION_COOKIE } from "#lib/server/auth/sessions.ts";
import { clientBucket } from "#lib/server/auth/throttle.ts";
import { LOGIN_ADDRESS_LIMIT } from "#lib/server/http/address-limit.ts";
import { clientAddress, field, setSessionCookie } from "#lib/server/http/forms.ts";
import type { Actions, PageServerLoad } from "./$types";

const INVALID = "Benutzername oder Passwort ist falsch.";
const BUSY = "Gerade sind sehr viele Anmeldungen unterwegs. Bitte versuche es gleich noch einmal.";
const TOO_MANY = "Zu viele Anmeldeversuche von dieser Adresse. Bitte warte einen Moment.";

export const load: PageServerLoad = ({ locals }) => {
  if (locals.user !== null) redirect(303, "/");
};

export const actions: Actions = {
  default: async (event) => {
    const address = clientAddress(event);
    // Before the body is read and before anything is written.
    if (!LOGIN_ADDRESS_LIMIT.allow(clientBucket(address))) return fail(429, { message: TOO_MANY, username: "" });

    const form = await event.request.formData();
    const username = field(form, "username");
    let result;
    try {
      result = await login(getApp().db, {
        username,
        password: field(form, "password"),
        address,
        previousToken: event.cookies.get(SESSION_COOKIE),
      });
    } catch (error) {
      if (error instanceof BusyError) return fail(503, { message: BUSY, username });
      throw error;
    }
    switch (result.kind) {
      case "invalid":
        return fail(400, { message: INVALID, username });
      case "throttled":
        return fail(429, {
          message: `Zu viele Versuche. Bitte warte ${String(result.retryAfterSeconds)} Sekunden.`,
          username,
        });
      case "success":
        setSessionCookie(event, result.sessionToken);
        redirect(303, "/");
    }
  },
};
