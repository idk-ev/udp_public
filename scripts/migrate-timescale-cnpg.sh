#!/usr/bin/env bash
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# =============================================================================
# Kubernetes: single-instance StatefulSet "timescale" -> CloudNativePG cluster
#
# The chart (templates/timescale.yaml) moves the database through
# timescale.migration.phase; this script does everything between the Helm
# upgrades: freeze the old database, copy it, verify it, switch the Service.
# Full runbook: helm/udp/DEPLOY.md §10a.
#
#   0. helm upgrade ... --set timescale.migration.phase=prepare
#      (old StatefulSet keeps serving, empty CNPG cluster starts next to it)
#   1. migrate-timescale-cnpg.sh wait        CNPG cluster ready?
#      migrate-timescale-cnpg.sh rehearse    optional: copy WITHOUT freezing to
#                                            measure the downtime, then "reset"
#   2. migrate-timescale-cnpg.sh copy        DOWNTIME STARTS: writers scaled to
#                                            0, old DB read-only, copy, verify
#   3. migrate-timescale-cnpg.sh cutover     deletes the headless Service
#      helm upgrade ... --set timescale.migration.phase=cutover
#      migrate-timescale-cnpg.sh resume      writers back up – DOWNTIME ENDS
#   4. helm upgrade ... (phase "")           removes the old StatefulSet; its
#                                            PVC data-timescale-0 stays
#
#   Back out:  unfreeze  (after a failed copy: old DB writable, writers up)
#              rollback  (after cutover: Service back to the old StatefulSet,
#                         then helm with phase=prepare and "resume" – writes
#                         made to the new cluster since the cutover are lost)
#              reset     (empty the CNPG cluster again after rehearse/failure)
#
# The copy streams pg_dump | pg_restore per database through a pod in the
# namespace – nothing is written to disk in between, the new volumes only need
# room for the data itself. TimescaleDB's catalog schemas are excluded: the
# platform has no hypertables (checked), the extension is created fresh – a
# 2.26 catalog would not even restore into 2.30.
#
# Environment: KUBECONFIG, NAMESPACE (default udp), DB_SECRET (default udp-db),
# YES=1 skips the confirmations.
# =============================================================================
set -euo pipefail

NS="${NAMESPACE:-udp}"
DB_SECRET="${DB_SECRET:-udp-db}"
CLUSTER=timescale
POD=timescale-migrate
# Every component that holds connections to the database (NetworkPolicy
# matrix, templates/networkpolicy.yaml).
WRITERS="orion-ld,mintaka,frost,keycloak,node-red,ckan,db-backup"
ANN_REPLICAS=udp.idk-ev.de/replicas-before-migration
ANN_COPIED=udp.idk-ev.de/copied-from-legacy

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

# psql inside the old instance (local socket, superuser from its environment).
legacy_psql() { k exec -i statefulset/timescale -c timescale -- sh -c 'psql -v ON_ERROR_STOP=1 -X -U "$POSTGRES_USER" -d postgres "$@"' sh "$@"; }

svc_target() { k get service timescale -o jsonpath='{.spec.selector}' 2>/dev/null || true; }
svc_headless() { [ "$(k get service timescale -o jsonpath='{.spec.clusterIP}' 2>/dev/null)" = None ]; }

require_legacy_serving() {
    k get statefulset timescale >/dev/null 2>&1 || die "StatefulSet timescale not found – phase prepare not deployed?"
    case "$(svc_target)" in
        *'"app":"timescale"'*) ;;
        *) die "Service timescale does not point to the old StatefulSet (phase must be prepare)." ;;
    esac
}

