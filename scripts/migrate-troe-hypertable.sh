#!/usr/bin/env bash
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# =============================================================================
# Kubernetes: TRoE table "attributes" (Orion-LD, database orion) -> hypertable
#
# Fresh installations create attributes as a TimescaleDB hypertable without a
# primary key (helm/udp/files/postgres/troe-schema.sql). This script converts an
# existing installation whose attributes is still Orion-LD's plain table: it
# copies the history day by day into a new hypertable while the platform keeps
# running, drops unchanged repetitions on the way, and swaps the tables in a
# short downtime. Full runbook: helm/udp/DEPLOY.md §10c.
#
#   0. Grow the database volume first if preflight says so
#      (timescale.persistence.size; the copy needs room next to the old table)
#      – or use the low-disk mode below.
#   1. migrate-troe-hypertable.sh preflight   checks, space estimate
#   2. migrate-troe-hypertable.sh backfill    copy every finished UTC day into
#                                             attributes_new – platform keeps
#                                             running, resumable, repeat it
#                                             right before the cutover
#      migrate-troe-hypertable.sh status      progress, kept/dropped ratio
#   3. migrate-troe-hypertable.sh cutover     DOWNTIME: writers to 0, copy the
#                                             rest, verify, swap the tables,
#                                             writers back up
#   4. migrate-troe-hypertable.sh finalize --drop-old
#                                             after a few days of normal
#                                             operation: drop attributes_old
#
#   Back out (before finalize):
#      migrate-troe-hypertable.sh rollback    writers to 0, rows written since
#                                             the cutover copied back into the
#                                             old table, names swapped back
#
# Low-disk mode – when the volume cannot hold the old table and the new one
# side by side. The history leaves the database for a while: it is exported
# to local files, the old table is dropped, and the files are imported into
# the new hypertable with the same dedup. Between swap-lowdisk and a completed
# import the files are the ONLY copy of the history – keep them (two media).
#
#   1. migrate-troe-hypertable.sh export --dir DIR
#                                 every finished UTC day as DIR/attributes_<day>
#                                 .copy.gz (raw rows, COPY text format) plus
#                                 DIR/manifest.tsv – platform keeps running,
#                                 read from a replica when one is caught up,
#                                 resumable, repeat it right before the swap
#   2. migrate-troe-hypertable.sh swap-lowdisk --dir DIR
#                                 DOWNTIME: writers to 0, export the rest,
#                                 verify every day of attributes against the
#                                 manifest, drop attributes, create the empty
#                                 hypertable (troe-schema.sql), writers back up
#   3. migrate-troe-hypertable.sh import --dir DIR [--no-dedup]
#                                 newest day first into the hypertable –
#                                 platform keeps running, resumable
#      migrate-troe-hypertable.sh status [--dir DIR]
#      migrate-troe-hypertable.sh resume-writers
#                                 scale the writers back to their recorded
#                                 replicas, if a step could not
#   There is no rollback: the files are the full raw history, import
#   --no-dedup loads them without dropping repetitions.
#
# Dedup rule of the copy: within one series (entityid, id, datasetid) ordered
# by ts, a row is dropped only if opmode, valuetype, unitcode, observedat,
# subproperties and every value column equal those of the previous row. Always
# kept: the first row of a series per UTC day (a query window starting at UTC
# midnight finds an anchor value, and days can be copied independently), Create
# and Delete rows, rows with sub-properties, and rows a subattributes row
# refers to. Each day is copied in its own transaction and checked for
# completeness: the rows of the day in the new table must equal the rows the
# copy inserted. The cutover checks every day against the new table again and
# recopies a day that no longer matches (e.g. retention after a rollback).
#
# Every psql session runs in the CNPG primary pod (as postgres, then SET ROLE
# to the owner of attributes) with statement_timeout, temp_file_limit and
# lock_timeout – one day at a time keeps the sort and its temp files small.
#
# Tenant databases of Orion-LD (orion_<tenant>) are not converted.
#
# Environment: KUBECONFIG, KUBE_CONTEXT (pins the kubectl context; default: the
# current one), NAMESPACE (default udp), RELEASE (Helm release, default udp),
# DB (default orion), YES=1 skips the confirmations, EXPORT_DIR (instead of
# --dir), IMPORT_MARGIN (free space import keeps per day, default
# max_wal_size), TROE_SCHEMA (default: the chart's troe-schema.sql next to
# this script).
# Limits per session: STATEMENT_TIMEOUT (default 30min – swap-lowdisk counts
# every day of attributes in it, see DEPLOY.md §10c), TEMP_FILE_LIMIT
# (default 4GB), WORK_MEM (default 64MB).
# =============================================================================
set -euo pipefail

NS="${NAMESPACE:-udp}"
RELEASE="${RELEASE:-udp}"
DB="${DB:-orion}"
CLUSTER=timescale
STATEMENT_TIMEOUT="${STATEMENT_TIMEOUT:-30min}"
TEMP_FILE_LIMIT="${TEMP_FILE_LIMIT:-4GB}"
WORK_MEM="${WORK_MEM:-64MB}"
# Components that write TRoE rows, directly (orion-ld, the connectors'
# retention and statistics) or through the broker (node-red, IoT agent). Mintaka
# only reads and keeps serving.
WRITERS="${WRITERS:-orion-ld,connectors,node-red,iot-agent-json}"
ANN_REPLICAS=udp.idk-ev.de/replicas-before-troe-migration
# Estimated size of the new table relative to the old one without its
# primary key; the margin covers indexes built while inserting and bloat.
SPACE_FACTOR=1.3
# Low-disk mode: bootstrap of the chart, run by swap-lowdisk; staging table of
# import; local size of the export files per row (gzipped COPY text).
TROE_SCHEMA="${TROE_SCHEMA:-$(cd "$(dirname "$0")" && pwd)/../helm/udp/files/postgres/troe-schema.sql}"
STAGING=udp_troe_staging
EXPORT_BYTES_PER_ROW=40
DIR="${EXPORT_DIR:-}"
# Every session of this script carries this name: the busy check of the
# scale-down (application_name LIKE 'udp-troe-%') then also finds a step that
# still runs in the database after its client went away.
APP=udp-troe-migrate
# Longest day range a step accepts (a row stamped years off is a data error).
MAX_DAYS="${MAX_DAYS:-3700}"

# Orion-LD's attributes columns (database/sql/current.sql of Orion-LD 1.6.0).
COLS="instanceid, id, opmode, entityid, observedat, subproperties, unitcode, datasetid, valuetype,
      text, boolean, number, datetime, compound, geopoint, geomultipoint, geopolygon,
      geomultipolygon, geolinestring, geomultilinestring, ts"

