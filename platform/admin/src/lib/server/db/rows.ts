/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/** Database rows enter as unknown values and are narrowed column by column. */

export type Row = Readonly<Record<string, unknown>>;

function fail(column: string, expected: string): never {
  throw new TypeError(`column ${column}: expected ${expected}`);
}

export function text(row: Row, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : fail(column, "text");
}

export function integer(row: Row, column: string): number {
  const value = row[column];
  return typeof value === "number" && Number.isInteger(value) ? value : fail(column, "integer");
}

export function bool(row: Row, column: string): boolean {
  const value = row[column];
  return typeof value === "boolean" ? value : fail(column, "boolean");
}

export function nullableTimestamp(row: Row, column: string): Date | null {
  const value = row[column];
  if (value === null) return null;
  return value instanceof Date ? value : fail(column, "timestamp or null");
}

/** The first row of a statement that must return one. */
export function single(rows: readonly Row[]): Row {
  const [row] = rows;
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}