require_cluster_ready() {
    local ready
    ready=$(k get cluster "$CLUSTER" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)
    [ "$ready" = True ] || die "CNPG cluster $CLUSTER is not ready (kubectl -n $NS get cluster $CLUSTER)."
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

# ---------------------------------------------------------------- old DB
freeze_legacy() {
    log "Old database: read-only, closing remaining connections"
    legacy_psql -Atc "ALTER SYSTEM SET default_transaction_read_only = on" \
                -c "SELECT pg_reload_conf()" \
                -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
                    WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()" >/dev/null
}

unfreeze_legacy() {
    log "Old database: writable again"
    legacy_psql -Atc "ALTER SYSTEM RESET default_transaction_read_only" -c "SELECT pg_reload_conf()" >/dev/null
}

preflight() {
    log "Preflight"
    local db list hyper settings
    list=$(legacy_psql -Atc "SELECT datname FROM pg_database WHERE datallowconn AND datname NOT IN ('postgres','template1')")
    for db in $list; do
        # Only where the extension exists; a query error aborts (set -e).
        [ -n "$(legacy_psql -d "$db" -Atc "SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'")" ] || continue
        hyper=$(legacy_psql -d "$db" -Atc "SELECT count(*) FROM timescaledb_information.hypertables")
        [ "$hyper" = 0 ] || die "$hyper hypertables in $db – this copy does not handle TimescaleDB hypertables."
    done
    echo "  hypertables: 0"
    # pg_dump (without -C) does not carry ALTER DATABASE/ROLE ... SET.
    settings=$(legacy_psql -Atc "SELECT count(*) FROM pg_db_role_setting")
    [ "$settings" = 0 ] || echo "  WARNING: $settings database/role settings (pg_db_role_setting) are NOT copied – recreate them by hand."
    legacy_psql -Atc "SELECT '  ' || datname || ': ' || pg_size_pretty(pg_database_size(datname))
                      FROM pg_database WHERE datallowconn AND datname NOT IN ('postgres','template1') ORDER BY 1"
}

# ---------------------------------------------------------------- copy pod
# Runs the given mode (copy|rehearse|verify|reset) inside a pod with the CNPG
# image (pg_dump/pg_restore 16) and the database credentials.
run_pod() {
    local mode=$1 image pull managed managed_ext
    image=$(k get imagecatalog "$CLUSTER" -o jsonpath='{.spec.images[0].image}')
    pull=$(k get cluster "$CLUSTER" -o jsonpath='{.spec.imagePullSecrets}')
    managed=$(k get database -l app.kubernetes.io/component=timescale -o jsonpath='{.items[*].spec.name}')
    [ -n "$managed" ] || die "No Database resources found – is phase prepare deployed?"
    # "name:ext1,ext2," per Database resource (for reset).
    managed_ext=$(k get database -l app.kubernetes.io/component=timescale         -o jsonpath='{range .items[*]}{.spec.name}:{range .spec.extensions[*]}{.name},{end} {end}')
    k delete pod "$POD" --ignore-not-found --wait >/dev/null
    k apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $POD
  labels: { app: $POD }
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  imagePullSecrets: ${pull:-[]}
  securityContext:
    runAsNonRoot: true
    runAsUser: 26
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: migrate
      image: $image
      command: ["bash", "-c", $(printf '%s' "$POD_SCRIPT" | json_quote)]
      env:
        - { name: MODE, value: "$mode" }
        - { name: MANAGED_DBS, value: "$managed" }
        - { name: MANAGED_EXT, value: "$managed_ext" }
        - name: PGUSER
          valueFrom: { secretKeyRef: { name: $DB_SECRET, key: POSTGRES_USER } }
        - name: PGPASSWORD
          valueFrom: { secretKeyRef: { name: $DB_SECRET, key: POSTGRES_PASSWORD } }
      resources:
        requests: { cpu: 200m, memory: 256Mi }
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: { drop: [ALL] }
EOF
    # Follow the log; reconnect if the stream drops during a long copy. A pod
    # that never starts (image pull, scheduling) ends the wait after 5 min.
    # A reconnect only prints what came after the previous stream ended – the
    # phase may still read Running for a moment after the container exited.
    local phase waited=0 followed= since=
    while :; do
        phase=$(k get pod "$POD" -o jsonpath='{.status.phase}')
        case "$phase" in
            Running)
                followed=1
                if k logs -f ${since:+--since-time="$since"} "$POD" 2>/dev/null; then
                    since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
                else sleep 5; fi ;;
            Succeeded)
                [ -n "$followed" ] || k logs "$POD" 2>/dev/null
                break ;;
            Failed)
                [ -n "$followed" ] || k logs "$POD" 2>/dev/null || true
                die "$mode failed – see above (pod $POD kept for inspection)." ;;
            *)
                [ "$waited" -lt 300 ] || { k describe pod "$POD" | tail -n 15; die "pod $POD does not start (${phase:-unknown})."; }
                echo "  pod $POD: ${phase:-creating} ..."
                sleep 10; waited=$((waited + 10)) ;;
        esac
    done
    k delete pod "$POD" --wait=false >/dev/null
}

# JSON string literal for the inline script (valid YAML flow scalar).
json_quote() { sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | awk 'BEGIN{printf "\""} {if (NR>1) printf "\\n"; printf "%s", $0} END{printf "\""}'; }

