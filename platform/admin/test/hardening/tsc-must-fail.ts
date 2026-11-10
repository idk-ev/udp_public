/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

// This file must NOT compile (tests/static/admin-type-discipline.test.js).

// noUncheckedIndexedAccess: an array element can be undefined.
const items: string[] = [];
export const first: string = items[0].trim();

// noImplicitAny
export function implicit(value) {
  return value;
}
