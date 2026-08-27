/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

// PROOF — this file MUST produce a compile error.
//
// It is not part of the program. tests/static/type-discipline.test.js calls tsc
// with tsconfig.hardening.json and expects a failure with exactly the messages
// below. Whoever switches off a hardening in tsconfig.json turns this file green
// — and thereby brings the test down. So a loosening is noticed instead of
// spreading quietly across 29 connectors.

// 1) erasableSyntaxOnly — enum is not erasable syntax.
//    Expected: "This syntax is not allowed when 'erasableSyntaxOnly' is enabled."
export enum Purpose {
  Car,
  Bike,
}

// 2) noUncheckedIndexedAccess — access to an element of an array yields
//    `| undefined`. Exactly this option separates the positional arrays of the
//    source data (ParkAPI, bw-gemeinden) from silent mistakes.
//    Expected: "is possibly 'undefined'"
export function firstLength(rows: string[]): number {
  return rows[0].length;
}

// 3) strict / noImplicitAny — an untyped parameter is an error, not merely a
//    warning.
//    Expected: "implicitly has an 'any' type"
export function double(value): number {
  return value * 2;
}