k() { kubectl ${KUBE_CONTEXT:+--context "$KUBE_CONTEXT"} -n "$NS" "$@"; }
context() { echo "${KUBE_CONTEXT:-$(kubectl config current-context 2>/dev/null || echo '?')}"; }
log() { printf '\n\033[1m>> %s\033[0m\n' "$*"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
confirm() {
    echo "  kubectl context: $(context), namespace: $NS, database: $DB"
    [ "${YES:-}" = 1 ] && return 0
    read -r -p "$1 [y/N] " a
    [ "$a" = y ] || [ "$a" = Y ] || die "aborted"
}
ann() {
    k get "$1" -o go-template="{{with .metadata.annotations}}{{index . \"$2\"}}{{end}}" 2>/dev/null \
        | sed 's/^<no value>$//'
}

primary() {
    local pod
    pod=$(k get pod -l "cnpg.io/cluster=$CLUSTER,cnpg.io/instanceRole=primary" \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    [ -n "$pod" ] || die "No primary pod of the CNPG cluster $CLUSTER in namespace $NS."
    echo "$pod"
}

# Plain psql in the primary pod (or in POD): local socket, superuser postgres,
# statement_timeout from the start. No argument to kubectl exec may begin with
# a slash: Git Bash on Windows would rewrite it into a Windows path.
psql_raw() {
    k exec -i "${POD:-$PRIMARY}" -c postgres -- psql -v ON_ERROR_STOP=1 -X -q \
        -d "dbname=$DB application_name=$APP options=-cstatement_timeout=$STATEMENT_TIMEOUT" "$@"
}
q() { psql_raw -Atc "$1"; }

# A bounded session: the SQL on stdin runs after the limits and SET ROLE.
# Extra arguments go to psql (e.g. -v day=2026-01-01). The output formats are
# pinned: export files written here are read back by another session.
session() {
    { cat <<EOS
SET statement_timeout = '$STATEMENT_TIMEOUT';
SET temp_file_limit = '$TEMP_FILE_LIMIT';
SET work_mem = '$WORK_MEM';
SET lock_timeout = '5s';
SET synchronous_commit = local;
SET client_min_messages = warning;
SET client_encoding = 'UTF8';
SET DateStyle = 'ISO, YMD';
SET extra_float_digits = 3;
SET ROLE "$OWNER";
EOS
      cat; } | psql_raw "$@" -f -
}

is_hypertable() {
    [ "$(q "SELECT count(*) FROM timescaledb_information.hypertables
            WHERE hypertable_schema = current_schema() AND hypertable_name = '$1'")" != 0 ]
}
exists() { [ "$(q "SELECT to_regclass('$1') IS NOT NULL")" = t ]; }

init() {
    PRIMARY=$(primary)
    exists attributes || die "Table attributes not found in database $DB."
    OWNER=$(q "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'attributes'::regclass")
}

# ---------------------------------------------------------------- writers
scale_down_writers() {
    log "Scaling the TRoE writers to 0 ($WRITERS)"
    local d n list selector="app in ($WRITERS),app.kubernetes.io/instance=$RELEASE"
    list=$(k get deploy -l "$selector" -o name)
    # A wrong RELEASE or namespace would find nothing and stop nothing.
    printf '%s\n' "$list" | grep -qx 'deployment.apps/orion-ld' \
        || die "No deployment orion-ld with app.kubernetes.io/instance=$RELEASE in namespace $NS – check RELEASE/NAMESPACE."
    for d in $list; do
        n=$(k get "$d" -o jsonpath='{.spec.replicas}')
        [ -n "$(ann "$d" "$ANN_REPLICAS")" ] || k annotate "$d" "$ANN_REPLICAS=$n" >/dev/null
        k scale "$d" --replicas=0 >/dev/null
        echo "  $d: $n -> 0"
    done
    k wait pod -l "$selector" --for=delete --timeout=5m >/dev/null 2>&1 || true
    [ -z "$(k get pod -l "$selector" -o name)" ] \
        || die "Pods of the writers are still there after 5 min: $(k get pod -l "$selector" -o name | tr '\n' ' ')"
    # A broker request still in flight would insert after the copy.
    [ "$(q "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
             AND backend_type = 'client backend' AND state <> 'idle' AND pid <> pg_backend_pid()
             AND query ~* 'insert\s+into\s+attributes'")" = 0 ] \
        || die "Inserts into attributes are still running – a writer is still up (WRITERS=$WRITERS)."
    # The swap needs an exclusive lock: a retention run whose client is gone,
    # or a backup dump, would hold it up.
    local busy
    busy=$(q "SELECT string_agg(DISTINCT coalesce(nullif(application_name, ''), 'pid ' || pid), ', ')
              FROM pg_stat_activity WHERE datname = current_database() AND state <> 'idle'
               AND pid <> pg_backend_pid()
               AND (application_name LIKE 'udp-troe-%' OR application_name = 'pg_dump')")
    [ -z "$busy" ] || die "Sessions on the database still at work: $busy – wait for them (or end them) and run the step again."
    # A step of this migration still running in the database (its client gone).
    [ "$(q "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid <> pg_backend_pid()
             AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
             AND ((classid::bigint << 32) | objid::bigint) = hashtext('udp-troe-migration')::bigint")" = 0 ] \
        || die "Another step of this migration still holds its lock in the database – wait for it to end (pg_stat_activity, application_name $APP) and run the step again."
}

# From the scale-down on, any exit – a failed step included – brings the
# writers back; a successful step clears BACK_STEP once it resumed them itself.
# SWAPPED: the tables are swapped, only resuming the writers is left.
BACK_STEP=
SWAPPED=
DIR_LOCK=
cleanup() {
    local status=$?
    set +e
    if [ -n "$BACK_STEP" ]; then
        if [ "$status" != 0 ]; then
            if [ -n "$SWAPPED" ]; then
                echo "The swap is done – only restoring the writers failed."
            elif [ "$BACK_STEP" = swap-lowdisk ]; then
                swap_outcome
            else
                echo "Step failed – nothing was swapped, restoring the writers."
            fi
        fi
        [ "$BACK_STEP" != cutover ] || [ -n "$SWAPPED" ] || forget_provisional
        resume_writers
    fi
    [ -z "$DIR_LOCK" ] || rmdir "$DIR_LOCK" 2>/dev/null || true
}
trap cleanup EXIT
writers_back_on_exit() { BACK_STEP=$1; }

# The days a failed cutover copied are stale as soon as the writers are back.
# (A later step would copy them again anyway: they stay provisional.)
forget_provisional() {
    q "DELETE FROM udp_troe_migration WHERE provisional" >/dev/null \
        || echo "  WARNING: could not clear the provisional days – they are copied again by the next step anyway."
}

# Returns non-zero, with the commands to do it by hand, when a writer could not
# be brought back.
resume_writers() {
    log "Restoring the TRoE writers"
    local d n cur list failed=
    local selector="app in ($WRITERS),app.kubernetes.io/instance=$RELEASE"
    if ! list=$(k get deploy -l "$selector" -o name); then
        echo "  ERROR: could not list the writers. By hand: kubectl -n $NS get deploy -l '$selector' -o yaml," \
             "scale each one back to its annotation $ANN_REPLICAS and remove the annotation."
        return 1
    fi
    for d in $list; do
        n=$(ann "$d" "$ANN_REPLICAS")
        [ -n "$n" ] || continue
        cur=$(k get "$d" -o jsonpath='{.spec.replicas}') || cur=
        if { [ -n "$cur" ] && [ "$cur" -ge "$n" ]; } || k scale "$d" --replicas="$n" >/dev/null; then
            k annotate "$d" "$ANN_REPLICAS-" >/dev/null || true
            echo "  $d: $n"
        else
            failed="$failed
  kubectl ${KUBE_CONTEXT:+--context $KUBE_CONTEXT }-n $NS scale $d --replicas=$n && kubectl ${KUBE_CONTEXT:+--context $KUBE_CONTEXT }-n $NS annotate $d $ANN_REPLICAS-"
        fi
    done
    if [ -n "$failed" ]; then
        echo "  ERROR: could not restore every writer. By hand (or: $0 resume-writers):$failed"
        return 1
    fi
}

# Mintaka's index on entities, built without holding up the broker.
entities_index() {
    log "Index entities_id_ts_idx (CONCURRENTLY, the platform is running)"
    # An invalid index is what an interrupted CREATE INDEX CONCURRENTLY leaves.
    if [ "$(q "SELECT NOT indisvalid FROM pg_index WHERE indexrelid = to_regclass('entities_id_ts_idx')")" = t ]; then
        session <<<"DROP INDEX CONCURRENTLY entities_id_ts_idx;" || true
    fi
    session <<'EOS' || echo "  WARNING: could not create entities_id_ts_idx – create it later: CREATE INDEX CONCURRENTLY entities_id_ts_idx ON entities (id, ts);"
SET statement_timeout = 0;
CREATE INDEX CONCURRENTLY IF NOT EXISTS entities_id_ts_idx ON entities (id, ts);
EOS
}

# ---------------------------------------------------------------- SQL
# Progress per UTC day and the cutover timestamp; dropped by finalize. A day
# copied by the cutover is provisional: its writers were down only for that
# attempt, so a failed attempt must never let a later step skip it.
SQL_BOOKKEEPING="
CREATE TABLE IF NOT EXISTS udp_troe_migration (
  day date PRIMARY KEY, source_rows bigint NOT NULL, kept_rows bigint NOT NULL,
  provisional boolean NOT NULL DEFAULT false,
  copied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS udp_troe_migration_state (key text PRIMARY KEY, value text NOT NULL);"

# The new table: Orion-LD's columns, no primary key, hypertable on ts with
# 7-day chunks, the two indexes of the platform under temporary names.
SQL_CREATE_NEW="
DO \$\$
BEGIN
  IF to_regclass('attributes_new') IS NULL THEN
    CREATE TABLE attributes_new (LIKE attributes INCLUDING DEFAULTS);
    PERFORM set_config('client_min_messages', 'error', true);
    PERFORM create_hypertable('attributes_new', by_range('ts', INTERVAL '7 days'),
                              create_default_indexes => false);
    PERFORM set_config('client_min_messages', 'warning', true);
    CREATE INDEX attributes_new_ts_idx ON attributes_new (ts);
    CREATE INDEX attributes_new_entityid_ts_idx ON attributes_new (entityid text_pattern_ops, ts);
  END IF;
END
\$\$;"

# Copies one UTC day from src to dst with the dedup rule (header) and verifies
# it; returns the rows of the day in src and the rows kept. exclusive: dst
# holds nothing else of the day – it is emptied first, the copy is idempotent
# (backfill, cutover). Otherwise dst keeps its rows of the day and only the
# inserted ones are checked (import: live rows of the cutover day); that check
# needs a REPEATABLE READ transaction. dedup false keeps every row. A
# temporary function – nothing stays behind.
SQL_COPY_DAY_FN="
CREATE FUNCTION pg_temp.udp_copy_day(src regclass, dst regclass, d date, exclusive boolean,
                                      dedup boolean, OUT source_rows bigint, OUT kept_rows bigint)
LANGUAGE plpgsql AS \$f\$
DECLARE
  lo timestamp := d;
  hi timestamp := d + 1;
  before bigint := 0;
  copied bigint;
BEGIN
  IF exclusive THEN
    EXECUTE format('DELETE FROM %s WHERE ts >= \$1 AND ts < \$2', dst) USING lo, hi;
  ELSE
    EXECUTE format('SELECT count(*) FROM %s WHERE ts >= \$1 AND ts < \$2', dst) USING lo, hi INTO before;
  END IF;
  EXECUTE format('SELECT count(*) FROM %s WHERE ts >= \$1 AND ts < \$2', src) USING lo, hi INTO source_rows;
  EXECUTE format(\$q\$
    WITH one_day AS (
      SELECT a.*,
             row_number() OVER w AS rn,
             lag(a.opmode) OVER w AS p_opmode, lag(a.valuetype) OVER w AS p_valuetype,
             lag(a.unitcode) OVER w AS p_unitcode, lag(a.observedat) OVER w AS p_observedat,
             lag(a.subproperties) OVER w AS p_subproperties, lag(a.text) OVER w AS p_text,
             lag(a.boolean) OVER w AS p_boolean, lag(a.number) OVER w AS p_number,
             lag(a.datetime) OVER w AS p_datetime, lag(a.compound) OVER w AS p_compound,
             lag(a.geopoint) OVER w AS p_geopoint, lag(a.geomultipoint) OVER w AS p_geomultipoint,
             lag(a.geopolygon) OVER w AS p_geopolygon, lag(a.geomultipolygon) OVER w AS p_geomultipolygon,
             lag(a.geolinestring) OVER w AS p_geolinestring,
             lag(a.geomultilinestring) OVER w AS p_geomultilinestring
      FROM %1\$s a
      WHERE a.ts >= \$1 AND a.ts < \$2
      WINDOW w AS (PARTITION BY a.entityid, a.id, a.datasetid ORDER BY a.ts, a.instanceid)
    ), marked AS (
      SELECT r.*,
             (NOT \$3
              OR r.rn = 1
              OR r.opmode IN ('Create', 'Delete')
              OR r.subproperties IS TRUE
              OR NOT (r.p_opmode IS NOT DISTINCT FROM r.opmode
                      AND r.p_valuetype IS NOT DISTINCT FROM r.valuetype
                      AND r.p_unitcode IS NOT DISTINCT FROM r.unitcode
                      AND r.p_observedat IS NOT DISTINCT FROM r.observedat
                      AND r.p_subproperties IS NOT DISTINCT FROM r.subproperties
                      AND r.p_text IS NOT DISTINCT FROM r.text
                      AND r.p_boolean IS NOT DISTINCT FROM r.boolean
                      AND r.p_number IS NOT DISTINCT FROM r.number
                      AND r.p_datetime IS NOT DISTINCT FROM r.datetime
                      AND r.p_compound IS NOT DISTINCT FROM r.compound
                      AND r.p_geopoint IS NOT DISTINCT FROM r.geopoint
                      AND r.p_geomultipoint IS NOT DISTINCT FROM r.geomultipoint
                      AND r.p_geopolygon IS NOT DISTINCT FROM r.geopolygon
                      AND r.p_geomultipolygon IS NOT DISTINCT FROM r.geomultipolygon
                      AND r.p_geolinestring IS NOT DISTINCT FROM r.geolinestring
                      AND r.p_geomultilinestring IS NOT DISTINCT FROM r.geomultilinestring)
              OR EXISTS (SELECT 1 FROM subattributes s
                         WHERE s.attrinstanceid = r.instanceid AND s.attrdatasetid = r.datasetid)) AS keep
      FROM one_day r
    ), ins AS (
      INSERT INTO %2\$s ($COLS)
      SELECT $COLS FROM marked WHERE keep
      RETURNING 1
    )
    SELECT count(*) FROM ins
  \$q\$, src, dst) USING lo, hi, dedup INTO kept_rows;
  EXECUTE format('SELECT count(*) FROM %s WHERE ts >= \$1 AND ts < \$2', dst) USING lo, hi INTO copied;
  copied := copied - before;
  IF copied <> kept_rows OR kept_rows > source_rows THEN
    RAISE EXCEPTION 'day %: % rows in %, % inserted of % in %', d, copied, dst, kept_rows, source_rows, src;
  END IF;
END
\$f\$;"

# Days of attributes to copy, oldest first: every day up to \$1 without a
# final copy, and every day from \$2 on regardless (copy_days is idempotent).
days_todo() {
    q "SELECT to_char(d, 'YYYY-MM-DD') FROM generate_series(
         (SELECT min(ts)::date FROM attributes), $1, interval '1 day') d
       WHERE d::date >= ${2:-'infinity'::date}
          OR d::date NOT IN (SELECT day FROM udp_troe_migration WHERE NOT provisional)
       ORDER BY d"
}

# Days whose rows in attributes_new no longer match their copy (retention or
# writes after a rollback), and days in attributes_new without a copy.
changed_days() {
    q "SELECT to_char(coalesce(m.day, n.day), 'YYYY-MM-DD')
       FROM udp_troe_migration m
       FULL JOIN (SELECT ts::date AS day, count(*) AS n FROM attributes_new GROUP BY 1) n ON n.day = m.day
       WHERE m.day IS NULL OR coalesce(n.n, 0) <> m.kept_rows ORDER BY 1"
}

# The first day that is not finished yet: Orion-LD stamps rows with the request
# time, a request still in flight may insert shortly after midnight.
horizon() { q "SELECT ((now() AT TIME ZONE 'utc') - interval '1 hour')::date"; }

# Copies the given days, one transaction each; stops at the first failure.
# PROVISIONAL=true marks them as copied by the cutover.
copy_days() {
    local day out
    for day in "$@"; do
        out=$( { printf '%s\n' "$SQL_COPY_DAY_FN"; cat <<'EOS'
BEGIN ISOLATION LEVEL REPEATABLE READ;
DO $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('udp-troe-migration')) THEN
    RAISE EXCEPTION 'another step of this migration is running – run one at a time';
  END IF;
END
$$;
INSERT INTO udp_troe_migration (day, source_rows, kept_rows, provisional)
  SELECT :'day', source_rows, kept_rows, :'provisional'
  FROM pg_temp.udp_copy_day('attributes', 'attributes_new', :'day', true, true)
  ON CONFLICT (day) DO UPDATE SET source_rows = EXCLUDED.source_rows,
    kept_rows = EXCLUDED.kept_rows, provisional = EXCLUDED.provisional, copied_at = now();
SELECT source_rows || ' ' || kept_rows FROM udp_troe_migration WHERE day = :'day';
COMMIT;
EOS
            } | session -At -v day="$day" -v provisional="${PROVISIONAL:-false}") \
            || die "day $day failed (see above) – nothing of it was kept; fix the cause and run the step again."
        print_day "$day" "$(printf '%s\n' "$out" | tail -n 1)"
    done
}

# day, "source_rows kept_rows"
print_day() {
    awk -v d="$1" -v s="${2% *}" -v k="${2#* }" 'BEGIN {
        printf "  %s  %12d rows  %12d kept  %5.1f %% dropped\n", d, s, k, (s > 0 ? 100 * (s - k) / s : 0) }'
}

report() {
    log "Progress"
    psql_raw -c "SELECT count(*) AS days, min(day) AS first, max(day) AS last,
                        sum(source_rows) AS source_rows, sum(kept_rows) AS kept_rows,
                        round(100 * (1 - sum(kept_rows)::numeric / nullif(sum(source_rows), 0)), 1) AS dropped_pct
                 FROM udp_troe_migration"
    psql_raw -c "SELECT c.relname AS table, pg_size_pretty(CASE WHEN h.hypertable_name IS NULL
                        THEN pg_total_relation_size(c.oid)
                        ELSE hypertable_size(c.oid) END) AS size
                 FROM pg_class c
                 LEFT JOIN timescaledb_information.hypertables h
                   ON h.hypertable_schema = current_schema() AND h.hypertable_name = c.relname
                 WHERE c.relname IN ('attributes', 'attributes_new', 'attributes_old')
                   AND c.relnamespace = current_schema()::regnamespace ORDER BY 1"
}

