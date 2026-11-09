/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { requireUser } from "#lib/server/http/forms.ts";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ locals }) => {
  const { username, mustChangePassword } = requireUser(locals);
  return { username, mustChangePassword };
};