# Executed INSIDE the pod. SRC = old instance, DST = CNPG primary.
# Lists are always captured by an assignment first: a failing $(...) inside a
# for-list does not trip set -e – the loop would silently run zero times and
# an empty copy would pass as success.
POD_SCRIPT=$(cat <<'EOS'
set -euo pipefail
SRC=timescale-legacy
DST=timescale-rw
# Detect a dead peer (lost node, partition) within ~90 s instead of the kernel
# default of ~2 h – the copy would otherwise hang silently during the downtime.
KA="keepalives_idle=30 keepalives_interval=10 keepalives_count=6"
# Restore session only: sort memory for the index builds (the default 64 MB
# spills a multi-GB primary key to disk) and no wait for the standby on every
# commit – the row counts are verified afterwards anyway.
RESTORE_OPTS="options='-c maintenance_work_mem=512MB -c synchronous_commit=off'"
q() { psql -v ON_ERROR_STOP=1 -X -Atq "$@"; }
dbs() { q -h "$1" -d postgres -c "SELECT datname FROM pg_database WHERE datallowconn AND datname NOT IN ('postgres','template1') ORDER BY 1"; }
has() { case " $(echo $1) " in *" $2 "*) return 0 ;; *) return 1 ;; esac; }
# Tables of a database that belong to the platform (not to an extension).
TABLES="SELECT format('%I.%I', n.nspname, c.relname) FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
          AND n.nspname !~ '^_?timescaledb' AND n.nspname !~ '^pg_toast'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
        ORDER BY 1"

src_dbs() {
    local l
    l=$(dbs "$SRC")
    has "$l" orion || { echo "source database list incomplete: $l" >&2; return 1; }
    echo "$l"
}

# The Database resources of the chart create their databases and extensions
# shortly after the cluster – restoring before they are done collides with them.
wait_target() {
    local i db list missing ext
    for i in $(seq 1 60); do
        list=$(dbs "$DST"); missing=""
        for db in $MANAGED_DBS; do has "$list" "$db" || missing="$missing $db"; done
        if [ -z "$missing" ]; then
            # Extensions of the Database resources (templates/timescale.yaml).
            ext=$(( $(q -h "$DST" -d orion -c "SELECT count(*) FROM pg_extension WHERE extname IN ('timescaledb','postgis')")
                  + $(q -h "$DST" -d frost -c "SELECT count(*) FROM pg_extension WHERE extname = 'postgis'")
                  + $(q -h "$DST" -d ckan -c "SELECT count(*) FROM pg_extension WHERE extname = 'postgis'") ))
            [ "$ext" != 4 ] || return 0
            missing=" (extensions)"
        fi
        echo "  waiting for the target databases:$missing"; sleep 5
    done
    echo "target databases not ready after 5 min"; return 1
}

verify() {
    local db t a b bad=0 list dst tables
    list=$(src_dbs); dst=$(dbs "$DST")
    for db in $list; do
        has "$dst" "$db" || { echo "  MISSING database $db"; bad=1; continue; }
        tables=$(q -h "$SRC" -d "$db" -c "$TABLES")
        for t in $tables; do
            a=$(q -h "$SRC" -d "$db" -c "SELECT count(*) FROM $t")
            b=$(q -h "$DST" -d "$db" -c "SELECT count(*) FROM $t" 2>/dev/null || echo missing)
            if [ "$a" != "$b" ]; then echo "  MISMATCH $db $t: $a -> $b"; bad=1
            else printf '  %-16s %-40s %12s\n' "$db" "$t" "$a"; fi
        done
    done
    return $bad
}

# The NetworkPolicy plugin may let a new pod through only a moment after it
# started (kube-router, Cilium identity propagation) – wait for both ends.
for i in $(seq 1 30); do
    pg_isready -q -h "$SRC" -t 2 && pg_isready -q -h "$DST" -t 2 && break
    [ "$i" -lt 30 ] || { echo "$SRC or $DST not reachable"; exit 1; }
    sleep 2
done

