/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { defineConfig } from "vite";

// The operator CLI (kubectl exec), bundled from the same server modules as the
// panel. A second, plain build: Kit's plugin only knows the web application.
export default defineConfig({
  build: {
    ssr: "src/cli/index.ts",
    outDir: "build-cli",
    emptyOutDir: true,
    target: "node24",
    minify: false,
    rolldownOptions: { output: { entryFileNames: "index.js" } },
  },
});
