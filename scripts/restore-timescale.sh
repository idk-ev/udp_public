#!/usr/bin/env bash
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# =============================================================================
# Kubernetes: backup status and restore of the CNPG cluster "timescale" from
# its S3 archive (helm/udp: backup.*, timescale.recovery). Runbook:
# helm/udp/DEPLOY.md §10c.
#
#   status               backups, WAL archiving, recovery window
#   backup               take a base backup now (e.g. before a risky change)
#
# Single database (accidental DELETE, broken migration) – the live cluster
# keeps running:
#   side [TIME]          restore the archive into a separate cluster
#                        "timescale-restore" (TIME: RFC 3339, empty = latest)
#   copy-db DB           DOWNTIME: replace database DB in the live cluster with
#                        its state in the side cluster (the old one is kept
#                        renamed as DB_before_restore_<timestamp>)
#   drop-side            delete the side cluster again
#
# Whole cluster (lost or corrupted database) – replaces the live cluster:
#   full [TIME]          DOWNTIME: stops the clients, DELETES the cluster
#                        "timescale" with its volumes and prints the helm
#                        upgrade that recreates it from the archive
#   finish               after that helm upgrade: wait for the cluster, take a
#                        first base backup into the new archive folder, start
#                        the clients again
#   resume               start the clients again (after an aborted run)
#
# copy-db streams pg_dump | pg_restore through this machine (kubectl exec) –
# fine for single databases; a whole cluster goes through "full".
#
# Environment: KUBECONFIG, NAMESPACE (default udp), SERVER (archive folder to
# restore from, default: the one the live cluster writes to), NEW_SERVER
# (full: archive folder from then on), TIMEOUT (default 6h), YES=1 skips the
# confirmations, FORCE=1 lets "full" continue without a recorded backup.
# =============================================================================
set -euo pipefail

NS="${NAMESPACE:-udp}"
CLUSTER=timescale
SIDE=timescale-restore
STORE=timescale-backup
PLUGIN=barman-cloud.cloudnative-pg.io
TIMEOUT="${TIMEOUT:-6h}"
# Every component that holds connections to the database (NetworkPolicy
# matrix, templates/networkpolicy.yaml).
WRITERS="orion-ld,mintaka,frost,keycloak,node-red,ckan"
ANN_REPLICAS=udp.idk-ev.de/replicas-before-restore

k() { kubectl -n "$NS" "$@"; }
log() { printf '\n\033[1m>> %s\033[0m\n' "$*"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
confirm() {
    [ "${YES:-}" = 1 ] && return 0
    read -r -p "$1 [y/N] " a
    [ "$a" = y ] || [ "$a" = Y ] || die "aborted"
}

# Annotation value of an object ("" if unset). go-template instead of jsonpath:
# the keys contain dots.
ann() {
    k get "$1" -o go-template="{{with .metadata.annotations}}{{index . \"$2\"}}{{end}}" 2>/dev/null \
        | sed 's/^<no value>$//'
}

# The value lands in YAML and SQL – accept only what it is meant to be.
check_time() {
    [ -z "${1:-}" ] || [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[T\ ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$ ]] \
        || die "TIME must be RFC 3339, e.g. 2026-09-28T10:15:00Z (got '$1')"
}
check_name() { [[ "$1" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "invalid name '$1'"; }

# Archive folder the live cluster writes to (backup.serverName).
live_server() {
    k get cluster "$CLUSTER" -o jsonpath="{.spec.plugins[?(@.name==\"$PLUGIN\")].parameters.serverName}" 2>/dev/null || true
}
# Archive folder to restore from. A cluster that is still recovering (or whose
# recovery failed) already writes to the NEW folder – its source is the one
# in externalClusters.
source_server() {
    local s="${SERVER:-}" ready
    if [ -z "$s" ]; then
        ready=$(k get cluster "$CLUSTER" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)
        [ "$ready" = True ] || s=$(k get cluster "$CLUSTER" \
            -o jsonpath='{.spec.externalClusters[?(@.name=="backup-archive")].plugin.parameters.serverName}' 2>/dev/null || true)
        s="${s:-$(live_server)}"
    fi
    s="${s:-$CLUSTER}"
    check_name "$s"; echo "$s"
}

# Duration like 90s / 30m / 6h in seconds.
seconds() {
    case "$1" in
        *h) echo $(( ${1%h} * 3600 )) ;;
        *m) echo $(( ${1%m} * 60 )) ;;
        *s) echo "${1%s}" ;;
        *) echo "$1" ;;
    esac
}

