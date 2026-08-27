/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// ^ This line is itself part of the proof: noInlineConfig has to render it
//   ineffective. If it took hold, the ban would only be a request.

// PROOF — this file MUST be flagged by ESLint.
// tests/static/type-discipline.test.js checks that each of the four rules below
// really does fire. The file sits in the ignores of eslint.config.js and is only
// invoked with --no-ignore; `npm run lint` never sees it.

interface Facility {
  name: string;
}

// 1) no-explicit-any
export function fromAny(raw: any): string {
  return String(raw);
}

// 2) consistent-type-assertions: "never" — narrow external data, do not assert it.
export function assertFacility(raw: unknown): Facility {
  return raw as Facility;
}

// 3) no-non-null-assertion
export function firstFacility(facilities: Facility[]): Facility {
  return facilities[0]!;
}

// 4) no-floating-promises — an unawaited upsert loses its error.
export function write(upsert: () => Promise<void>): void {
  upsert();
}