case "$MODE" in
copy|rehearse)
    wait_target
    list=$(src_dbs)
    for db in $list; do
        start=$(date +%s)
        # Tenant databases of Orion-LD have no Database resource – create them.
        exists=$(q -h "$DST" -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$db'")
        [ -n "$exists" ] || q -h "$DST" -d postgres -c "CREATE DATABASE \"$db\" OWNER \"$PGUSER\""
        n=$(q -h "$DST" -d "$db" -c "SELECT count(*) FROM ($TABLES) t")
        [ "$n" = 0 ] || { echo "Target database $db is not empty ($n tables) – run: migrate-timescale-cnpg.sh reset"; exit 1; }
        echo "== $db"
        pg_dump -d "host=$SRC dbname=$db $KA" -Fc -Z0 \
            --exclude-schema='_timescaledb*' --exclude-schema='timescaledb_*' \
          | pg_restore -d "host=$DST dbname=$db $KA $RESTORE_OPTS" --exit-on-error
        vacuumdb -h "$DST" -d "$db" --analyze-only -q
        echo "   $(( $(date +%s) - start )) s"
    done
    echo "== Verifying row counts"
    if [ "$MODE" = copy ]; then verify
    else verify || echo "(rehearsal: the source kept changing, differences are expected)"; fi
    ;;
verify) verify ;;
reset)
    list=$(dbs "$DST")
    for db in $list; do
        echo "  dropping $db"
        q -h "$DST" -d postgres -c "DROP DATABASE \"$db\" WITH (FORCE)"
    done
    # The Database resources do not notice a database dropped behind their
    # back (CNPG reconciles them on changes only) – recreate theirs here.
    for m in $MANAGED_EXT; do
        db=${m%%:*}
        echo "  creating $db"
        q -h "$DST" -d postgres -c "CREATE DATABASE \"$db\" OWNER \"$PGUSER\""
        for e in $(echo "${m#*:}" | tr , ' '); do q -h "$DST" -d "$db" -c "CREATE EXTENSION \"$e\""; done
    done
    wait_target
    ;;
*) echo "unknown MODE $MODE"; exit 1 ;;
esac
EOS
)

wait_databases() {
    log "Waiting for the Database resources"
    local i total applied
    for i in $(seq 1 30); do
        total=$(k get database -l app.kubernetes.io/component=timescale -o name | wc -l)
        applied=$(k get database -l app.kubernetes.io/component=timescale \
            -o jsonpath='{range .items[?(@.status.applied==true)]}x{end}' | wc -c)
        if [ "$total" -gt 0 ] && [ "$applied" -eq "$total" ]; then
            echo "  $applied/$total applied"; return 0
        fi
        sleep 10
    done
    die "Database resources not applied after 5 min (kubectl -n $NS get database)."
}

# ---------------------------------------------------------------- commands
case "${1:-}" in
wait)
    log "Waiting for the CNPG cluster $CLUSTER"
    k wait cluster "$CLUSTER" --for=condition=Ready --timeout=20m
    wait_databases
    ;;
rehearse)
    require_legacy_serving; require_cluster_ready; preflight
    log "Rehearsal: copying WITHOUT freezing the platform"
    run_pod rehearse
    echo; echo "Afterwards empty the target again: $0 reset"
    ;;
copy)
    require_legacy_serving; require_cluster_ready; preflight
    confirm "The platform will be DOWN from now until 'resume'. Pause node reboots (kured) first. Continue?"
    scale_down_writers
    freeze_legacy
    log "Copying (pg_dump | pg_restore per database)"
    run_pod copy
    k annotate cluster "$CLUSTER" "$ANN_COPIED=$(date -u +%Y-%m-%dT%H:%M:%SZ)" --overwrite >/dev/null
    log "Copy verified. Next: $0 cutover, then helm upgrade with timescale.migration.phase=cutover, then $0 resume"
    ;;
verify)
    run_pod verify
    ;;
cutover)
    [ -n "$(ann "cluster/$CLUSTER" "$ANN_COPIED")" ] \
        || die "No completed copy recorded on cluster/$CLUSTER – run '$0 copy' first."
    # Only the old headless Service – never the one already pointing to CNPG.
    if svc_headless; then
        log "Deleting the headless Service timescale (the next helm upgrade recreates it for the CNPG primary)"
        k delete service timescale
    fi
    echo "Now: helm upgrade ... --set timescale.migration.phase=cutover (without --atomic), then $0 resume"
    ;;
resume)
    resume_writers
    log "Service timescale -> $(svc_target)"
    ;;
unfreeze)
    unfreeze_legacy
    resume_writers
    ;;
rollback)
    k get statefulset timescale >/dev/null 2>&1 \
        || die "The old StatefulSet is gone (phase \"\" deployed) – this rollback is no longer possible."
    confirm "Point the platform back to the OLD database? Writes to the CNPG cluster since the cutover are lost."
    scale_down_writers
    unfreeze_legacy
    k annotate cluster "$CLUSTER" "$ANN_COPIED-" >/dev/null 2>&1 || true
    svc_headless || k delete service timescale --ignore-not-found
    echo "Now: helm upgrade ... --set timescale.migration.phase=prepare (without --atomic), then $0 resume"
    ;;
reset)
    require_legacy_serving
    confirm "Drop ALL databases in the CNPG cluster $CLUSTER?"
    k annotate cluster "$CLUSTER" "$ANN_COPIED-" >/dev/null 2>&1 || true
    run_pod reset
    ;;
*)
    sed -n '5,40p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
