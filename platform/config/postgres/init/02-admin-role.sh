#!/bin/bash
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# Passwort der Rolle udp_admin (Verwaltungsoberfläche, 01-databases.sql) aus der
# Umgebung, denn in einer .sql-Datei stünde es im Repository. Ohne Wert bleibt die
# Rolle ohne Passwort und damit ohne Anmeldung. Bestehende Volumes: docs/betrieb.md.
set -euo pipefail

if [ -z "${ADMIN_DB_PASSWORD:-}" ]; then
    echo "02-admin-role: ADMIN_DB_PASSWORD not set, role udp_admin stays without a password"
    exit 0
fi

# Variablen in psql statt im SQL-Text: :'pw' quotet den Wert selbst.
psql -v ON_ERROR_STOP=1 -v pw="$ADMIN_DB_PASSWORD" -U "$POSTGRES_USER" -d postgres <<'SQL'
ALTER ROLE udp_admin WITH PASSWORD :'pw';
SQL
