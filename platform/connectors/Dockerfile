# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# UDP connector service: ingestion of the open data sources into NGSI-LD.
#
# Multi-stage, because TypeScript is compiled instead of being stripped at
# runtime: Node 22 can strip types by itself these days, but that is still
# experimental there and writes a warning on every start — into exactly the
# logs that scripts/healthcheck.sh searches for [warn]. A build step is the more
# boring price. tsconfig.json sets erasableSyntaxOnly so that the switch stays
# possible later without a code change.
#
# connectors.json travels WITH it into the image (as flows.json does for the
# Node-RED image): registry and runtime belong together, otherwise a
# digest-pinned image can run against a foreign registry. The file is ~20 KB — a
# ConfigMap route would stay possible, but is not needed.
#
# The build context is the REPOSITORY ROOT DIRECTORY (as with gui/Dockerfile
# and platform/config/nodered/Dockerfile):
#   docker build -f platform/connectors/Dockerfile .

# ---------------------------------------------------------------- Build
FROM node:22-alpine AS build
WORKDIR /build

# The manifests first, the source code second: that keeps the npm layer in the
# cache as long as only connector code changes — and in phase 3 it does so all
# the time.
COPY platform/connectors/package.json platform/connectors/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY platform/connectors/tsconfig.json platform/connectors/tsconfig.build.json ./
COPY platform/connectors/src ./src
RUN npx tsc -p tsconfig.build.json

# Resolve the runtime dependencies separately: the result contains no
# TypeScript, no ESLint and no @types — only pg.
RUN npm ci --no-audit --no-fund --omit=dev

# ---------------------------------------------------------------- Runtime
FROM node:22-alpine

ENV NODE_ENV=production \
    TZ=Europe/Berlin

WORKDIR /app

COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist         ./dist
COPY platform/config/connectors.json /app/config/connectors.json

# node:22-alpine ships with the user "node" (UID 1000). The service writes
# nothing to the file system — from phase 1 on, the signature store of the
# change detection lives in TimescaleDB, not on disk. The image can therefore
# run with readOnlyRootFilesystem.
USER node

# --enable-source-maps: without it stack traces point at dist/*.js instead of at
# the .ts line. That is the very reason for compiling at all.
CMD ["node", "--enable-source-maps", "dist/src/index.js"]
