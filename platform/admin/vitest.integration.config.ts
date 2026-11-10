/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { defineConfig } from "vitest/config";

// Tests against a real PostgreSQL and the built server (npm run build first). They
// need real concurrency, which PGlite with its single connection cannot give.
//   docker run -d --name udp-admin-test -p 127.0.0.1:55432:5432 -e POSTGRES_USER=udp_admin \
//     -e POSTGRES_PASSWORD=test -e POSTGRES_DB=udp_admin postgres:16-alpine
//   ADMIN_TEST_DB_PASSWORD=test npm run test:integration
export default defineConfig({
  test: {
    include: ["test/server/*.integration.ts"],
    environment: "node",
    // All files use one database and start from an empty schema.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