# ---------------------------------------------------------------- steps
preflight() {
    log "Preflight (context $(context), namespace $NS, database $DB, primary $PRIMARY, owner $OWNER)"
    local version old_size pk_size new_size wal need pod free min_free=
    version=$(q "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'")
    [ -n "$version" ] || die "Extension timescaledb is missing in $DB."
    [ "$(q "SELECT string_to_array(split_part('$version', '-', 1), '.')::int[] >= '{2,13}'")" = t ] \
        || die "TimescaleDB $version is too old (2.13 or newer needed for by_range)."
    echo "  timescaledb $version ($(q "SHOW timescaledb.license") edition)"
    if is_hypertable attributes; then
        if lowdisk; then
            echo "  attributes was swapped in low-disk mode – import --dir DIR loads the history, status shows the progress."
        elif exists attributes_old; then
            echo "  attributes is already the hypertable – cut over, not finalized (rollback or finalize)."
        else
            echo "  attributes is already a hypertable – nothing to migrate."
        fi
        exit 0
    fi
    echo "  attributes: plain table"
    if exists attributes_new; then
        is_hypertable attributes_new || die "attributes_new exists but is no hypertable – not from this script; drop or rename it."
        echo "  attributes_new: hypertable of an earlier backfill – it will be resumed"
    fi
    exists attributes_ts_idx \
        || die "Index attributes_ts_idx is missing – the copy reads day ranges through it. troe-retention creates it at night, or: CREATE INDEX CONCURRENTLY attributes_ts_idx ON attributes (ts);"
    [ "$(q "SELECT relacl IS NULL FROM pg_class WHERE oid = 'attributes'::regclass")" = t ] \
        || echo "  WARNING: attributes carries grants ($(q "SELECT relacl FROM pg_class WHERE oid = 'attributes'::regclass")) – repeat them on the new table after the cutover."
    echo "  subattributes: $(q "SELECT count(*) FROM subattributes") rows (a row referenced there is always kept)"

    old_size=$(q "SELECT pg_total_relation_size('attributes')")
    pk_size=$(q "SELECT coalesce(pg_relation_size(to_regclass('attributes_pkey')), 0)")
    new_size=0
    exists attributes_new && new_size=$(q "SELECT hypertable_size('attributes_new')")
    # Plus max_wal_size: WAL shares the volume and grows with the copy.
    wal=$(q "SELECT pg_size_bytes(current_setting('max_wal_size'))")
    need=$(awk -v o="$old_size" -v p="$pk_size" -v n="$new_size" -v f="$SPACE_FACTOR" -v w="$wal" \
        'BEGIN { x = (o - p) * f - n; printf "%d", (x > 0 ? x : 0) + w }')
    echo "  attributes $(q "SELECT pg_size_pretty($old_size::bigint)") (primary key $(q "SELECT pg_size_pretty($pk_size::bigint)"))," \
         "copied so far $(q "SELECT pg_size_pretty($new_size::bigint)")"
    echo "  still needed (without dedup, x$SPACE_FACTOR, plus max_wal_size): $(q "SELECT pg_size_pretty($need::bigint)")"

    # Every instance holds a full copy – the smallest free space counts.
    local rows
    read_free
    while read -r pod free; do
        echo "  $pod: $(q "SELECT pg_size_pretty($free::bigint)") free"
    done <<<"$FREE_LINES"
    min_free=$MIN_FREE
    rows=$(q "SELECT greatest(reltuples, 0)::bigint FROM pg_class WHERE oid = 'attributes'::regclass")
    if [ "$min_free" -lt "$need" ]; then
        die "Not enough free space on the database volume for the copy next to the old table: $(q "SELECT pg_size_pretty($need::bigint)") needed, $(q "SELECT pg_size_pretty($min_free::bigint)") free on the fullest instance. Either grow the volume first (timescale.persistence.size) – the old table stays until finalize – or use the low-disk mode (export, swap-lowdisk, import): it needs no room next to the old table, but about $(q "SELECT pg_size_pretty($rows::bigint * $EXPORT_BYTES_PER_ROW)") of local disk for the export files ($rows rows × ~$EXPORT_BYTES_PER_ROW bytes; export projects it from the days already written). helm/udp/DEPLOY.md §10c."
    fi
    echo "  space: ok (low-disk mode instead: about $(q "SELECT pg_size_pretty($rows::bigint * $EXPORT_BYTES_PER_ROW)") of local disk for the export files)"

    local tenants
    tenants=$(q "SELECT string_agg(datname, ' ') FROM pg_database WHERE datname LIKE 'orion\_%'")
    [ -z "$tenants" ] || echo "  NOTE: tenant databases are not converted: $tenants"
    echo "  The copy writes WAL of about the size of the new table (replication, archive)."
}

