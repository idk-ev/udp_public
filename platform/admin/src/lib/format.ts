/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

const DATE_TIME = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

/** A point in time the way the panel shows it, the same on server and client. */
export function formatDateTime(value: Date): string {
  return DATE_TIME.format(value);
}
