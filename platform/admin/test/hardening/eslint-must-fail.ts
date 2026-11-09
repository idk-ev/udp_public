/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

// This file must NOT lint clean (tests/static/admin-type-discipline.test.js).

/* eslint-disable @typescript-eslint/no-explicit-any */
export const loose: any = 1;
export const asserted = (loose as string).length;
const maybe: string | undefined = process.env.HOME;
export const forced = maybe!.length;