primary_pod() {
    local p
    p=$(k get pod -l "cnpg.io/cluster=$1,cnpg.io/instanceRole=primary" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    [ -n "$p" ] || die "no primary pod of cluster $1 found"
    echo "$p"
}

# psql as postgres over the local socket of the primary (peer authentication).
psql_on() { local c=$1; shift; k exec -i "$(primary_pod "$c")" -c postgres -- psql -v ON_ERROR_STOP=1 -X -Atq "$@"; }

require_ready() {
    local ready
    ready=$(k get cluster "$1" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)
    [ "$ready" = True ] || die "cluster $1 is not ready (kubectl -n $NS get cluster $1)."
}

require_store() {
    k get objectstore "$STORE" >/dev/null 2>&1 \
        || die "ObjectStore $STORE not found – configure backup.* in the chart first (DEPLOY.md §2)."
}

# First recoverable point of an archive folder ("" if none is recorded).
first_point() {
    k get objectstore "$STORE" -o go-template="{{with .status.serverRecoveryWindow}}{{with index . \"$1\"}}{{.firstRecoverabilityPoint}}{{end}}{{end}}" 2>/dev/null \
        | sed 's/^<no value>$//'
}

# ---------------------------------------------------------------- writers
scale_down_writers() {
    log "Scaling the database clients to 0 ($WRITERS)"
    local d n list
    list=$(k get deploy -l "app in ($WRITERS)" -o name)
    for d in $list; do
        n=$(k get "$d" -o jsonpath='{.spec.replicas}')
        # Keep the first recorded value if this runs twice.
        [ -n "$(ann "$d" "$ANN_REPLICAS")" ] || k annotate "$d" "$ANN_REPLICAS=$n" >/dev/null
        k scale "$d" --replicas=0 >/dev/null
        echo "  $d: $n -> 0"
    done
    k wait pod -l "app in ($WRITERS)" --for=delete --timeout=5m >/dev/null 2>&1 || true
}

resume_writers() {
    log "Restoring the database clients"
    local d n list
    list=$(k get deploy -l "app in ($WRITERS)" -o name)
    for d in $list; do
        n=$(ann "$d" "$ANN_REPLICAS")
        [ -n "$n" ] || continue
        # helm upgrade may already have restored it – only scale up, never down.
        [ "$(k get "$d" -o jsonpath='{.spec.replicas}')" -ge "$n" ] || k scale "$d" --replicas="$n" >/dev/null
        k annotate "$d" "$ANN_REPLICAS-" >/dev/null
        echo "  $d: $n"
    done
}

# ---------------------------------------------------------------- backups
status() {
    log "Cluster $CLUSTER (archive folder: $(live_server || true))"
    k get cluster "$CLUSTER" -o go-template='{{range .status.conditions}}{{if or (eq .type "Ready") (eq .type "ContinuousArchiving") (eq .type "LastBackupSucceeded")}}  {{.type}}: {{.status}}  {{.message}}{{"\n"}}{{end}}{{end}}'
    log "Recovery window per archive folder (ObjectStore $STORE)"
    k get objectstore "$STORE" -o go-template='{{range $name, $w := .status.serverRecoveryWindow}}  {{$name}}: restorable from {{or $w.firstRecoverabilityPoint "-"}}, last base backup {{or $w.lastSuccessfulBackupTime "-"}}{{"\n"}}{{end}}' \
        || echo "  ObjectStore $STORE not found – backup.* not configured?"
    log "Latest backups"
    k get backup --sort-by=.metadata.creationTimestamp \
        -o custom-columns='NAME:.metadata.name,CLUSTER:.spec.cluster.name,PHASE:.status.phase,STARTED:.status.startedAt,STOPPED:.status.stoppedAt' \
        | { read -r h || true; echo "$h"; tail -n 8; } || true
}

take_backup() {
    require_ready "$CLUSTER"
    local name phase
    name="$CLUSTER-manual-$(date -u +%Y%m%d%H%M%S)"
    log "Base backup $name"
    k apply -f - >/dev/null <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: $name
spec:
  cluster: { name: $CLUSTER }
  method: plugin
  pluginConfiguration:
    name: $PLUGIN
EOF
    local deadline=$(( SECONDS + $(seconds "$TIMEOUT") ))
    while :; do
        phase=$(k get backup "$name" -o jsonpath='{.status.phase}')
        case "$phase" in
            completed) echo "  completed"; return 0 ;;
            failed|walArchivingFailing)
                die "backup $name: $phase – $(k get backup "$name" -o jsonpath='{.status.error}')" ;;
        esac
        [ "$SECONDS" -lt "$deadline" ] || die "backup $name not completed after $TIMEOUT (kubectl -n $NS get backup $name)."
        echo "  ${phase:-pending} ..."
        sleep 15
    done
}

