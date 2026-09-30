-- SPDX-License-Identifier: EUPL-1.2
-- © 2024–2026 Thomas Kieß and contributors

-- =============================================================================
-- TRoE schema of Orion-LD 1.6.0 (database "orion"), created BEFORE the broker
-- starts. Single source for both deployments: Helm runs it in an init
-- container of orion-ld (ConfigMap troe-schema), docker compose in the
-- one-shot service troe-schema. Run with: psql -v ON_ERROR_STOP=1 -f <file>
--
-- Orion-LD creates its tables itself on start-up, in ONE transaction that
-- begins with CREATE TYPE ValueType/OperationMode (no IF NOT EXISTS). When the
-- types already exist that transaction aborts harmlessly – so everything here
-- takes precedence, and Orion-LD's own DDL becomes a no-op. Types, tables and
-- columns are those of database/sql/current.sql of Orion-LD 1.6.0, with one
-- deliberate difference:
--
--   attributes has NO primary key and is a TimescaleDB hypertable on ts
--   (7-day chunks). The key (instanceId, datasetId, ts) serves no query, is
--   about a third of the table's size, and instanceId is not unique on its
--   own anyway; Orion-LD only INSERTs (never ON CONFLICT, UPDATE or DELETE)
--   and Mintaka only reads. The chunks make the 12-month retention a
--   drop_chunks instead of a DELETE (docs/betrieb.md, "Zeitreihen-Retention").
--
-- Idempotent and safe on every rollout: an advisory lock serialises replicas
-- starting at the same time, and every object is created only when it is
-- missing (a catalog check first – CREATE INDEX IF NOT EXISTS would take a
-- table lock before noticing the index exists and hold up the running
-- broker's inserts). An existing, POPULATED plain attributes table is left
-- alone with a WARNING: converting it is the job of
-- scripts/migrate-troe-hypertable.sh (helm/udp/DEPLOY.md §10d).
--
-- Tenant databases (orion_<tenant>) are created by Orion-LD itself and keep
-- its original schema.
-- =============================================================================

SET lock_timeout = '10s';
SET statement_timeout = '5min';
SET client_min_messages = warning;

BEGIN;

-- Held until COMMIT: replicas starting at the same time run one after the other.
DO $$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('udp-troe-schema')); END $$;

DO $$
BEGIN
  -- Normally created with the database (CNPG Database resource, compose init
  -- script); only a database created by hand lacks them.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    CREATE EXTENSION postgis;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    CREATE EXTENSION timescaledb;
  END IF;

  IF to_regtype('valuetype') IS NULL THEN
    CREATE TYPE ValueType AS ENUM(
      'String',
      'Number',
      'Boolean',
      'Relationship',
      'Compound',
      'DateTime',
      'GeoPoint',
      'GeoMultiPoint',
      'GeoPolygon',
      'GeoMultiPolygon',
      'GeoLineString',
      'GeoMultiLineString',
      'LanguageMap');
  END IF;
  IF to_regtype('operationmode') IS NULL THEN
    CREATE TYPE OperationMode AS ENUM(
      'Create',
      'Append',
      'Update',
      'Replace',
      'Delete');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS entities (
  instanceId TEXT NOT NULL,
  ts TIMESTAMP NOT NULL,
  opMode OperationMode,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  CONSTRAINT entities_pkey PRIMARY KEY (instanceId,ts));

CREATE TABLE IF NOT EXISTS subAttributes (
  instanceId TEXT NOT NULL,
  id TEXT NOT NULL,
  entityId TEXT NOT NULL,
  attrInstanceId TEXT NOT NULL,
  attrDatasetId VARCHAR NOT NULL,
  observedAt TIMESTAMP,
  unitCode TEXT,
  valueType ValueType,
  text TEXT,
  boolean BOOL,
  number FLOAT8,
  datetime TIMESTAMP,
  compound JSONB,
  geoPoint GEOGRAPHY(POINTZ, 4326),
  geoMultiPoint GEOGRAPHY(MULTIPOINTZ, 4326),
  geoPolygon GEOGRAPHY(POLYGONZ, 4326),
  geoMultiPolygon GEOGRAPHY(MULTIPOLYGONZ, 4326),
  geoLineString GEOGRAPHY(LINESTRINGZ, 4326),
  geoMultiLineString GEOGRAPHY(MULTILINESTRINGZ, 4326),
  ts TIMESTAMP NOT NULL,
  CONSTRAINT subattributes_pkey PRIMARY KEY (instanceId,ts));

