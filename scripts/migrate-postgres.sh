#!/usr/bin/env bash
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# =============================================================================
# Ablösung TimescaleDB (Timescale License, nicht OSI) -> PostgreSQL + PostGIS
#
# Hintergrund: Das Image timescale/timescaledb-ha steht unter der TSL; die
# Plattform nutzt faktisch keine Timescale-Funktionen (0 Hypertables, keine
# Compression/CAggs — TRoE arbeitet mit gewöhnlichen Tabellen). Der Wechsel auf
# postgis/postgis macht den Stack vollständig OSI-konform (Lizenz-Audit §8).
#
# Ablauf: Vorprüfung -> Dump -> Umschalten (neues Volume) -> Restore ->
#         Verifikation (Zeilenzahlen, Extensions, Dienste). Bei Abbruch bleibt
#         das alte Volume unangetastet -> Rollback mit --rollback.
#
# Aufruf:  bash scripts/migrate-postgres.sh            (Migration)
#          bash scripts/migrate-postgres.sh --rollback (zurück auf Timescale)
#          bash scripts/migrate-postgres.sh --dry-run  (nur Vorprüfung + Dump)
# Dauer: ~5-10 min, davon ~2 min Ausfall der Kontext-/Katalogdienste.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="$ROOT/platform/docker-compose.yml"
DUMPDIR="${DUMPDIR:-$ROOT/../udp-pgmigration-$(date +%Y%m%d-%H%M)}"
NEW_IMAGE="postgis/postgis:16-3.5"
OLD_IMAGE="timescale/timescaledb-ha:pg16"
DEPS="orion-ld mintaka frost ckan node-red backup"
DBS="orion ckan ckan_datastore frost keycloak udp orion_ldk"
dc() { docker compose -f "$COMPOSE" "$@"; }
psqlc() { docker exec udp-timescale psql -U udp "$@"; }
log() { echo -e "\n\033[1m▶ $*\033[0m"; }

# --------------------------------------------------------------- Rollback
if [ "${1:-}" = "--rollback" ]; then
    log "Rollback auf $OLD_IMAGE (altes Volume udp_timescale-data)"
    sed -i "s|image: $NEW_IMAGE|image: $OLD_IMAGE|; \
            s|- postgres-data:/var/lib/postgresql/data|- timescale-data:/home/postgres/pgdata/data|; \
            s|^  postgres-data:|  timescale-data:|" "$COMPOSE"
    dc up -d timescale && sleep 15 && dc up -d $DEPS
    echo "Rollback abgeschlossen — Datenbestand des alten Volumes ist wieder aktiv."
    exit 0
fi

# --------------------------------------------------------------- 1. Vorprüfung
log "1/6 Vorprüfung"
HYPER=$(psqlc -d orion -tAc "SELECT count(*) FROM timescaledb_information.hypertables" 2>/dev/null || echo "0")
if [ "$HYPER" != "0" ]; then
    echo "ABBRUCH: $HYPER Hypertables in Nutzung — Migration würde Timescale-Funktionen entfernen."
    exit 1
fi
echo "  Hypertables: 0 (ok — keine Timescale-Funktionen in Nutzung)"
mkdir -p "$DUMPDIR"
psqlc -d orion -tAc "SELECT 'attributes='||count(*) FROM attributes" > "$DUMPDIR/counts-vorher.txt"
psqlc -d orion -tAc "SELECT 'entities='||count(*) FROM entities" >> "$DUMPDIR/counts-vorher.txt"
cat "$DUMPDIR/counts-vorher.txt" | sed 's/^/  /'

# --------------------------------------------------------------- 2. Dump
log "2/6 Sicherung nach $DUMPDIR"
docker exec udp-timescale pg_dumpall -U udp --globals-only > "$DUMPDIR/globals.sql"
EXCL=""
for s in _timescaledb_cache _timescaledb_catalog _timescaledb_config \
         _timescaledb_functions _timescaledb_internal \
         timescaledb_experimental timescaledb_information; do
    EXCL="$EXCL --exclude-schema=$s"
