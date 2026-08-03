# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# PostgreSQL 16 + PostGIS + TimescaleDB **Apache Edition**
#
# Warum ein eigenes Image:
#  * PostGIS wird von Orion-LD (TRoE-Geometrien), FROST und CKAN gebraucht.
#  * Mintaka (NGSI-LD Temporal API) setzt für typ-skopierte Abfragen die
#    TimescaleDB-Aggregatfunktion last() voraus — ohne sie liefert
#    /temporal/entities?type=… HTTP 500.
#  * Das Fertigimage timescale/timescaledb-ha steht unter der Timescale
#    License (nicht OSI). Die hier installierte Apache-Edition
#    (timescaledb-2-oss) enthält ausschließlich Apache-2.0-lizenzierten Code:
#    Hypertables, time_bucket, first()/last(). TSL-Funktionen (Compression,
#    Continuous Aggregates) fehlen — die Plattform nutzt sie nicht.
#
# Bauen erledigt docker compose (build-Kontext in docker-compose.yml).
FROM postgis/postgis:16-3.5

ARG TIMESCALE_MAJOR=2

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends gnupg postgresql-common apt-transport-https lsb-release wget ca-certificates; \
    echo "deb https://packagecloud.io/timescale/timescaledb/debian/ $(lsb_release -cs) main" \
        > /etc/apt/sources.list.d/timescaledb.list; \
    wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey \
        | gpg --dearmor -o /etc/apt/trusted.gpg.d/timescaledb.gpg; \
    apt-get update; \
    apt-get install -y --no-install-recommends "timescaledb-${TIMESCALE_MAJOR}-oss-postgresql-16"; \
    apt-get purge -y --auto-remove wget gnupg apt-transport-https; \
    rm -rf /var/lib/apt/lists/*