backfill() {
    preflight
    confirm "Copy the finished days of attributes into attributes_new (the platform keeps running)?"
    session <<EOS
$SQL_BOOKKEEPING
$SQL_CREATE_NEW
EOS
    # Only finished days; days a failed cutover copied are copied again.
    local last todo
    last=$(q "SELECT '$(horizon)'::date - 1")
    todo=$(days_todo "'$last'::date")
    log "Backfill up to $last: $(printf '%s\n' "$todo" | grep -c . || true) days to copy"
    # shellcheck disable=SC2086
    copy_days $todo
    report
    echo; echo "Repeat backfill right before the cutover – the cutover then copies only the last day(s)."
}

cutover() {
    is_hypertable attributes && die "attributes is already the hypertable."
    exists attributes_new || die "attributes_new is missing – run backfill first."
    local h last todo n
    h=$(horizon)
    last=$(q "SELECT greatest((now() AT TIME ZONE 'utc')::date, (SELECT max(ts)::date FROM attributes))")
    n=$(days_todo "'$last'::date" "'$h'::date" | grep -c . || true)
    log "Cutover: about $n day(s) to copy during the downtime (from $h on always)"
    confirm "The TRoE writers ($WRITERS) go down until the tables are swapped. Continue?"
    writers_back_on_exit cutover
    scale_down_writers
    # From here on attributes no longer changes. The bounds are taken again:
    # the downtime may have crossed midnight (UTC).
    h=$(horizon)
    last=$(q "SELECT greatest((now() AT TIME ZONE 'utc')::date, (SELECT max(ts)::date FROM attributes))")
    todo=$(days_todo "'$last'::date" "'$h'::date")
    log "Copying the days from $h to $last and any day without a final copy"
    # shellcheck disable=SC2086
    PROVISIONAL=true copy_days $todo
    log "Verifying every day of attributes_new against the bookkeeping"
    local stale
    stale=$(changed_days)
    if [ -n "$stale" ]; then
        echo "  copying again (changed since their copy): $(echo $stale)"
        # shellcheck disable=SC2086
        PROVISIONAL=true copy_days $stale
        stale=$(changed_days)
        [ -z "$stale" ] || die "days still differ from their copy: $(echo $stale)"
    fi
    echo "  attributes_new: $(q "SELECT count(*) FROM attributes_new") rows, every day as copied"
    log "Swapping the tables"
    # The checks run after the renames, under their exclusive lock: nothing can
    # reach the old table past them.
    session -v from="$h" -v last="$last" <<'EOS' || die "swap failed – rolled back, nothing changed."
BEGIN;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('udp-troe-migration')) \gset
ALTER TABLE attributes RENAME TO attributes_old;
SELECT set_config('udp.cutover_from', :'from', true) AS f, set_config('udp.cutover_last', :'last', true) AS l \gset
DO $$
DECLARE
  idx text;
  late bigint;
  bad text;
BEGIN
  SELECT count(*) INTO late FROM attributes_old
   WHERE ts >= current_setting('udp.cutover_last')::date + 1;
  IF late > 0 THEN
    RAISE EXCEPTION '% rows after % in the old table – a writer is still up', late, current_setting('udp.cutover_last');
  END IF;
  SELECT string_agg(m.day::text, ', ') INTO bad
    FROM udp_troe_migration m
   WHERE m.day >= current_setting('udp.cutover_from')::date
     AND m.source_rows <> (SELECT count(*) FROM attributes_old a
                            WHERE a.ts >= m.day AND a.ts < m.day + 1);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'rows were written into the old table after the copy of %', bad;
  END IF;
  FOREACH idx IN ARRAY ARRAY['attributes_pkey', 'attributes_ts_idx', 'attributes_entityid_ts_idx'] LOOP
    IF to_regclass(idx) IS NOT NULL THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I', idx, replace(idx, 'attributes_', 'attributes_old_'));
    END IF;
  END LOOP;
END
$$;
ALTER TABLE attributes_new RENAME TO attributes;
ALTER INDEX attributes_new_ts_idx RENAME TO attributes_ts_idx;
ALTER INDEX attributes_new_entityid_ts_idx RENAME TO attributes_entityid_ts_idx;
UPDATE udp_troe_migration SET provisional = false WHERE provisional;
INSERT INTO udp_troe_migration_state (key, value)
  VALUES ('cutover_ts', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS.US'))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
COMMIT;
EOS
    SWAPPED=1
    resume_writers || die "The cutover is done, but not every writer came back (see above)."
    BACK_STEP=
    entities_index
    log "Statistics of the new table (ANALYZE, the platform is running)"
    session <<'EOS'
SET statement_timeout = 0;
ANALYZE attributes;
EOS
    report
    cat <<EOT

Done. attributes is the hypertable, the old table stays as attributes_old.
Watch the TRoE inflow for a few hours (troe-stats: troeRows1h/ingestByHour on
PlatformStatus:udp-troe) – Orion-LD does not report failed inserts.
Back out: $0 rollback   ·   after a few days: $0 finalize --drop-old
EOT
}

rollback() {
    lowdisk && die "attributes was swapped in low-disk mode – there is no old table to go back to. The export files are the full raw history: import --dir DIR --no-dedup loads the days not imported yet without dropping repetitions (helm/udp/DEPLOY.md §10c)."
    exists attributes_old || die "attributes_old is missing – nothing to roll back (finalized, or never cut over)."
    is_hypertable attributes || die "attributes is not the hypertable – already rolled back?"
    exists attributes_old_pkey \
        || die "attributes_old has no primary key attributes_old_pkey – the copy back relies on it against duplicates."
    local since from days day
    since=$(q "SELECT value FROM udp_troe_migration_state WHERE key = 'cutover_ts'")
    [ -n "$since" ] || die "No cutover timestamp recorded."
    # A margin for clock skew between the database and Orion-LD: rows the old
    # table already has are skipped by its primary key.
    from=$(q "SELECT to_char('$since'::timestamp - interval '15 minutes', 'YYYY-MM-DD HH24:MI:SS.US')")
    confirm "Swap back to the old table? Rows written since the cutover ($since UTC) are copied back."
    writers_back_on_exit rollback
    scale_down_writers
    log "Copying the rows since $from UTC back, day by day"
    days=$(q "SELECT to_char(d, 'YYYY-MM-DD') FROM generate_series('$from'::date,
                (SELECT greatest(max(ts)::date, '$from'::date) FROM attributes), interval '1 day') d")
    for day in $days; do
        session -At -v from="$from" -v day="$day" <<EOS || die "copying back $day failed – nothing swapped."
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('udp-troe-migration')) \gset
WITH ins AS (
  INSERT INTO attributes_old ($COLS)
  SELECT $COLS FROM attributes
  WHERE ts >= greatest(:'from'::timestamp, :'day'::date) AND ts < :'day'::date + 1
  ON CONFLICT DO NOTHING
  RETURNING 1)
SELECT '  ' || :'day' || ': ' || count(*) || ' rows copied back' FROM ins;
COMMIT;
EOS
    done
    log "Swapping the names back"
    session -v from="$from" <<EOS || die "rollback failed – rolled back, nothing changed."
BEGIN;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('udp-troe-migration')) \gset
ALTER TABLE attributes RENAME TO attributes_new;
ALTER INDEX attributes_ts_idx RENAME TO attributes_new_ts_idx;
ALTER INDEX attributes_entityid_ts_idx RENAME TO attributes_new_entityid_ts_idx;
ALTER TABLE attributes_old RENAME TO attributes;
DO \$\$
DECLARE
  idx text;
BEGIN
  FOREACH idx IN ARRAY ARRAY['attributes_old_pkey', 'attributes_old_ts_idx', 'attributes_old_entityid_ts_idx'] LOOP
    IF to_regclass(idx) IS NOT NULL THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I', idx, replace(idx, 'attributes_old_', 'attributes_'));
    END IF;
  END LOOP;
END
\$\$;
-- Days from the cutover on are copied again by the next cutover.
DELETE FROM udp_troe_migration WHERE day >= :'from'::date;
DELETE FROM udp_troe_migration_state WHERE key = 'cutover_ts';
COMMIT;
EOS
    SWAPPED=1
    resume_writers || die "The rollback is done, but not every writer came back (see above)."
    BACK_STEP=
    report
    echo; echo "attributes is the old plain table again; attributes_new keeps the copy for another cutover."
}

finalize() {
    lowdisk && { finalize_lowdisk; return; }
    [ "${DROP_OLD:-}" = 1 ] || die "finalize drops attributes_old for good – confirm with: $0 finalize --drop-old"
    is_hypertable attributes || die "attributes is not the hypertable – finalize only after a cutover."
    exists attributes_old || die "attributes_old is already gone."
    local since late
    since=$(q "SELECT value FROM udp_troe_migration_state WHERE key = 'cutover_ts'")
    [ -n "$since" ] || die "No cutover timestamp recorded."
    late=$(q "SELECT count(*) FROM attributes_old WHERE ts >= '$since'::timestamp")
    [ "$late" = 0 ] || die "attributes_old has $late rows from after the cutover – they are not in attributes; not dropping it."
    report
    confirm "Drop attributes_old and the migration bookkeeping? There is no way back afterwards."
    session <<'EOS'
SET lock_timeout = '30s';
DROP TABLE attributes_old;
DROP TABLE IF EXISTS udp_troe_migration, udp_troe_migration_state;
EOS
    log "attributes_old dropped – its space is free again."
}

