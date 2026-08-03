-- SPDX-License-Identifier: EUPL-1.2
-- © 2024–2026 Thomas Kieß and contributors

-- Datenbanken der Urbanen Datenplattform
-- "orion" (TRoE-Zeitreihen des Context Brokers) wird über POSTGRES_DB angelegt.

CREATE DATABASE frost;
CREATE DATABASE ckan;
CREATE DATABASE ckan_datastore;
CREATE DATABASE keycloak;  -- genutzt im Kubernetes-Deployment (KC_DB=postgres)

\connect orion
-- TimescaleDB in der **Apache-Edition** (Apache-2.0): liefert first()/last(),
-- die Mintaka für typ-skopierte Temporal-Abfragen benötigt. TSL-Funktionen
-- (Compression, Continuous Aggregates) sind nicht enthalten und werden nicht
-- genutzt — TRoE arbeitet mit gewöhnlichen Tabellen.
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS postgis;

\connect frost
CREATE EXTENSION IF NOT EXISTS postgis;

\connect ckan
CREATE EXTENSION IF NOT EXISTS postgis;