DO $$
DECLARE
  hypertable boolean;
BEGIN
  IF to_regclass('attributes') IS NULL THEN
    -- Orion-LD's attributes, without its primary key (see the header).
    CREATE TABLE attributes (
      instanceId TEXT NOT NULL,
      id TEXT NOT NULL,
      opMode OperationMode,
      entityId TEXT NOT NULL,
      observedAt TIMESTAMP,
      subProperties BOOL,
      unitCode TEXT,
      datasetId VARCHAR NOT NULL,
      valueType ValueType,
      text TEXT,
      boolean BOOL,
      number FLOAT8,
      datetime TIMESTAMP,
      compound JSONB,
      geoPoint GEOGRAPHY(POINTZ, 4326),
      geoMultiPoint GEOGRAPHY(MULTIPOINTZ, 4326),
      geoPolygon GEOGRAPHY(POLYGONZ, 4326),
      geoMultiPolygon GEOGRAPHY(MULTIPOLYGONZ, 4326),
      geoLineString GEOGRAPHY(LINESTRINGZ, 4326),
      geoMultiLineString GEOGRAPHY(MULTILINESTRINGZ, 4326),
      ts TIMESTAMP NOT NULL);
  END IF;

  hypertable := EXISTS (SELECT 1 FROM timescaledb_information.hypertables
                        WHERE hypertable_schema = current_schema() AND hypertable_name = 'attributes');
  IF NOT hypertable THEN
    -- New, or created by Orion-LD before this script existed but still empty:
    -- convert it. Anything with rows needs the migration script (copy with
    -- dedup, per day, while the platform keeps running).
    IF EXISTS (SELECT 1 FROM attributes LIMIT 1) THEN
      RAISE WARNING 'attributes is a populated plain table – left as it is. Kubernetes: convert it with scripts/migrate-troe-hypertable.sh (helm/udp/DEPLOY.md §10d).';
      RETURN;
    END IF;
    LOCK TABLE attributes IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM attributes LIMIT 1) THEN
      RAISE WARNING 'attributes received rows meanwhile – left as it is. Convert it with scripts/migrate-troe-hypertable.sh.';
      RETURN;
    END IF;
    ALTER TABLE attributes DROP CONSTRAINT IF EXISTS attributes_pkey;
    -- Silences TimescaleDB's "does not follow best practices" warnings about
    -- Orion-LD's column types (timestamp without time zone, varchar).
    PERFORM set_config('client_min_messages', 'error', true);
    PERFORM create_hypertable('attributes', by_range('ts', INTERVAL '7 days'),
                              create_default_indexes => false, if_not_exists => true);
    PERFORM set_config('client_min_messages', 'warning', true);
  END IF;

  -- Indexes of the hypertable. They carry the retention, the statistics
  -- (troe-stats) and Mintaka's temporal queries per entity; their names are
  -- the ones troe-retention checks for.
  IF to_regclass('attributes_ts_idx') IS NULL THEN
    CREATE INDEX attributes_ts_idx ON attributes (ts);
  END IF;
  IF to_regclass('attributes_entityid_ts_idx') IS NULL THEN
    CREATE INDEX attributes_entityid_ts_idx ON attributes (entityid text_pattern_ops, ts);
  END IF;
  -- Mintaka resolves entities by id and time.
  IF to_regclass('entities_id_ts_idx') IS NULL THEN
    CREATE INDEX entities_id_ts_idx ON entities (id, ts);
  END IF;
END
$$;

DO $$
BEGIN
  -- Orion-LD's own index, and the one troe-retention's cut uses. Only on an
  -- empty table: on a populated one the build would hold up the running
  -- broker's inserts – troe-retention creates a missing one at night.
  IF EXISTS (SELECT 1 FROM subattributes LIMIT 1) THEN
    RETURN;
  END IF;
  IF to_regclass('subattributes_attributeid_index') IS NULL THEN
    CREATE INDEX subattributes_attributeid_index ON subAttributes (attrInstanceId,attrDatasetId);
  END IF;
  IF to_regclass('subattributes_ts_idx') IS NULL THEN
    CREATE INDEX subattributes_ts_idx ON subattributes (ts);
  END IF;
END
$$;

COMMIT;