# ---------------------------------------------------------------- low-disk mode
state() {
    exists udp_troe_migration_state || return 0
    q "SELECT value FROM udp_troe_migration_state WHERE key = '$1'"
}
lowdisk() { [ "$(state mode)" = lowdisk ]; }

# Free space of the data volume on every instance – each holds a full copy:
# "pod bytes" lines in FREE_LINES, the smallest in MIN_FREE. A value that
# cannot be read stops the step; it never counts as 0 or as plenty. The path
# goes to df relative (see psql_raw).
read_free() {
    local datadir pods pod out free
    datadir=$(q "SHOW data_directory") || die "Could not read data_directory."
    [[ "$datadir" == /* ]] || die "Unexpected data_directory '$datadir'."
    pods=$(k get pod -l "cnpg.io/cluster=$CLUSTER" -o jsonpath='{.items[*].metadata.name}') \
        || die "Could not list the instances of the CNPG cluster $CLUSTER."
    [ -n "$pods" ] || die "No instances of the CNPG cluster $CLUSTER found."
    FREE_LINES=
    MIN_FREE=
    for pod in $pods; do
        out=$(k exec "$pod" -c postgres -- sh -c 'df -Pk "/$1"' sh "${datadir#/}" 2>&1) \
            || die "Could not read the free space of $pod: $out"
        free=$(printf '%s\n' "$out" | awk 'NR == 2 && $4 ~ /^[0-9]+$/ { printf "%.0f", $4 * 1024 }')
        [[ "$free" =~ ^[0-9]+$ ]] || die "Could not read the free space of $pod: $out"
        FREE_LINES="$FREE_LINES$pod $free"$'\n'
        if [ -z "$MIN_FREE" ] || [ "$free" -lt "$MIN_FREE" ]; then MIN_FREE=$free; fi
    done
    FREE_LINES=${FREE_LINES%$'\n'}
}

# Read from stdin: the printed name does not depend on how DIR is spelled.
sha256() {
    if command -v sha256sum >/dev/null; then sha256sum < "$1"; else shasum -a 256 < "$1"; fi | awk '{ print $1 }'
}
hsize() {
    awk -v b="${1:-0}" 'BEGIN { split("B KB MB GB TB", u); i = 1
        while (b >= 1024 && i < 5) { b /= 1024; i++ }
        printf (i == 1 ? "%d %s" : "%.1f %s"), b, u[i] }'
}

need_dir() {
    [ -n "$DIR" ] || die "No export directory – pass --dir DIR (or set EXPORT_DIR)."
    MANIFEST="$DIR/manifest.tsv"
}
# export and swap-lowdisk write into DIR – one run at a time.
lock_dir() {
    mkdir -p "$DIR" || die "Cannot create $DIR."
    mkdir "$DIR/.lock" 2>/dev/null \
        || die "$DIR is in use by another run (after a crash: remove $DIR/.lock)."
    DIR_LOCK="$DIR/.lock"
}

# manifest.tsv, sorted by day: day <TAB> rows <TAB> bytes <TAB> sha256 of the
# file. A day is in it only with a complete file whose lines matched the rows
# of the day in the database at export time. A file that export replaces
# stays as <file>.prev until the day is exported again; nothing reads .prev.
day_file() { echo "$DIR/attributes_$1.copy.gz"; }
manifest_line() { [ ! -f "$MANIFEST" ] || awk -F'\t' -v d="$1" '$1 == d' "$MANIFEST"; }
manifest_days() { [ ! -f "$MANIFEST" ] || cut -f1 "$MANIFEST"; }
manifest_put() {
    { [ ! -f "$MANIFEST" ] || awk -F'\t' -v d="$1" '$1 != d' "$MANIFEST"
      printf '%s\t%s\t%s\t%s\n' "$@"; } | LC_ALL=C sort > "$MANIFEST.tmp" \
        && mv -f "$MANIFEST.tmp" "$MANIFEST"
}
# Every line: a date, rows, bytes and a 64-digit sha256; every day once.
manifest_check() {
    [ -f "$MANIFEST" ] || die "No manifest in $DIR – run export first."
    local bad
    bad=$(awk -F'\t' 'NF != 4 || $1 !~ /^[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]$/ \
                      || $2 !~ /^[0-9]+$/ || $3 !~ /^[0-9]+$/ || length($4) != 64 || $4 ~ /[^0-9a-f]/ \
                      || seen[$1]++ { print "line " NR ": " $0 }' "$MANIFEST") \
        || die "Could not read $MANIFEST."
    [ -z "$bad" ] || die "$MANIFEST is damaged ($(printf '%s\n' "$bad" | head -n 3 | tr '\n' ' ')) – before the swap: run export again; after it: restore the manifest from the second copy."
}
# A day of the manifest whose file is there and still has its checksum.
file_ok() {
    local line f
    line=$(manifest_line "$1")
    f=$(day_file "$1")
    [ -n "$line" ] && [ -f "$f" ] && [ "$(sha256 "$f")" = "$(printf '%s' "$line" | cut -f4)" ]
}
# Bytes per row of the files written so far (enough of them), or the estimate.
bytes_per_row() {
    local b
    b=$([ ! -f "$MANIFEST" ] || awk -F'\t' '{ r += $2; b += $3 } END { if (r >= 10000) printf "%d", b / r + 1 }' "$MANIFEST")
    echo "${b:-$EXPORT_BYTES_PER_ROW}"
}

# A day range of at most MAX_DAYS days (a row stamped far off is a data error,
# not years of history); dies otherwise.
check_span() {
    local span
    span=$(q "SELECT '$2'::date - '$1'::date") || die "Unusable day range $1 to $2 (rows stamped at infinity?)."
    [[ "$span" =~ ^-?[0-9]+$ ]] || die "Unusable day range $1 to $2."
    [ "$span" -le "$MAX_DAYS" ] \
        || die "Day range $1 to $2 spans $span days – more than MAX_DAYS=$MAX_DAYS. Rows stamped far in the past or future? Check min(ts) and max(ts) of attributes."
}
days_between() {
    [ -n "$1" ] && [ -n "$2" ] || return 0
    check_span "$1" "$2"
    q "SELECT to_char(d, 'YYYY-MM-DD') FROM generate_series('$1'::date, '$2'::date, interval '1 day') d"
}

# Reads for the export come from a replica that has replayed everything the
# primary had written when the export started (it then sees every finished
# day as the primary does); otherwise from the primary. A pod labelled replica
# that is the primary after a failover qualifies as well.
pick_source() {
    local lsn pod i pos
    SOURCE=$PRIMARY
    lsn=$(q "SELECT pg_current_wal_lsn()")
    for pod in $(k get pod -l "cnpg.io/cluster=$CLUSTER,cnpg.io/instanceRole=replica" \
                     -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true); do
        [ "$(k get pod "$pod" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)" = True ] \
            || continue
        for i in 1 2 3 4 5 6; do
            pos=$(POD=$pod q "SELECT CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn()
                                          ELSE pg_current_wal_lsn() END >= '$lsn'::pg_lsn" 2>/dev/null || true)
            if [ "$pos" = t ]; then SOURCE=$pod; return 0; fi
            sleep 5
        done
        echo "  $pod has not caught up with the primary – not reading from it."
    done
}

# Rows per day from $1 to $2 as "day rows" on pod $3 – through attributes_ts_idx,
# one day at a time.
day_counts() {
    POD=$3 session -At -v first="$1" -v last="$2" <<'EOS'
SELECT to_char(d, 'YYYY-MM-DD') || ' ' || (SELECT count(*) FROM attributes a WHERE a.ts >= d AND a.ts < d + 1)
FROM generate_series(:'first'::date, :'last'::date, interval '1 day') g, LATERAL (SELECT g::date AS d) x
ORDER BY d;
EOS
}

# First statements of every export transaction. The lock comes before the
# snapshot: if a swap committed meanwhile, "attributes" is the new table and
# the check sees it – an export never writes the empty new table over a file.
SQL_EXPORT_GUARD="
LOCK TABLE attributes IN ACCESS SHARE MODE;
DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables
             WHERE hypertable_schema = current_schema() AND hypertable_name = 'attributes') THEN
    RAISE EXCEPTION 'attributes is already the hypertable – not exporting over the files';
  END IF;
  IF to_regclass('udp_troe_migration_state') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM udp_troe_migration_state WHERE key = 'mode' AND value = 'lowdisk') THEN
      RAISE EXCEPTION 'a low-disk swap is recorded – not exporting over the files';
    END IF;
  END IF;
END
\$\$;"

# Streams one UTC day of attributes from pod $2 into its file and records it.
# The count and the COPY see one snapshot; the file must have as many lines.
# Written under a temporary name – a day is either complete or not there.
export_day() {
    local day=$1 pod=$2 f part n lines bytes sum
    f=$(day_file "$day")
    part="$f.part"
    n=$( { cat <<EOS
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
$SQL_EXPORT_GUARD
SELECT count(*) FROM attributes WHERE ts >= :'day' AND ts < :'day'::date + 1;
COPY (SELECT $COLS
      FROM attributes WHERE ts >= :'day' AND ts < :'day'::date + 1 ORDER BY ts) TO STDOUT;
COMMIT;
EOS
         } | POD=$pod session -At -v day="$day" | { IFS= read -r c && gzip -c > "$part" && printf '%s' "$c"; } ) \
        || { rm -f "$part"; echo "  $day: export from $pod failed"; return 1; }
    lines=$(gzip -dc "$part" | wc -l | tr -d ' ') || lines=?
    if ! [[ "$n" =~ ^[0-9]+$ ]] || [ "$lines" != "$n" ]; then
        rm -f "$part"
        echo "  $day: $lines lines in the file, '$n' rows in the database – not recorded"
        return 1
    fi
    bytes=$(wc -c < "$part" | tr -d ' ') && sum=$(sha256 "$part") && [ ${#sum} = 64 ] \
        || { rm -f "$part"; echo "  $day: could not checksum the file"; return 1; }
    if [ -f "$f" ]; then
        mv -f "$f" "$f.prev" || { rm -f "$part"; echo "  $day: could not keep the previous file"; return 1; }
    fi
    mv -f "$part" "$f" || { echo "  $day: could not rename the file"; return 1; }
    manifest_put "$day" "$n" "$bytes" "$sum" || { echo "  $day: could not update $MANIFEST"; return 1; }
    printf '  %s  %12d rows  %10s  (%s)\n' "$day" "$n" "$(hsize "$bytes")" "$pod"
}

# A day from the replica that fails (e.g. a recovery conflict) is read again
# from the primary.
export_days() {
    local day
    for day in "$@"; do
        export_day "$day" "$SOURCE" && continue
        [ "$SOURCE" != "$PRIMARY" ] && export_day "$day" "$PRIMARY" && continue
        die "export of $day failed (see above) – run export again, it resumes."
    done
}

manifest_summary() {
    log "Export in $DIR"
    if [ ! -f "$MANIFEST" ]; then echo "  no manifest yet"; return 0; fi
    awk -F'\t' '{ n++; r += $2; b += $3; if (!f) f = $1; l = $1 }
        END { printf "  %d days (%s to %s), %d rows, %.1f MB gzipped (%.1f bytes/row)\n", n, f, l, r, b / 1048576, (r ? b / r : 0) }' "$MANIFEST"
    if ! is_hypertable attributes; then
        local first last days missing
        first=$(q "SELECT min(ts)::date FROM attributes")
        last=$(q "SELECT '$(horizon)'::date - 1")
        days=$(days_between "$first" "$last") || return 0
        missing=$(comm -23 <(printf '%s\n' "$days" | grep . | LC_ALL=C sort) <(manifest_days | LC_ALL=C sort) | grep -c . || true)
        echo "  finished days of attributes not exported yet: $missing (checksums and counts are checked by export and swap-lowdisk)"
    fi
}

# The chart's bootstrap (the init container runs the same file) without its
# own BEGIN/COMMIT: swap-lowdisk runs it inside the swap transaction.
bootstrap_sql() {
    [ -f "$TROE_SCHEMA" ] || die "$TROE_SCHEMA not found – run the script from the repository or set TROE_SCHEMA."
    [ "$(tr -d '\r' < "$TROE_SCHEMA" | grep -cx 'BEGIN;')" = 1 ] \
        && [ "$(tr -d '\r' < "$TROE_SCHEMA" | grep -cx 'COMMIT;')" = 1 ] \
        || die "$TROE_SCHEMA: expected exactly one line BEGIN; and one line COMMIT;."
    tr -d '\r' < "$TROE_SCHEMA" | sed -e '/^BEGIN;$/d' -e '/^COMMIT;$/d'
}

plain_table_checks() {
    is_hypertable attributes && die "attributes is already the hypertable."
    lowdisk && die "A low-disk swap is recorded although attributes is a plain table – check status; do not export over the files."
    exists attributes_ts_idx \
        || die "Index attributes_ts_idx is missing – the export reads day ranges through it. troe-retention creates it at night, or: CREATE INDEX CONCURRENTLY attributes_ts_idx ON attributes (ts);"
    local version
    version=$(q "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'")
    [ -n "$version" ] || die "Extension timescaledb is missing in $DB."
    [ "$(q "SELECT string_to_array(split_part('$version', '-', 1), '.')::int[] >= '{2,13}'")" = t ] \
        || die "TimescaleDB $version is too old (2.13 or newer needed for by_range)."
}

export_history() {
    need_dir
    plain_table_checks
    local h last first counts day rows todo=() skipped=0 todo_rows=0 bpr need local_free
    h=$(horizon)
    last=$(q "SELECT '$h'::date - 1")
    confirm "Export the finished days of attributes up to $last into $DIR (the platform keeps running)?"
    lock_dir
    [ ! -f "$MANIFEST" ] || manifest_check
    pick_source
    log "Export up to $last into $DIR – reading from $SOURCE$([ "$SOURCE" = "$PRIMARY" ] && echo ' (primary)')"
    # Days of the manifest before the first row (retention since) are
    # checked as well: they are exported again, empty.
    first=$(POD=$SOURCE q "SELECT min(ts)::date FROM attributes")
    first=$( { [ -z "$first" ] || echo "$first"; manifest_days; } | LC_ALL=C sort | head -n 1)
    if [ -n "$first" ]; then
        check_span "$first" "$last"
        local t0=$SECONDS
        counts=$(day_counts "$first" "$last" "$SOURCE") \
            || { [ "$SOURCE" != "$PRIMARY" ] && SOURCE=$PRIMARY && counts=$(day_counts "$first" "$last" "$PRIMARY"); } \
            || die "Could not count the rows per day."
        # The same count runs in the swap transaction, during the downtime.
        echo "  rows of every day counted in $((SECONDS - t0)) s (swap-lowdisk repeats this count during the downtime, within STATEMENT_TIMEOUT=$STATEMENT_TIMEOUT)"
    fi
    # A day is exported unless its file is intact and its rows are unchanged.
    while read -r day rows; do
        [ -n "$day" ] || continue
        if [ "$(manifest_line "$day" | cut -f2)" = "$rows" ] && file_ok "$day"; then
            skipped=$((skipped + 1))
        else
            todo+=("$day")
            todo_rows=$((todo_rows + rows))
        fi
    done <<<"${counts:-}"
    bpr=$(bytes_per_row)
    need=$(( todo_rows * bpr * 11 / 10 + 67108864 ))
    local_free=$(df -Pk "$DIR" 2>/dev/null | awk 'NR == 2 && $4 ~ /^[0-9]+$/ { printf "%.0f", $4 * 1024 }')
    echo "  $skipped day(s) already exported and unchanged, ${#todo[@]} to export: $todo_rows rows, about $(hsize $((todo_rows * bpr))) at $bpr bytes/row; $(hsize "${local_free:-0}") free in $DIR"
    if [[ "$local_free" =~ ^[0-9]+$ ]]; then
        [ "$local_free" -ge "$need" ] || die "Not enough local disk in $DIR: about $(hsize "$need") needed, $(hsize "$local_free") free."
    else
        echo "  WARNING: could not read the free space of $DIR – watch it."
    fi
    export_days ${todo[@]+"${todo[@]}"}
    manifest_summary
    echo; echo "Repeat export right before swap-lowdisk – the swap then exports only the last day(s)."
}

# Loads the file of one day (the largest) into temporary tables and runs the
# dedup on it – before the downtime, so that a type, TEMP_FILE_LIMIT or
# STATEMENT_TIMEOUT problem shows up while attributes still exists.
dry_run_day() {
    local day=$1 rows=$2 out t0=$SECONDS
    out=$( { printf '%s\n' "$SQL_COPY_DAY_FN"
             cat <<EOS
CREATE TEMP TABLE udp_dry_src (LIKE attributes INCLUDING DEFAULTS);
CREATE TEMP TABLE udp_dry_dst (LIKE attributes INCLUDING DEFAULTS);
COPY udp_dry_src ($COLS) FROM STDIN;
EOS
             gzip -dc "$(day_file "$day")"
             printf '%s\n' '\.'
             cat <<'EOS'
SELECT source_rows || ' ' || kept_rows FROM pg_temp.udp_copy_day('udp_dry_src', 'udp_dry_dst', :'day', false, true);
EOS
           } | session -At -v day="$day") \
        || die "Dry run of $day failed (see above) – attributes is untouched. Fix the cause (e.g. TEMP_FILE_LIMIT, STATEMENT_TIMEOUT) before the swap."
    out=$(printf '%s\n' "$out" | tail -n 1)
    [ "${out% *}" = "$rows" ] || die "Dry run of $day: ${out% *} rows loaded, $rows in the manifest."
    echo "  $day ($rows rows, the largest day) loads and dedups in $((SECONDS - t0)) s ($out)"
}

# What a failed swap left behind – read from the database, not assumed.
swap_outcome() {
    local ht running
    running=$(q "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
                  AND application_name = '$APP' AND pid <> pg_backend_pid()" 2>/dev/null) || running=?
    ht=$(q "SELECT count(*) FROM timescaledb_information.hypertables
            WHERE hypertable_schema = current_schema() AND hypertable_name = 'attributes'" 2>/dev/null) || ht=?
    if [ "$running" != 0 ]; then
        echo "OUTCOME UNKNOWN: a session of this script is still at work in the database (application_name $APP)."
        echo "  Do NOT run export and keep $DIR. Wait for it to end, then run: $0 status --dir $DIR"
    elif [ "$ht" = 1 ]; then
        echo "The swap WAS committed: attributes is the new hypertable. Keep $DIR – continue with: $0 import --dir $DIR"
    elif [ "$ht" = 0 ]; then
        echo "Nothing was swapped: attributes is the old table, unchanged."
    else
        echo "OUTCOME UNKNOWN: the state could not be read. Do NOT run export and keep $DIR; first run: $0 status --dir $DIR"
    fi
    echo "Restoring the writers."
}

swap_lowdisk() {
    need_dir
    plain_table_checks
    exists attributes_new && die "attributes_new exists (in-database backfill) – low-disk mode does not use it. Drop it first (DROP TABLE attributes_new) or continue with cutover."
    exists attributes_old && die "attributes_old exists – finish the earlier migration first (finalize or rollback)."
    manifest_check
    local bootstrap h0 first mfirst maxday last days missing day rows sum counts changed grants deps largest err t0 need
    bootstrap=$(bootstrap_sql)
    h0=$(horizon)
    first=$(q "SELECT min(ts)::date FROM attributes")
    maxday=$(q "SELECT max(ts)::date FROM attributes")
    [ -z "$maxday" ] || [ "$(q "SELECT '$maxday'::date <= (now() AT TIME ZONE 'utc')::date + 1")" = t ] \
        || die "attributes has rows stamped $maxday – in the future. Fix or delete them first (the swap exports every day up to the last row)."
    deps=$(q "SELECT string_agg(DISTINCT pg_describe_object(classid, objid, objsubid), ', ') FROM pg_depend
              WHERE refclassid = 'pg_class'::regclass AND refobjid = 'attributes'::regclass AND deptype = 'n'")
    [ -z "$deps" ] || die "Objects depend on attributes and would block the DROP: $deps – remove them first (and recreate them after the swap)."
    log "Checking the export files of the finished days (up to $(q "SELECT '$h0'::date - 1"))"
    days=$(days_between "$first" "$(q "SELECT '$h0'::date - 1")") || die "Could not list the days of attributes."
    [ -z "$first" ] || [ "$first" = "$h0" ] || [ -n "$days" ] || die "Could not list the days of attributes."
    missing=
    for day in $days; do
        file_ok "$day" || missing="$missing $day"
    done
    [ -z "$missing" ] || die "Days without an intact export file:$missing – run export first."
    echo "  every finished day has its file"
    grants=$(q "SELECT string_agg(a.privilege_type || ' to ' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ', ')
                FROM pg_class c, LATERAL aclexplode(c.relacl) a WHERE c.oid = 'attributes'::regclass AND a.grantee <> c.relowner")
    [ -z "$grants" ] || echo "  grants carried over to the new table: $grants"
    confirm "The TRoE writers ($WRITERS) go down; attributes is DROPPED and created again, empty, as a hypertable. From then on the files in $DIR are the only copy of the history until import has finished – keep them. Continue?"
    lock_dir
    # Before the downtime: the bootstrap then finds the index and does not build it.
    entities_index
    [ "$(q "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('entities_id_ts_idx')")" = t ] \
        || die "entities_id_ts_idx is missing or invalid – create it first: CREATE INDEX CONCURRENTLY entities_id_ts_idx ON entities (id, ts);"
    # The count of the swap transaction, once now while the platform runs: a
    # day changed since the export (retention) stops the step before the downtime.
    log "Checking every exported day against attributes (the platform is running)"
    mfirst=$(manifest_days | head -n 1)
    t0=$SECONDS
    counts=$(day_counts "$mfirst" "$(q "SELECT '$h0'::date - 1")" "$PRIMARY") || die "Could not count the rows per day."
    changed=
    while read -r day rows; do
        [ -n "$day" ] || continue
        [ "$(manifest_line "$day" | cut -f2)" = "$rows" ] || changed="$changed $day"
    done <<<"$counts"
    [ -z "$changed" ] || die "Days changed since their export:$changed – run export again, then swap-lowdisk."
    echo "  every day as exported; counted in $((SECONDS - t0)) s – the swap transaction repeats this count during the downtime"
    largest=$(LC_ALL=C sort -t "$(printf '\t')" -k2,2n "$MANIFEST" | tail -n 1)
    if [ -n "$largest" ]; then
        log "Dry run: the largest day into temporary tables"
        read_free
        need=$(q "SELECT (2 * $(printf '%s' "$largest" | cut -f2)::numeric * pg_table_size('attributes')
                          / greatest((SELECT reltuples FROM pg_class WHERE oid = 'attributes'::regclass), 1))::bigint")
        [ "$MIN_FREE" -ge "$need" ] \
            || die "Not enough free space for the dry run of the largest day: $(hsize "$need") needed, $(hsize "$MIN_FREE") free."
        dry_run_day "$(printf '%s' "$largest" | cut -f1)" "$(printf '%s' "$largest" | cut -f2)"
    fi
    writers_back_on_exit swap-lowdisk
    scale_down_writers
    # From here on attributes no longer changes. The last day(s) are exported
    # now, from the primary; the bounds are taken after the writers stopped.
    last=$(q "SELECT greatest((now() AT TIME ZONE 'utc')::date, (SELECT max(ts)::date FROM attributes))")
    log "Exporting $h0 to $last (the writers are down)"
    SOURCE=$PRIMARY
    days=$(days_between "$h0" "$last") || die "Could not list the days from $h0 to $last."
    [ -n "$days" ] || die "Could not list the days from $h0 to $last."
    # shellcheck disable=SC2086
    export_days $days
    log "Checking the manifest and every file once more"
    manifest_check
    missing=
    for day in $(manifest_days); do
        file_ok "$day" || missing="$missing $day"
    done
    [ -z "$missing" ] || die "Days without an intact export file:$missing – nothing was swapped."
    sum=$(sha256 "$MANIFEST")
    [ ${#sum} = 64 ] || die "Could not checksum $MANIFEST."
    log "Verifying every day against the manifest, swapping (one transaction)"
    # SHARE mode holds off every write but lets Mintaka read until the DROP.
    # Each day is counted through attributes_ts_idx – within the
    # statement_timeout of the session (DEPLOY.md §10c).
    err=$(mktemp)
    if ! { printf '%s\n' "$SQL_BOOKKEEPING"
      cat <<'EOS'
BEGIN;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('udp-troe-migration')) \gset
LOCK TABLE attributes IN SHARE MODE;
SELECT set_config('udp.cols', :'cols', true) AS c \gset
CREATE TEMP TABLE udp_manifest (day date PRIMARY KEY, rows bigint NOT NULL) ON COMMIT DROP;
COPY udp_manifest FROM STDIN;
EOS
      cut -f1,2 "$MANIFEST"
      printf '%s\n' '\.'
      cat <<'EOS'
-- The old table as it is: its columns (the export wrote exactly these) and
-- its grants (the owner's own are implicit).
CREATE TEMP TABLE udp_old_cols ON COMMIT DROP AS
  SELECT attname::text AS name, format_type(atttypid, atttypmod) AS type, attnotnull AS not_null
  FROM pg_attribute WHERE attrelid = 'attributes'::regclass AND attnum > 0 AND NOT attisdropped;
CREATE TEMP TABLE udp_old_acl ON COMMIT DROP AS
  SELECT a.privilege_type, a.grantee, a.is_grantable
  FROM pg_class c, LATERAL aclexplode(c.relacl) a
  WHERE c.oid = 'attributes'::regclass AND a.grantee <> c.relowner;
DO $$
DECLARE
  first_day date;
  last_day date;
  n_days int;
  bad text;
  outside bigint;
BEGIN
  IF (SELECT array_agg(name ORDER BY name) FROM udp_old_cols)
     IS DISTINCT FROM (SELECT array_agg(c ORDER BY c) FROM unnest(string_to_array(current_setting('udp.cols'), ',')) c) THEN
    RAISE EXCEPTION 'the columns of attributes (%) are not the ones the export wrote (%)',
      (SELECT string_agg(name, ',' ORDER BY name) FROM udp_old_cols), current_setting('udp.cols');
  END IF;
  SELECT min(day), max(day), count(*) INTO first_day, last_day, n_days FROM udp_manifest;
  IF n_days = 0 THEN
    IF EXISTS (SELECT 1 FROM attributes) THEN
      RAISE EXCEPTION 'the manifest is empty';
    END IF;
  ELSIF n_days <> last_day - first_day + 1 THEN
    RAISE EXCEPTION 'the manifest has gaps between % and %', first_day, last_day;
  END IF;
  SELECT string_agg(format('%s (%s rows, %s exported)', day, n, rows), ', ' ORDER BY day) INTO bad
    FROM (SELECT m.day, m.rows,
                 (SELECT count(*) FROM attributes a WHERE a.ts >= m.day AND a.ts < m.day + 1) AS n
          FROM udp_manifest m) x
   WHERE n <> rows;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'attributes changed since the export: % – run export again', bad;
  END IF;
  SELECT count(*) INTO outside FROM attributes WHERE ts < first_day OR ts >= last_day + 1;
  IF outside > 0 THEN
    RAISE EXCEPTION '% rows outside the exported days % to %', outside, first_day, last_day;
  END IF;
END
$$;
-- Days of an abandoned in-database backfill mean nothing any more.
DELETE FROM udp_troe_migration;
INSERT INTO udp_troe_migration_state (key, value)
  SELECT k, v FROM (SELECT min(day) AS f, max(day) AS l, coalesce(sum(rows), 0) AS r FROM udp_manifest) m,
  LATERAL (VALUES ('mode', 'lowdisk'),
                  ('cutover_ts', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS.US')),
                  -- the newest exported row: rows after it were written live
                  ('lowdisk_max_ts', (SELECT to_char(max(ts), 'YYYY-MM-DD HH24:MI:SS.US') FROM attributes)),
                  ('lowdisk_first_day', m.f::text),
                  ('lowdisk_last_day', m.l::text),
                  ('lowdisk_rows', m.r::text),
                  -- heap and TOAST per row: what a day needs in staging
                  ('lowdisk_row_bytes', (pg_table_size('attributes') / greatest(m.r, 1))::bigint::text),
                  ('lowdisk_manifest_sha256', :'sha')) s(k, v)
  WHERE v IS NOT NULL
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
DROP TABLE attributes;
EOS
      printf '%s\n' "$bootstrap"
      cat <<'EOS'
DO $$
DECLARE
  diff text;
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables
                 WHERE hypertable_schema = current_schema() AND hypertable_name = 'attributes') THEN
    RAISE EXCEPTION 'the bootstrap did not create the hypertable attributes';
  END IF;
  -- The files must load into the new table: same columns, types, NOT NULL.
  WITH new_cols AS (
    SELECT attname::text AS name, format_type(atttypid, atttypmod) AS type, attnotnull AS not_null
    FROM pg_attribute WHERE attrelid = 'attributes'::regclass AND attnum > 0 AND NOT attisdropped)
  SELECT string_agg(format('%s %s%s', name, type, CASE WHEN not_null THEN ' not null' ELSE '' END), ', ') INTO diff
  FROM ((SELECT * FROM udp_old_cols EXCEPT SELECT * FROM new_cols)
        UNION ALL (SELECT * FROM new_cols EXCEPT SELECT * FROM udp_old_cols)) d;
  IF diff IS NOT NULL THEN
    RAISE EXCEPTION 'the new attributes differs from the old one in: %', diff;
  END IF;
  FOR r IN SELECT * FROM udp_old_acl LOOP
    EXECUTE format('GRANT %s ON attributes TO %s%s', r.privilege_type,
                   CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r.grantee)) END,
                   CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END
$$;
COMMIT;
EOS
    } | session -v sha="$sum" -v cols="$(printf '%s' "$COLS" | tr -d ' \n')" 2>"$err"; then
        cat "$err" >&2
        if grep -q 'lock timeout' "$err"; then
            rm -f "$err"
            die "Could not lock attributes within 30 s – another session holds it (an anti-wraparound autovacuum, a dump, a long query; see pg_stat_activity). Run swap-lowdisk again once it is gone."
        fi
        rm -f "$err"
        die "The swap transaction failed (see above)."
    fi
    cat "$err" >&2
    rm -f "$err"
    SWAPPED=1
    resume_writers || die "The swap is done, but not every writer came back (see above). Then continue with: $0 import --dir $DIR"
    BACK_STEP=
    entities_index
    report_lowdisk
    cat <<EOT

Done. attributes is the empty hypertable; the writers are back. The history
is only in $DIR now – keep the files (on two media) until import has finished
and status shows every day. Next, while the platform runs:
  $0 import --dir $DIR
Mintaka shows the history only up to the swap until then.
EOT
}

# Loads one day from its file into the staging table, checks it against the
# manifest, and copies it into attributes in one transaction together with
# its bookkeeping row – the same function and dedup as backfill.
import_day() {
    local day=$1 rows=$2 dedup=$3 out
    out=$( { printf '%s\n' "$SQL_COPY_DAY_FN"
             cat <<EOS
DO \$\$
BEGIN
  IF NOT pg_try_advisory_lock(hashtext('udp-troe-migration')) THEN
    RAISE EXCEPTION 'another step of this migration is running – run one at a time';
  END IF;
END
\$\$;
CREATE UNLOGGED TABLE IF NOT EXISTS $STAGING (LIKE attributes INCLUDING DEFAULTS);
TRUNCATE $STAGING;
COPY $STAGING ($COLS) FROM STDIN;
EOS
             gzip -dc "$(day_file "$day")"
             printf '%s\n' '\.'
             cat <<'EOS'
SELECT set_config('udp.day', :'day', false) AS d, set_config('udp.rows', :'rows', false) AS r \gset
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM udp_troe_staging;
  IF n <> current_setting('udp.rows')::bigint THEN
    RAISE EXCEPTION 'day %: % rows loaded, % in the manifest', current_setting('udp.day'), n, current_setting('udp.rows');
  END IF;
END
$$;
BEGIN ISOLATION LEVEL REPEATABLE READ;
INSERT INTO udp_troe_migration (day, source_rows, kept_rows)
  SELECT :'day', source_rows, kept_rows
  FROM pg_temp.udp_copy_day('udp_troe_staging', 'attributes', :'day', false, :'dedup');
DO $$
BEGIN
  IF (SELECT source_rows FROM udp_troe_migration WHERE day = current_setting('udp.day')::date)
     <> current_setting('udp.rows')::bigint THEN
    RAISE EXCEPTION 'day %: the file holds rows of other days', current_setting('udp.day');
  END IF;
END
$$;
SELECT source_rows || ' ' || kept_rows FROM udp_troe_migration WHERE day = :'day';
COMMIT;
TRUNCATE udp_troe_staging;
EOS
           } | session -At -v day="$day" -v rows="$rows" -v dedup="$dedup") || return 1
    print_day "$day" "$(printf '%s\n' "$out" | tail -n 1)"
}

import_history() {
    need_dir
    lowdisk || die "No low-disk swap recorded – import loads the files into the hypertable that swap-lowdisk created."
    is_hypertable attributes || die "attributes is not a hypertable."
    manifest_check
    [ "$(sha256 "$MANIFEST")" = "$(state lowdisk_manifest_sha256)" ] \
        || die "$MANIFEST is not the manifest swap-lowdisk verified (checksum differs) – wrong directory, or it was changed."
    local dedup=true day rows need todo=() refused= row_bytes margin imported
    [ "${NO_DEDUP:-}" = 1 ] && dedup=false
    # A day is imported iff its bookkeeping row exists.
    imported=$(q "SELECT to_char(day, 'YYYY-MM-DD') FROM udp_troe_migration") || die "Could not read the bookkeeping."
    for day in $(comm -23 <(manifest_days | LC_ALL=C sort) <(printf '%s\n' "$imported" | grep . | LC_ALL=C sort) \
                 | LC_ALL=C sort -r); do
        todo+=("$day")
    done
    row_bytes=$(state lowdisk_row_bytes)
    # A margin for WAL; the temp files of the dedup sort are added per day.
    margin=$(q "SELECT pg_size_bytes('${IMPORT_MARGIN:-$(q "SHOW max_wal_size")}')")
    confirm "Import ${#todo[@]} day(s) from $DIR into attributes, newest first, $([ "$dedup" = true ] && echo 'dropping unchanged repetitions' || echo 'every row (no dedup)') – the platform keeps running?"
    log "Import: ${#todo[@]} day(s) to load"
    for day in ${todo[@]+"${todo[@]}"}; do
        if ! file_ok "$day"; then
            echo "  $day: REFUSED – file missing or its checksum differs from the manifest"
            refused="$refused $day"
            continue
        fi
        rows=$(manifest_line "$day" | cut -f2)
        # Staging, the insert with its indexes, the temp files of the sort
        # (at most the day, at most TEMP_FILE_LIMIT) and the WAL margin.
        need=$(q "SELECT ($rows::numeric * $row_bytes * (1 + $SPACE_FACTOR))::bigint
                         + least($rows::numeric * $row_bytes, pg_size_bytes('$TEMP_FILE_LIMIT'))::bigint + $margin")
        read_free
        [ "$MIN_FREE" -ge "$need" ] \
            || die "Not enough free space for $day: $(hsize "$need") needed (staging, insert, temp files, WAL margin $(hsize "$margin")), $(hsize "$MIN_FREE") free on the fullest instance. Free or add space, then run import again – it resumes."
        import_day "$day" "$rows" "$dedup" \
            || die "day $day failed (see above) – nothing of it was kept; fix the cause and run import again, it resumes."
    done
    if [ -n "$refused" ]; then
        report_lowdisk
        die "Days refused:$refused – restore their files (second copy) and run import again."
    fi
    session <<EOS
DROP TABLE IF EXISTS $STAGING;
SET statement_timeout = 0;
ANALYZE attributes;
EOS
    report_lowdisk
    echo; echo "Every day is imported. Keep the export files until you have checked the history (Mintaka); finalize --drop-old then drops the bookkeeping."
}

report_lowdisk() {
    log "Low-disk mode"
    psql_raw -c "SELECT key, value FROM udp_troe_migration_state ORDER BY key"
    psql_raw -c "SELECT count(*) AS days_imported,
                        (SELECT value::date - (SELECT value::date FROM udp_troe_migration_state WHERE key = 'lowdisk_first_day') + 1
                         FROM udp_troe_migration_state WHERE key = 'lowdisk_last_day') AS days_total,
                        min(day) AS oldest_imported, sum(source_rows) AS rows_in_files, sum(kept_rows) AS kept_rows,
                        round(100 * (1 - sum(kept_rows)::numeric / nullif(sum(source_rows), 0)), 1) AS dropped_pct
                 FROM udp_troe_migration"
    psql_raw -c "SELECT 'attributes' AS table, pg_size_pretty(hypertable_size('attributes')) AS size
                 UNION ALL
                 SELECT '$STAGING', pg_size_pretty(pg_total_relation_size(to_regclass('$STAGING')))
                 WHERE to_regclass('$STAGING') IS NOT NULL"
}

finalize_lowdisk() {
    local left
    left=$(q "SELECT (SELECT value::date FROM udp_troe_migration_state WHERE key = 'lowdisk_last_day')
                   - (SELECT value::date FROM udp_troe_migration_state WHERE key = 'lowdisk_first_day') + 1
                   - (SELECT count(*) FROM udp_troe_migration)")
    [ "${left:-1}" = 0 ] \
        || die "Low-disk mode: there is no attributes_old to drop, and import has ${left:-?} day(s) left – run import --dir DIR first."
    [ "${DROP_OLD:-}" = 1 ] \
        || die "Low-disk mode: there is no attributes_old; finalize only drops the bookkeeping (udp_troe_migration*) – afterwards import can no longer resume. Confirm with: $0 finalize --drop-old"
    report_lowdisk
    confirm "Drop the migration bookkeeping? Keep the export files as long as you want a way back to the raw history."
    session <<EOS
DROP TABLE IF EXISTS $STAGING;
DROP TABLE IF EXISTS udp_troe_migration, udp_troe_migration_state;
EOS
    log "Bookkeeping dropped – the migration is complete."
}

status() {
    if lowdisk; then
        report_lowdisk
    elif exists udp_troe_migration; then
        report
    elif [ -z "$DIR" ]; then
        die "No backfill, no swap yet (for the export: status --dir DIR)."
    fi
    if [ -n "$DIR" ]; then need_dir; manifest_summary; fi
}

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
        --dir) [ $# -ge 2 ] || die "--dir needs a directory"; DIR=$2; shift 2 ;;
        --dir=*) DIR=${1#--dir=}; shift ;;
        --no-dedup) NO_DEDUP=1; shift ;;
        --drop-old) DROP_OLD=1; shift ;;
        *) die "unknown argument: $1" ;;
        esac
    done
}

# ---------------------------------------------------------------- commands
CMD=${1:-}
[ $# = 0 ] || shift
parse_args "$@"
case "$CMD" in
preflight)    init; preflight ;;
backfill)     init; backfill ;;
status)       init; status ;;
cutover)      init; cutover ;;
rollback)     init; rollback ;;
finalize)     init; finalize ;;
export)       init; export_history ;;
swap-lowdisk) init; swap_lowdisk ;;
import)       init; import_history ;;
resume-writers) resume_writers ;;
*)
    # The header between the two rulers.
    sed -n '/^# =====/,/^# =====/p' "$0" | sed '1d;$d;s/^# \{0,1\}//'
    exit 1
    ;;
esac
