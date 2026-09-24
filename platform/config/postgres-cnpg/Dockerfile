# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# PostgreSQL 16 + PostGIS + TimescaleDB **Apache Edition** as a CloudNativePG
# operand image (Kubernetes, helm/udp: timescale.image).
#
# Same extensions as platform/config/postgres (docker compose), but built on the
# official CNPG PostGIS image: CNPG replaces the entrypoint with its instance
# manager and expects its own layout (postgres as UID 26, initdb/pg_ctl/
# pg_basebackup on PATH). The docker-library image of the compose stack does
# not meet that, so there are two images.
#
# Only the Apache-2.0 package (timescaledb-2-oss) is installed – the platform
# needs first()/last() for Mintaka, no TSL features (see platform/config/postgres).
#
# The tag of THIS image is irrelevant to CNPG: the chart references it through
# an ImageCatalog (templates/timescale.yaml), which carries the major version.
FROM ghcr.io/cloudnative-pg/postgis:16-3.6-standard-trixie

ARG TIMESCALE_MAJOR=2
# Fingerprint of the packagecloud signing key of the TimescaleDB repository –
# the build fails if the downloaded key is a different one.
ARG TIMESCALE_KEY_FPR=1005FB68604CE9B8F6879CF759F18EDF47F24417

USER root
RUN set -eux; \
    . /etc/os-release; \
    apt-get update; \
    apt-get install -y --no-install-recommends gnupg wget ca-certificates; \
    wget --quiet -O /tmp/timescaledb.asc https://packagecloud.io/timescale/timescaledb/gpgkey; \
    gpg --show-keys --with-colons /tmp/timescaledb.asc | grep -q "^fpr:::::::::${TIMESCALE_KEY_FPR}:"; \
    gpg --dearmor -o /usr/share/keyrings/timescaledb.gpg /tmp/timescaledb.asc; \
    rm /tmp/timescaledb.asc; \
    echo "deb [signed-by=/usr/share/keyrings/timescaledb.gpg] https://packagecloud.io/timescale/timescaledb/debian/ ${VERSION_CODENAME} main" \
        > /etc/apt/sources.list.d/timescaledb.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "timescaledb-${TIMESCALE_MAJOR}-oss-postgresql-16"; \
    apt-get purge -y --auto-remove wget gnupg; \
    rm -rf /var/lib/apt/lists/*
USER 26
