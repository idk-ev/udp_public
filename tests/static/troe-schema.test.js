/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* The TRoE schema of Orion-LD as a hypertable: the bootstrap script
   (helm/udp/files/postgres/troe-schema.sql), its wiring in Helm and compose,
   and the dedup rule of scripts/migrate-troe-hypertable.sh.

   The SQL itself was verified against TimescaleDB (Apache edition) and
   Orion-LD 1.6.0's own DDL when it was written; there is no database in this
   suite. What can silently break without one is pinned here: a column the
   copy forgets (it would be dropped from the history, or ignored by the
   dedup comparison and collapse rows that differ in it), a primary key that
   creeps back, the Orion-LD compatibility of types and enum labels, and the
   two deployments running different files. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const SCHEMA = read("helm/udp/files/postgres/troe-schema.sql");
const SCRIPT = read("scripts/migrate-troe-hypertable.sh");

/* Column names of a CREATE TABLE in the schema file, lower-cased as Postgres stores them. */
function columns(table) {
  const m = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table} \\(([\\s\\S]*?)\\);`, "i").exec(SCHEMA);
  assert(m, `CREATE TABLE ${table} not found in troe-schema.sql`);
  return m[1].split("\n").map(l => l.trim()).filter(l => l && !/^CONSTRAINT /i.test(l))
    .map(l => l.split(/\s+/)[0].toLowerCase());
}

/* Orion-LD 1.6.0, database/sql/current.sql. */
const ORION_ATTRIBUTES = ["instanceid", "id", "opmode", "entityid", "observedat", "subproperties", "unitcode",
  "datasetid", "valuetype", "text", "boolean", "number", "datetime", "compound", "geopoint", "geomultipoint",
  "geopolygon", "geomultipolygon", "geolinestring", "geomultilinestring", "ts"];

exports["TRoE schema: Orion-LD 1.6.0 types and columns, attributes without primary key as hypertable"] = () => {
  assert(/CREATE TYPE ValueType AS ENUM\(\s*'String',\s*'Number',\s*'Boolean',\s*'Relationship',\s*'Compound',\s*'DateTime',\s*'GeoPoint',\s*'GeoMultiPoint',\s*'GeoPolygon',\s*'GeoMultiPolygon',\s*'GeoLineString',\s*'GeoMultiLineString',\s*'LanguageMap'\);/.test(SCHEMA),
    "ValueType differs from Orion-LD 1.6.0");
  assert(/CREATE TYPE OperationMode AS ENUM\(\s*'Create',\s*'Append',\s*'Update',\s*'Replace',\s*'Delete'\);/.test(SCHEMA),
    "OperationMode differs from Orion-LD 1.6.0");
  // The types come first and only when missing: Orion-LD's own DDL then aborts at its first CREATE TYPE.
  assert(/IF to_regtype\('valuetype'\) IS NULL THEN/.test(SCHEMA) && /IF to_regtype\('operationmode'\) IS NULL THEN/.test(SCHEMA));
  assert.deepStrictEqual(columns("attributes"), ORION_ATTRIBUTES);
  const attributes = /CREATE TABLE attributes \(([\s\S]*?)\);/.exec(SCHEMA)[1];
  assert(!/PRIMARY KEY/i.test(attributes), "attributes has a primary key again");
  assert(/CONSTRAINT entities_pkey PRIMARY KEY \(instanceId,ts\)/.test(SCHEMA), "entities lost Orion-LD's key");
  assert(/CONSTRAINT subattributes_pkey PRIMARY KEY \(instanceId,ts\)/.test(SCHEMA), "subattributes lost Orion-LD's key");
  assert(/create_hypertable\('attributes', by_range\('ts', INTERVAL '7 days'\),\s*create_default_indexes => false, if_not_exists => true\)/.test(SCHEMA));
  // A populated plain table is the migration script's job, never converted here.
  assert(/IF EXISTS \(SELECT 1 FROM attributes LIMIT 1\) THEN\s*RAISE WARNING/.test(SCHEMA));
  assert(/pg_advisory_xact_lock\(hashtext\('udp-troe-schema'\)\)/.test(SCHEMA), "no advisory lock for concurrent replicas");
  for (const index of ["attributes_ts_idx", "attributes_entityid_ts_idx", "entities_id_ts_idx"]) {
    assert(new RegExp(`IF to_regclass\\('${index}'\\) IS NULL THEN\\s*CREATE INDEX ${index} ON`).test(SCHEMA),
      `${index} is not created (only when missing)`);
  }
  const code = SCHEMA.replace(/--.*$/gm, "");
  assert(!/CREATE INDEX IF NOT EXISTS/.test(code), "CREATE INDEX IF NOT EXISTS locks the table before it looks");
};

exports["TRoE schema: Helm and compose run the same file before Orion-LD"] = () => {
  const configmaps = read("helm/udp/templates/configmaps.yaml");
  assert(/troe-schema\.sql: \|\n\{\{ \.Files\.Get "files\/postgres\/troe-schema\.sql" \| indent 4 \}\}/.test(configmaps));
  const broker = read("helm/udp/templates/context-broker.yaml");
  const init = broker.indexOf("- name: troe-schema");
  assert(init > 0 && init < broker.indexOf("- name: orion-ld\n"), "no init container troe-schema before orion-ld");
  assert(/psql -X -q -v ON_ERROR_STOP=1 -f \/troe\/troe-schema\.sql/.test(broker));
  const compose = read("platform/docker-compose.yml");
  assert(/- \.\.\/helm\/udp\/files\/postgres\/troe-schema\.sql:\/troe-schema\.sql:ro/.test(compose),
    "compose does not mount the chart's troe-schema.sql");
  const orion = compose.slice(compose.indexOf("\n  orion-ld:"), compose.indexOf("\n  mintaka:"));
  assert(/troe-schema:\n\s*condition: service_completed_successfully/.test(orion),
    "Orion-LD starts without waiting for troe-schema");
};

exports["TRoE migration: the copy carries every column and compares every value"] = () => {
  const cols = /^COLS="([^"]*)"/m.exec(SCRIPT);
  assert(cols, "COLS not found in migrate-troe-hypertable.sh");
  assert.deepStrictEqual(cols[1].split(",").map(c => c.trim()), ORION_ATTRIBUTES);
  // The series key and the stamps are not compared; everything else is.
  const compared = ORION_ATTRIBUTES.filter(c => !["instanceid", "id", "entityid", "datasetid", "ts"].includes(c));
  for (const c of compared) {
    assert(new RegExp(`lag\\(a\\.${c}\\) OVER w AS p_${c}\\b`).test(SCRIPT), `${c}: no lag() in the dedup`);
    assert(new RegExp(`r\\.p_${c} IS NOT DISTINCT FROM r\\.${c}\\b`).test(SCRIPT), `${c}: not compared in the dedup`);
  }
  assert(/PARTITION BY a\.entityid, a\.id, a\.datasetid ORDER BY a\.ts, a\.instanceid/.test(SCRIPT));
  // Always kept: first row per day and series, Create/Delete, sub-properties, referenced rows.
  // (\$ inside the double-quoted shell string)
  assert(/WHERE a\.ts >= \\\$1 AND a\.ts < \\\$2/.test(SCRIPT), "the copy is not bounded to one day");
  assert(/r\.rn = 1\s*OR r\.opmode IN \('Create', 'Delete'\)\s*OR r\.subproperties IS TRUE/.test(SCRIPT));
  // Through subattributes_attributeid_index, not a list scanned per row.
  assert(/OR EXISTS \(SELECT 1 FROM subattributes s\s+WHERE s\.attrinstanceid = r\.instanceid AND s\.attrdatasetid = r\.datasetid\)/.test(SCRIPT));
  // Bounded sessions.
  for (const limit of ["statement_timeout", "temp_file_limit", "lock_timeout"]) {
    assert(new RegExp(`SET ${limit} = `).test(SCRIPT), `sessions without ${limit}`);
  }
};

/* The body of a shell function of the migration script. */
function fn(name) {
  const m = new RegExp(`\\n${name}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}\\n`).exec(SCRIPT);
  assert(m, `function ${name} not found in migrate-troe-hypertable.sh`);
  return m[1];
}

exports["TRoE migration, low-disk mode: one dedup, one bootstrap, bounded sessions"] = () => {
  // Backfill and import go through the same copy function – there is one dedup, not two.
  assert.strictEqual(SCRIPT.split("CREATE FUNCTION pg_temp.udp_copy_day(").length, 2);
  assert.strictEqual(SCRIPT.split("lag(a.opmode) OVER w").length, 2, "a second dedup query");
  assert(/udp_copy_day\('attributes', 'attributes_new', :'day', true, true\)/.test(fn("copy_days")));
  const importDay = fn("import_day");
  assert(/udp_copy_day\('udp_troe_staging', 'attributes', :'day', false, :'dedup'\)/.test(importDay),
    "import does not use the copy function (non-exclusive: live rows of the cutover day stay)");
  assert(/BEGIN ISOLATION LEVEL REPEATABLE READ;\nINSERT INTO udp_troe_migration/.test(importDay),
    "import: rows and bookkeeping not in one REPEATABLE READ transaction");
  assert(/NOT \\\$3\s*OR r\.rn = 1/.test(SCRIPT), "dedup cannot be switched off (--no-dedup)");
  assert(/printf '%s\\n' "\$SQL_COPY_DAY_FN"/.test(importDay));
  // Export and import carry every column in the same order (COPY text format).
  assert(/COPY \(SELECT \$COLS\s+FROM attributes WHERE ts >= :'day' AND ts < :'day'::date \+ 1 ORDER BY ts\) TO STDOUT;/.test(fn("export_day")));
  // Import unpacks the file in the pod and loads it with the same COPY
  // column list and input settings.
  const importLoad = fn("import_load");
  assert(/"COPY \$STAGING \(\$COLS\) FROM STDIN"/.test(importLoad));
  assert(/sh -c 'gzip -dc \| psql /.test(importLoad), "import does not unpack in the pod");
  assert(importLoad.includes("SET client_encoding = 'UTF8'; SET DateStyle = 'ISO, YMD';"));
  assert(/import_load "\$day" \|\| return 1/.test(importDay));
  // Every psql of the steps is a bounded session with pinned output formats.
  for (const f of ["export_day", "import_day", "day_counts"]) {
    assert(/\bsession -At\b/.test(fn(f)), `${f} does not run in a bounded session`);
  }
  for (const setting of ["DateStyle = 'ISO, YMD'", "extra_float_digits = 3", "client_encoding = 'UTF8'"]) {
    assert(SCRIPT.includes(`SET ${setting};`), `session without SET ${setting}`);
  }
  // The swap runs the chart's bootstrap – the file the init container runs –
  // inside its transaction, without the file's own BEGIN/COMMIT.
  assert(/helm\/udp\/files\/postgres\/troe-schema\.sql/.test(SCRIPT));
  assert(/sed -e '\/\^BEGIN;\$\/d' -e '\/\^COMMIT;\$\/d'/.test(fn("bootstrap_sql")));
  const lines = SCHEMA.split("\n");
  assert.strictEqual(lines.filter(l => l === "BEGIN;").length, 1, "troe-schema.sql: swap-lowdisk expects one BEGIN; line");
  assert.strictEqual(lines.filter(l => l === "COMMIT;").length, 1, "troe-schema.sql: swap-lowdisk expects one COMMIT; line");
  const swap = fn("swap_lowdisk");
  const order = ["writers_back_on_exit swap-lowdisk", "scale_down_writers", "export_days", "LOCK TABLE attributes IN SHARE MODE",
    "are not the ones the export wrote", "attributes changed since the export", "rows outside the exported days",
    "('mode', 'lowdisk')",
    "DROP TABLE attributes;", '"$bootstrap"', "differs from the old one", "COMMIT;", "SWAPPED=1", "resume_writers || die",
    "BACK_STEP=", "entities_index"];
  let at = -1;
  for (const step of order) {
    const i = swap.indexOf(step, at + 1);
    assert(i > at, `swap-lowdisk: "${step}" missing or out of order`);
    at = i;
  }
  // Before the downtime: every day counted once and the largest file dry-run.
  assert(swap.indexOf("dry_run_day") > 0 && swap.indexOf("dry_run_day") < swap.indexOf("scale_down_writers"));
  assert(swap.indexOf("Days changed since their export") < swap.indexOf("scale_down_writers"));
  // An export never reads a swapped table: lock first, then the check, in its own transaction.
  assert(/BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n\$SQL_EXPORT_GUARD\n/.test(fn("export_day")));
  assert(/^LOCK TABLE attributes IN ACCESS SHARE MODE;\nDO/m.test(SCRIPT));
  // No argument to kubectl exec starts with a slash (Git Bash would rewrite it).
  assert(/sh -c 'df -Pk "\/\$1"' sh "\$\{datadir#\/\}"/.test(SCRIPT));
  assert(/application_name=\$APP options=-cstatement_timeout=/.test(SCRIPT));
  // No way back through the database: rollback refuses in low-disk mode.
  assert(/lowdisk && die/.test(fn("rollback")));
};
