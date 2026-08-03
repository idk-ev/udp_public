/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Entwicklungsmodus: Plattform-APIs über das lokale API-Gateway
      "/gateway": {
        target: "http://localhost:8780",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/gateway/, ""),
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
  },
});
