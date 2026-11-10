/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Does the public site already do what the database says? Asks the cockpit inside the
 * platform for one page, several times, on a new connection each: the Service sends
 * each to some replica. That is a sample, not a proof for every replica, and the panel
 * says so. The address is the deployment's fixed cockpit address plus a slug that
 * matches the catalogue's pattern, so nothing a user types can choose where this
 * request goes; it sends no credentials and follows no redirect.
 *
 * Not reaching a verdict is no error: the change has a delay on its way to the
 * cockpit. Anything but the expected status, once, is "pending".
 */
export type LiveCheck = "confirmed" | "pending";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TIMEOUT_MS = 3_000;
export const DEFAULT_SAMPLES = 5;

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export async function checkPage(
  cockpitUrl: string,
  slug: string,
  blocked: boolean,
  samples: number = DEFAULT_SAMPLES,
  fetchPage: Fetch = fetch,
): Promise<LiveCheck> {
  if (!SLUG.test(slug)) return "pending";
  try {
    for (let sample = 0; sample < samples; sample += 1) {
      const answer = await fetchPage(`${cockpitUrl}/${slug}`, {
        method: "HEAD",
        redirect: "manual",
        // A kept-alive connection would ask the same replica every time.
        headers: { Connection: "close" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (answer.status !== (blocked ? 410 : 200)) return "pending";
    }
    return "confirmed";
  } catch {
    return "pending";
  }
}
