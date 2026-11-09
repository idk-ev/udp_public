# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# UDP admin panel (SvelteKit, adapter-node) and its operator CLI.
#
# The build context is the REPOSITORY ROOT DIRECTORY, like the other images:
#   docker build -f platform/admin/Dockerfile .

# ---------------------------------------------------------------- Build
FROM node:24-alpine AS build
WORKDIR /build

COPY platform/admin/package.json platform/admin/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY platform/admin/tsconfig.json platform/admin/vite.config.ts platform/admin/vite.cli.config.ts ./
COPY platform/admin/src ./src
COPY platform/admin/static ./static
RUN npm run build

# Only the runtime dependencies stay: pg. Everything else is in the bundles.
RUN npm ci --no-audit --no-fund --omit=dev

# ---------------------------------------------------------------- Runtime
FROM node:24-alpine

# Version floor: node:crypto has Argon2 only from 24.7 on, and a stale cached
# node:24-alpine must fail the build instead of shipping an older runtime.
RUN node -e 'const [a, b, c] = process.versions.node.split(".").map(Number); \
  if (a < 24 || (a === 24 && (b < 22 || (b === 22 && c < 2)))) { console.error(`node ${process.version} < 24.22.2`); process.exit(1); }'

# BODY_SIZE_LIMIT: the panel only takes small forms.
ENV NODE_ENV=production \
    TZ=Europe/Berlin \
    HOST=0.0.0.0 \
    PORT=3000 \
    BODY_SIZE_LIMIT=16K \
    ADMIN_CITY_CATALOG=/app/data/bw-gemeinden.json

WORKDIR /app

COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/build        ./build
COPY --from=build /build/build-cli    ./build-cli
COPY --from=build /build/package.json ./package.json
# The municipalities and districts the public pages have: list and image belong
# together, like the connector registry in the connector image.
COPY gui/public/bw-gemeinden.json ./data/bw-gemeinden.json

# Target of the directory publisher (Compose: a volume shared with the cockpit).
RUN mkdir -p /var/lib/udp-city-blocks && chown node:node /var/lib/udp-city-blocks

# node:24-alpine ships with the user "node" (UID 1000). Apart from that volume the
# service writes nothing to the file system, so the image runs with
# readOnlyRootFilesystem.
USER node

EXPOSE 3000
CMD ["node", "build/index.js"]
