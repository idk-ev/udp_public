/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import type { SessionUser } from "#lib/server/auth/sessions.ts";

declare global {
  namespace App {
    interface Locals {
      user: SessionUser | null;
    }
    interface Error {
      message: string;
      status: number;
    }
  }
}

export {};
