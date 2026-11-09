/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Runs `check` every `intervalMs` until the returned function is called. Pages use it
 * in an $effect, which then stops it on leaving the page. Not <meta http-equiv="refresh">:
 * once a browser has read that tag, removing it does not stop the timer, so after a
 * client-side navigation it reloads the earlier address over whatever the person is
 * typing by then. Such a tag belongs inside <noscript> only.
 */
export function startRecheck(check: () => unknown, intervalMs: number): () => void {
  const timer = setInterval(check, intervalMs);
  return () => {
    clearInterval(timer);
  };
}