# ---------------------------------------------------------------- side cluster
side() {
    local time=${1:-} server pull params size sc shm affinity resources
    check_time "$time"
    require_store
    k get cluster "$SIDE" >/dev/null 2>&1 && die "cluster $SIDE already exists – '$0 drop-side' first."
    server=$(source_server)
    [ -n "$(first_point "$server")" ] || echo "  WARNING: no recoverable backup recorded for '$server' – the restore will probably fail."
    # Same image, settings and size as the live cluster: WAL replay needs
    # parameters like max_connections at least as high as on the source.
    pull=$(k get cluster "$CLUSTER" -o jsonpath='{.spec.imagePullSecrets}')
    params=$(k get cluster "$CLUSTER" -o jsonpath='{.spec.postgresql.parameters}')
    size=$(k get cluster "$CLUSTER" -o jsonpath='{.spec.storage.size}')
    sc=$(k get cluster "$CLUSTER" -o jsonpath='{.spec.storage.storageClass}')
    shm=$(k get cluster "$CLUSTER" -o jsonpath='{.spec.ephemeralVolumesSizeLimit.shm}')
    affinity=$(k get cluster "$CLUSTER" -o jsonpath='{.spec.affinity}')
    resources=$(k get cluster "$CLUSTER" -o jsonpath='{.spec.resources}')
    # jsonpath prints JSON (valid YAML flow style) or nothing.
    pull=${pull:-[]}; params=${params:-'{}'}; affinity=${affinity:-'{}'}; resources=${resources:-'{}'}
    local target="" storage_class="" shm_limit=""
    [ -z "$time" ] || target=$(printf '      recoveryTarget:\n        targetTime: "%s"' "$time")
    [ -z "$sc" ] || storage_class="    storageClass: $sc"
    [ -z "$shm" ] || shm_limit=$(printf '  ephemeralVolumesSizeLimit:\n    shm: %s' "$shm")
    log "Restoring archive '$server'${time:+ to $time} into cluster $SIDE (${size:-?} volume)"
    k apply -f - >/dev/null <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: $SIDE
  labels:
    app.kubernetes.io/part-of: urbane-datenplattform
    app.kubernetes.io/component: timescale-restore
spec:
  instances: 1
  imageCatalogRef:
    apiGroup: postgresql.cnpg.io
    kind: ImageCatalog
    name: $CLUSTER
    major: 16
  imagePullSecrets: $pull
  enableSuperuserAccess: false
  enablePDB: false
  postgresql:
    shared_preload_libraries: [timescaledb]
    parameters: $params
  # No plugins section: the side cluster never writes into the archive.
  bootstrap:
    recovery:
      source: backup-archive
$target
  externalClusters:
    - name: backup-archive
      plugin:
        name: $PLUGIN
        parameters:
          barmanObjectName: $STORE
          serverName: $server
  storage:
    size: ${size:-50Gi}
$storage_class
  resources: $resources
  affinity: $affinity
$shm_limit
EOF
    log "Waiting for $SIDE (download of the base backup + WAL replay, timeout $TIMEOUT)"
    k wait cluster "$SIDE" --for=condition=Ready --timeout="$TIMEOUT"
    log "Databases in $SIDE"
    psql_on "$SIDE" -d postgres -c "SELECT '  ' || datname || ': ' || pg_size_pretty(pg_database_size(datname))
                                    FROM pg_database WHERE datallowconn AND datname NOT IN ('postgres','template1') ORDER BY 1"
    echo
    echo "Inspect:  kubectl -n $NS exec -it $(primary_pod "$SIDE") -c postgres -- psql -d <db>"
    echo "Take over one database:  $0 copy-db <db>     Afterwards:  $0 drop-side"
}

