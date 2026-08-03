#!/bin/bash
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# Kompatibilität mit Orion-LD (TRoE):
# 1. Die libpq des Orion-LD-Images unterstützt kein SCRAM-SHA-256 – Passwort
#    daher als MD5-Hash ablegen (Zugriff nur im internen Plattform-Netz;
#    Härtungshinweise siehe docs/betrieb.md).
# 2. Orion-LD verbindet sich beim Bootstrap ohne dbname (libpq-Default =
#    Benutzername) – eine gleichnamige Wartungs-DB muss existieren.
set -euo pipefail

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres <<-SQL
    SET password_encryption = 'md5';
    ALTER USER "$POSTGRES_USER" WITH PASSWORD '$POSTGRES_PASSWORD';
    CREATE DATABASE "$POSTGRES_USER";
    -- CKAN-Datastore verlangt einen SEPARATEN Read-only-Benutzer
    CREATE USER ckan_ro WITH PASSWORD '$POSTGRES_PASSWORD';
SQL