done
for db in $DBS; do
    docker exec udp-timescale pg_dump -U udp -d "$db" $EXCL > "$DUMPDIR/$db.sql" 2>/dev/null || true
    sed -i '/CREATE EXTENSION IF NOT EXISTS timescaledb/d; /COMMENT ON EXTENSION timescaledb/d' "$DUMPDIR/$db.sql"
    printf "  %-16s %6s MB\n" "$db" "$(( $(stat -c%s "$DUMPDIR/$db.sql") / 1048576 ))"
done
[ "${1:-}" = "--dry-run" ] && { echo -e "\nDry-Run beendet — Dumps liegen in $DUMPDIR"; exit 0; }

# --------------------------------------------------------------- 3. Umschalten
log "3/6 Dienste anhalten und auf $NEW_IMAGE umstellen"
dc stop $DEPS timescale
cp "$COMPOSE" "$DUMPDIR/docker-compose.yml.bak"
sed -i "s|image: $OLD_IMAGE|image: $NEW_IMAGE|; \
        s|- timescale-data:/home/postgres/pgdata/data|- postgres-data:/var/lib/postgresql/data|; \
        s|^  timescale-data:|  postgres-data:|" "$COMPOSE"
docker compose -f "$COMPOSE" config -q || { echo "ABBRUCH: Compose ungültig"; cp "$DUMPDIR/docker-compose.yml.bak" "$COMPOSE"; exit 1; }
dc up -d timescale

log "4/6 Warten auf initdb (legt DBs und PostGIS über config/postgres/init an)"
for i in $(seq 1 60); do
    docker exec udp-timescale pg_isready -U udp -d orion >/dev/null 2>&1 && break
    sleep 3
done
docker exec udp-timescale pg_isready -U udp -d orion || { echo "ABBRUCH: DB startet nicht — Rollback mit --rollback"; exit 1; }
sleep 5

# --------------------------------------------------------------- 5. Restore
log "5/6 Rückspielen"
docker exec -i udp-timescale psql -U udp -d postgres < "$DUMPDIR/globals.sql" >/dev/null 2>&1 || true
psqlc -d postgres -c "CREATE DATABASE orion_ldk" >/dev/null 2>&1 || true
for db in $DBS; do
    [ -s "$DUMPDIR/$db.sql" ] || continue
    echo "  $db …"
    docker exec -i udp-timescale psql -U udp -d "$db" -v ON_ERROR_STOP=0 < "$DUMPDIR/$db.sql" > "$DUMPDIR/restore-$db.log" 2>&1
done

# --------------------------------------------------------------- 6. Verifikation
log "6/6 Verifikation"
NACH_A=$(psqlc -d orion -tAc "SELECT count(*) FROM attributes")
VOR_A=$(grep attributes "$DUMPDIR/counts-vorher.txt" | cut -d= -f2)
echo "  attributes: vorher $VOR_A -> nachher $NACH_A"
if [ "$NACH_A" -lt "$VOR_A" ]; then
    echo "  WARNUNG: weniger Zeilen als vorher — Restore-Logs in $DUMPDIR prüfen, ggf. --rollback"
fi
echo "  Extensions orion: $(psqlc -d orion -tAc "SELECT string_agg(extname,', ') FROM pg_extension")"
dc up -d $DEPS
sleep 20
for u in "http://localhost:8780/ngsi-ld/v1/entities?type=CityPulse&limit=1" \
         "http://localhost:8780/temporal/health" \
         "http://localhost:3700/reutlingen"; do
    printf "  %-70s %s\n" "${u:0:70}" "$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$u")"
done
echo -e "\nFertig. Altes Volume udp_timescale-data bleibt als Rückfall erhalten."
echo "Aufräumen erst nach ein paar Tagen Betrieb: docker volume rm udp_timescale-data"