# State of a running copy-db for the rollback hint on abort.
C_DB="" C_OLD="" C_EXISTS="" C_DST="" C_STAGE=""
copy_db_abort() {
    local sql=""
    [ "$C_STAGE" != created ] || sql="$sql -c 'DROP DATABASE IF EXISTS \"$C_DB\" WITH (FORCE)'"
    if [ -n "$C_EXISTS" ]; then
        case "$C_STAGE" in renamed|created) sql="$sql -c 'ALTER DATABASE \"$C_OLD\" RENAME TO \"$C_DB\"'" ;; esac
        case "$C_STAGE" in locked|renamed|created) sql="$sql -c 'ALTER DATABASE \"$C_DB\" WITH ALLOW_CONNECTIONS true'" ;; esac
    fi
    printf '\n\033[31mcopy-db aborted – the platform is still DOWN. Back to the previous state:\033[0m\n' >&2
    [ -z "$sql" ] || echo "  kubectl -n $NS exec -i $C_DST -c postgres -- psql$sql" >&2
    echo "  $0 resume" >&2
}

copy_db() {
    local db=${1:-} old owner exts e src dst hyper exists settings
    [ -n "$db" ] || die "usage: $0 copy-db <database>"
    check_name "$db"
    require_ready "$SIDE"; require_ready "$CLUSTER"
    src=$(primary_pod "$SIDE"); dst=$(primary_pod "$CLUSTER")
    [ -n "$(psql_on "$SIDE" -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$db'")" ] \
        || die "database $db does not exist in $SIDE"
    if [ -n "$(psql_on "$SIDE" -d "$db" -c "SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'")" ]; then
        hyper=$(psql_on "$SIDE" -d "$db" -c "SELECT count(*) FROM timescaledb_information.hypertables")
        [ "$hyper" = 0 ] || die "$hyper hypertables in $db – this copy does not handle TimescaleDB hypertables."
    fi
    owner=$(psql_on "$SIDE" -d postgres -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$db'")
    exts=$(psql_on "$SIDE" -d "$db" -c "SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY 1")
    # 63 bytes at most – PostgreSQL would silently truncate a longer name.
    old="${db:0:32}_before_restore_$(date -u +%Y%m%d%H%M)"
    exists=$(psql_on "$CLUSTER" -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$db'")
    # pg_dump without --create carries no database-level settings or grants.
    settings=$(psql_on "$SIDE" -d postgres -c "SELECT count(*) FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
                                               WHERE d.datname = '$db'")
    [ "$settings" = 0 ] || echo "  WARNING: ALTER DATABASE/ROLE ... SET for $db are NOT copied – recreate them by hand."
    [ -z "$(psql_on "$SIDE" -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$db' AND datacl IS NOT NULL")" ] \
        || echo "  WARNING: database-level GRANTs of $db are NOT copied – recreate them by hand."
    confirm "The platform will be DOWN until the copy is done. Database $db in the live cluster is ${exists:+renamed to $old and }replaced by its state in $SIDE. Continue?"
    C_DB=$db C_OLD=$old C_EXISTS=$exists C_DST=$dst C_STAGE=down
    trap copy_db_abort EXIT
    scale_down_writers
    if [ -n "$exists" ]; then
        log "Live: $db -> $old"
        # Closed first: nothing may reconnect between terminate and rename.
        psql_on "$CLUSTER" -d postgres -c "ALTER DATABASE \"$db\" WITH ALLOW_CONNECTIONS false" >/dev/null
        C_STAGE=locked
        psql_on "$CLUSTER" -d postgres \
            -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = '$db' AND pid <> pg_backend_pid()" \
            -c "ALTER DATABASE \"$db\" RENAME TO \"$old\"" >/dev/null
        C_STAGE=renamed
        psql_on "$CLUSTER" -d postgres -c "ALTER DATABASE \"$old\" WITH ALLOW_CONNECTIONS true" >/dev/null
    fi
    log "Live: creating $db (owner $owner, extensions: $(echo $exts))"
    psql_on "$CLUSTER" -d postgres -c "CREATE DATABASE \"$db\" OWNER \"$owner\""
    C_STAGE=created
    for e in $exts; do psql_on "$CLUSTER" -d "$db" -c "CREATE EXTENSION IF NOT EXISTS \"$e\" CASCADE"; done
    log "Copying $db ($SIDE -> $CLUSTER)"
    # Same approach as migrate-timescale-cnpg.sh: TimescaleDB's catalog comes
    # from CREATE EXTENSION, not from the dump.
    k exec "$src" -c postgres -- pg_dump -d "$db" -Fc \
            --exclude-schema='_timescaledb*' --exclude-schema='timescaledb_*' \
        | k exec -i "$dst" -c postgres -- pg_restore -d "$db" --exit-on-error
    k exec "$dst" -c postgres -- vacuumdb -d "$db" --analyze-only -q
    trap - EXIT
    resume_writers
    log "Done."
    [ -z "$exists" ] || echo "The previous state is kept as $old – drop it when no longer needed:
  kubectl -n $NS exec -i $dst -c postgres -- psql -c 'DROP DATABASE \"$old\"'"
    echo "Side cluster still running: $0 drop-side"
}

drop_side() {
    k get cluster "$SIDE" >/dev/null 2>&1 || { echo "no cluster $SIDE"; return 0; }
    confirm "Delete the side cluster $SIDE and its volume?"
    k delete cluster "$SIDE" --wait=true
}

# ---------------------------------------------------------------- full restore
full() {
    local time=${1:-} old new base a
    check_time "$time"
    require_store
    old=$(source_server)
    base=${old%-r[0-9]*}
    new=${NEW_SERVER:-$base-r$(date -u +%Y%m%d%H%M)}
    check_name "$new"
    [ "$new" != "$old" ] || die "NEW_SERVER must differ from the source folder $old"
    if [ -z "$(first_point "$old")" ]; then
        [ "${FORCE:-}" = 1 ] || die "no recoverable backup recorded for archive folder '$old' ($0 status). Another folder: SERVER=<name>. FORCE=1 continues anyway."
    fi
    echo "Source archive folder: $old (restorable from $(first_point "$old"))"
    echo "Recovery target:       ${time:-end of the archive (latest state)}"
    echo "New archive folder:    $new"
    echo
    echo "This DELETES the cluster $CLUSTER and its volumes. Everything written after"
    echo "${time:-the last archived WAL segment} is lost."
    if [ "${YES:-}" != 1 ]; then
        read -r -p "Type the cluster name '$CLUSTER' to continue: " a
        [ "$a" = "$CLUSTER" ] || die "aborted"
    fi
    scale_down_writers
    # A healthy cluster still holds up to archive_timeout (5 min) of writes in
    # its current WAL segment – push it into the archive before deleting.
    local ready seg deadline
    ready=$(k get cluster "$CLUSTER" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)
    if [ "$ready" = True ]; then
        log "Archiving the current WAL segment"
        seg=$(psql_on "$CLUSTER" -d postgres -c "SELECT pg_walfile_name(pg_switch_wal())")
        deadline=$(( SECONDS + 300 ))
        until [ -n "$(psql_on "$CLUSTER" -d postgres -c "SELECT 1 FROM pg_stat_archiver
                      WHERE last_archived_wal ~ '^[0-9A-F]{24}\$' AND last_archived_wal >= '$seg'")" ]; do
            if [ "$SECONDS" -ge "$deadline" ]; then
                [ "${FORCE:-}" = 1 ] || die "WAL segment $seg not archived after 5 min – is archiving broken ($0 status)? Nothing deleted; clients back up: $0 resume. FORCE=1 deletes anyway."
                break
            fi
            sleep 5
        done
        echo "  $seg archived"
    fi
    if k get cluster "$CLUSTER" >/dev/null 2>&1; then
        log "Deleting cluster $CLUSTER"
        k delete cluster "$CLUSTER" --wait=true --timeout=10m
    fi
    # The instance volumes follow the cluster through garbage collection – the
    # new instances must not find them again.
    k wait pvc -l "cnpg.io/cluster=$CLUSTER" --for=delete --timeout=10m >/dev/null 2>&1 || true
    log "Now recreate it from the archive. Put these values into your values file (keep backup.serverName for good):"
    cat <<EOF

  backup:
    serverName: $new
  timescale:
    recovery:
      enabled: true
      serverName: $old
      targetTime: "$time"

  helm upgrade <release> <chart> -n $NS -f values-prod.yaml

Then: $0 finish
EOF
}

finish() {
    log "Waiting for cluster $CLUSTER (timeout $TIMEOUT)"
    k wait cluster "$CLUSTER" --for=condition=Ready --timeout="$TIMEOUT"
    # The new archive folder has WAL but no base backup yet – without one it
    # cannot be restored from.
    take_backup
    resume_writers
    log "Done. Set timescale.recovery.enabled back to false in the values (backup.serverName stays $(live_server))."
}

case "${1:-}" in
status) status ;;
backup) take_backup ;;
side) side "${2:-}" ;;
copy-db) copy_db "${2:-}" ;;
drop-side) drop_side ;;
full) full "${2:-}" ;;
finish) finish ;;
resume) resume_writers ;;
*)
    sed -n '6,37p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
