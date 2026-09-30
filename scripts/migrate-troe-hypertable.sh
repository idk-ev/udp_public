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
#      (timescale.persistence.size; the copy needs room next to the old table).
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
# DB (default orion), YES=1 skips the confirmations.
# Limits per session: STATEMENT_TIMEOUT (default 30min), TEMP_FILE_LIMIT
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

# Plain psql in the primary pod: local socket, superuser postgres.
psql_raw() { k exec -i "$PRIMARY" -c postgres -- psql -v ON_ERROR_STOP=1 -X -q -d "$DB" "$@"; }
q() { psql_raw -Atc "$1"; }

# A bounded session: the SQL on stdin runs after the limits and SET ROLE.
# Extra arguments go to psql (e.g. -v day=2026-01-01).
session() {
    { cat <<EOS
SET statement_timeout = '$STATEMENT_TIMEOUT';
SET temp_file_limit = '$TEMP_FILE_LIMIT';
SET work_mem = '$WORK_MEM';
SET lock_timeout = '5s';
SET synchronous_commit = local;
SET client_min_messages = warning;
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
}

# From the scale-down on, any exit – a failed step included – brings the
# writers back; a successful step clears the trap after resuming them itself.
writers_back_on_exit() {
    BACK_STEP=$1
    trap 'status=$?; [ "$status" = 0 ] || echo "Step failed – nothing was swapped, restoring the writers."
          [ "$BACK_STEP" != cutover ] || forget_provisional; resume_writers' EXIT
}

# The days a failed cutover copied are stale as soon as the writers are back.
# (A later step would copy them again anyway: they stay provisional.)
forget_provisional() {
    q "DELETE FROM udp_troe_migration WHERE provisional" >/dev/null \
        || echo "  WARNING: could not clear the provisional days – they are copied again by the next step anyway."
}

resume_writers() {
    log "Restoring the TRoE writers"
    local d n list
    list=$(k get deploy -l "app in ($WRITERS),app.kubernetes.io/instance=$RELEASE" -o name)
    for d in $list; do
        n=$(ann "$d" "$ANN_REPLICAS")
        [ -n "$n" ] || continue
        [ "$(k get "$d" -o jsonpath='{.spec.replicas}')" -ge "$n" ] || k scale "$d" --replicas="$n" >/dev/null
        k annotate "$d" "$ANN_REPLICAS-" >/dev/null
        echo "  $d: $n"
    done
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
# it; returns the rows of the day in src and the rows kept. Idempotent: the
# day is emptied in dst first. A temporary function – nothing stays behind.
SQL_COPY_DAY_FN="
CREATE FUNCTION pg_temp.udp_copy_day(src regclass, dst regclass, d date,
                                      OUT source_rows bigint, OUT kept_rows bigint)
LANGUAGE plpgsql AS \$f\$
DECLARE
  lo timestamp := d;
  hi timestamp := d + 1;
  copied bigint;
BEGIN
  EXECUTE format('DELETE FROM %s WHERE ts >= \$1 AND ts < \$2', dst) USING lo, hi;
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
             (r.rn = 1
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
  \$q\$, src, dst) USING lo, hi INTO kept_rows;
  EXECUTE format('SELECT count(*) FROM %s WHERE ts >= \$1 AND ts < \$2', dst) USING lo, hi INTO copied;
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
  FROM pg_temp.udp_copy_day('attributes', 'attributes_new', :'day')
  ON CONFLICT (day) DO UPDATE SET source_rows = EXCLUDED.source_rows,
    kept_rows = EXCLUDED.kept_rows, provisional = EXCLUDED.provisional, copied_at = now();
SELECT source_rows || ' ' || kept_rows FROM udp_troe_migration WHERE day = :'day';
COMMIT;
EOS
            } | session -At -v day="$day" -v provisional="${PROVISIONAL:-false}") \
            || die "day $day failed (see above) – nothing of it was kept; fix the cause and run the step again."
        out=$(printf '%s\n' "$out" | tail -n 1)
        awk -v d="$day" -v s="${out% *}" -v k="${out#* }" 'BEGIN {
            printf "  %s  %12d rows  %12d kept  %5.1f %% dropped\n", d, s, k, (s > 0 ? 100 * (s - k) / s : 0) }'
    done
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
        if exists attributes_old; then
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
    local datadir pods
    datadir=$(q "SHOW data_directory")
    pods=$(k get pod -l "cnpg.io/cluster=$CLUSTER" -o jsonpath='{.items[*].metadata.name}')
    for pod in $pods; do
        free=$(k exec "$pod" -c postgres -- df -Pk "$datadir" | awk 'NR == 2 { print $4 * 1024 }')
        echo "  $pod: $(q "SELECT pg_size_pretty($free::bigint)") free"
        if [ -z "$min_free" ] || [ "$free" -lt "$min_free" ]; then min_free=$free; fi
    done
    [ -n "$min_free" ] || die "Could not read the free space of the instances."
    if [ "$min_free" -lt "$need" ]; then
        die "Not enough free space on the database volume: $(q "SELECT pg_size_pretty($need::bigint)") needed, $(q "SELECT pg_size_pretty($min_free::bigint)") free on the fullest instance. Grow the volume first (timescale.persistence.size, helm/udp/DEPLOY.md §10c) – the old table stays until finalize."
    fi
    echo "  space: ok"

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
    trap - EXIT
    resume_writers
    log "Index entities_id_ts_idx (CONCURRENTLY, the platform is running)"
    # An invalid index is what an interrupted CREATE INDEX CONCURRENTLY leaves.
    if [ "$(q "SELECT NOT indisvalid FROM pg_index WHERE indexrelid = to_regclass('entities_id_ts_idx')")" = t ]; then
        session <<<"DROP INDEX CONCURRENTLY entities_id_ts_idx;" || true
    fi
    session <<'EOS' || echo "  WARNING: could not create entities_id_ts_idx – create it later: CREATE INDEX CONCURRENTLY entities_id_ts_idx ON entities (id, ts);"
SET statement_timeout = 0;
CREATE INDEX CONCURRENTLY IF NOT EXISTS entities_id_ts_idx ON entities (id, ts);
EOS
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
    trap - EXIT
    resume_writers
    report
    echo; echo "attributes is the old plain table again; attributes_new keeps the copy for another cutover."
}

finalize() {
    [ "${1:-}" = --drop-old ] || die "finalize drops attributes_old for good – confirm with: $0 finalize --drop-old"
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

# ---------------------------------------------------------------- commands
case "${1:-}" in
preflight) init; preflight ;;
backfill)  init; backfill ;;
status)    init; exists udp_troe_migration || die "No backfill yet."; report ;;
cutover)   init; cutover ;;
rollback)  init; rollback ;;
finalize)  init; finalize "${2:-}" ;;
*)
    # The header between the two rulers.
    sed -n '/^# =====/,/^# =====/p' "$0" | sed '1d;$d;s/^# \{0,1\}//'
    exit 1
    ;;
esac
