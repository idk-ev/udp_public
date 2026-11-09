/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

// Kit 3 takes its options from the plugin (there is no svelte.config.js).
//
// paths.origin stays unset on purpose: it is fixed at build time, but the host
// is a deployment value. Behind the ingress Kit derives the origin from the Host
// header (scheme https); hooks.server.ts rejects anything that is not exactly
// ADMIN_PUBLIC_ORIGIN, so the derived value cannot be chosen by a client.
export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter({ out: "build", precompress: false }),
      csp: {
        mode: "auto",
        directives: {
          "default-src": ["self"],
          "script-src": ["self"],
          "style-src": ["self"],
          "img-src": ["self"],
          "font-src": ["self"],
          "connect-src": ["self"],
          "form-action": ["self"],
          "base-uri": ["none"],
          "frame-ancestors": ["none"],
          "object-src": ["none"],
        },
      },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Each test file starts its own in-process PostgreSQL.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
