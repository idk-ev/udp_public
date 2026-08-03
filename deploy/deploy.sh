#!/usr/bin/env bash
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# =============================================================================
# UDP — Deployment auf einen Host (idempotent, mehrfach ausführbar)
#
# Holt den aktuellen Stand aus dem Git-Repository über den SSH-Deploy-Key,
# richtet .env und den systemd-User-Service ein und bringt den Stack hoch.
# Danach ist der Autostart nach Reboot ohne Benutzeranmeldung gesichert
# (Docker-Restart-Policy + systemd-Lingering).
#
# Erstinstallation auf einem frischen Host:
#     1. Deploy-Key hinterlegen:   ~/.ssh/id_ed25519_udp  (chmod 600)
#        und in ~/.ssh/config:     Host github-udp
#                                      HostName github.com
#                                      User git
#                                      IdentityFile ~/.ssh/id_ed25519_udp
#                                      IdentitiesOnly yes
#     2. git clone git@github-udp:idk-ev/UDP.git ~/projects/udp
#     3. cp platform/.env.example platform/.env  && Secrets eintragen
#     4. bash deploy/deploy.sh
#
# Aktualisierung (Regelfall):   bash deploy/deploy.sh
# Nur Neustart ohne Git-Pull:   bash deploy/deploy.sh --no-pull
# =============================================================================
set -euo pipefail

UDP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$UDP_ROOT/deploy/systemd/udp-stack.service"
UNIT_DST="$HOME/.config/systemd/user/udp-stack.service"
ENV_FILE="$UDP_ROOT/platform/.env"
PULL=1
[ "${1:-}" = "--no-pull" ] && PULL=0

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy] Hinweis:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[deploy] FEHLER:\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. Voraussetzungen ------------------------------------------------------
log "1/6 Voraussetzungen prüfen"
command -v docker >/dev/null || die "docker nicht im PATH."
docker compose version >/dev/null 2>&1 || die "docker compose v2 (Plugin) erforderlich."
docker info >/dev/null 2>&1 || die "Docker-Daemon nicht erreichbar."
command -v node >/dev/null || warn "node fehlt — GUI-Build wird übersprungen."
[ -f "$ENV_FILE" ] || die "$ENV_FILE fehlt. Anlegen mit: cp platform/.env.example platform/.env (danach Secrets eintragen)."

# Secrets müssen gesetzt und keine Platzhalter sein
for key in POSTGRES_PASSWORD KEYCLOAK_ADMIN_PASSWORD CKAN_ADMIN_PASSWORD; do
    val="$(grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed 's/#.*//' | tr -d '[:space:]' || true)"
    [ -n "$val" ] || die "$key fehlt oder ist leer in $ENV_FILE."
    case "$val" in *CHANGE_ME*|*changeme*) die "$key enthält noch einen Platzhalter.";; esac
done

# --- 2. Quellstand holen -----------------------------------------------------
if [ "$PULL" = 1 ] && [ -d "$UDP_ROOT/.git" ]; then
    log "2/6 Repository aktualisieren (SSH-Deploy-Key)"
    git -C "$UDP_ROOT" remote -v | grep -q github-udp || \
        warn "Remote nutzt nicht den Host-Alias »github-udp« — Deploy-Key greift evtl. nicht."
    git -C "$UDP_ROOT" fetch --quiet origin
    LOCAL_CHANGES="$(git -C "$UDP_ROOT" status --porcelain | grep -v '^?? ' || true)"
    [ -z "$LOCAL_CHANGES" ] || die "Lokale Änderungen vorhanden — erst committen oder verwerfen:\n$LOCAL_CHANGES"
    git -C "$UDP_ROOT" merge --ff-only origin/main
    log "    Stand: $(git -C "$UDP_ROOT" log -1 --format='%h %s' | cut -c1-72)"
else
    log "2/6 Git-Pull übersprungen"
fi

# --- 3. Generierte Artefakte ------------------------------------------------
log "3/6 Generierte Artefakte erzeugen"
python3 "$UDP_ROOT/scripts/generate-city-pages.py" | tail -1
python3 "$UDP_ROOT/scripts/generate-nodered-flows.py" | tail -1
if command -v npm >/dev/null; then
    ( cd "$UDP_ROOT/gui" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null )
    log "    GUI gebaut -> gui/dist"
else
    warn "npm fehlt — gui/dist bleibt auf dem vorhandenen Stand."
fi

# --- 4. systemd-User-Service -------------------------------------------------
log "4/6 systemd-User-Service einrichten"
mkdir -p "$(dirname "$UNIT_DST")"
sed "s|__UDP_ROOT__|$UDP_ROOT|g" "$UNIT_SRC" > "$UNIT_DST"
systemctl --user daemon-reload
systemctl --user enable udp-stack >/dev/null
# Lingering: Start beim Boot ohne Benutzeranmeldung
if ! loginctl show-user "$USER" -p Linger --value 2>/dev/null | grep -q yes; then
    loginctl enable-linger "$USER" 2>/dev/null \
        || warn "Lingering konnte nicht gesetzt werden — als root: loginctl enable-linger $USER"
fi

# --- 5. Stack starten --------------------------------------------------------
log "5/6 Stack starten"
systemctl --user restart udp-stack
sleep 15

# --- 6. Rauchtest ------------------------------------------------------------
log "6/6 Rauchtest"
# Werte aus .env lesen — Inline-Kommentare und Leerzeichen abschneiden
envval() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed 's/#.*//' | tr -d '[:space:]'; }
UI_PORT="$(envval UI_PORT)";       UI_PORT="${UI_PORT:-3700}"
PROXY_PORT="$(envval PROXY_PORT)"; PROXY_PORT="${PROXY_PORT:-8780}"
# Bis zu 6 min auf die Kontext-API warten: Orion-LD wartet selbst auf Mongo und
# TimescaleDB, APISIX lädt danach seine Routen — der Stack ist erst dann bereit.
bereit=0
for i in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://localhost:$PROXY_PORT/ngsi-ld/v1/entities?type=CityPulse&limit=1" || true)"
    [ "$code" = "200" ] && { bereit=1; log "    bereit nach $(( i * 6 )) s"; break; }
    sleep 6
done
[ "$bereit" = 1 ] || warn "Kontext-API nach 6 min noch nicht bereit — Prüfungen unten sind entsprechend zu lesen."
# curl liefert 000, wenn gar keine Verbindung zustande kam — das als Klartext zeigen
check() {
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$2" || true)"
    [ "$code" = "000" ] && code="nicht erreichbar"
    printf '    %-46s %s\n' "$1" "$code"
    case "$code" in 2*|3*) ;; *) fail=$((fail + 1)) ;; esac
}
fail=0
check "Kontext-API (Orion-LD)"  "http://localhost:$PROXY_PORT/ngsi-ld/v1/entities?type=CityPulse&limit=1"
check "Temporal-API (Mintaka)"  "http://localhost:$PROXY_PORT/temporal/health"
check "Open-Data-Portal (CKAN)" "http://localhost:$PROXY_PORT/catalog/api/3/action/status_show"
check "Hauptdashboard"          "http://localhost:$UI_PORT/dashboard.html"
check "Referenz-Dashboard"      "http://localhost:$UI_PORT/reutlingen"
echo
docker ps --filter "name=udp-" --format '{{.Names}}\t{{.Status}}' | sed 's/^/    /'
echo
if [ "$fail" -gt 0 ]; then
    warn "$fail von 5 Prüfungen ohne Erfolg — Logs: docker compose -f platform/docker-compose.yml logs --tail=50"
else
    log "Rauchtest vollständig bestanden."
fi
log "Konnektor-Ampel: bash scripts/healthcheck.sh"
log "Dienststatus:    systemctl --user status udp-stack"
exit $(( fail > 0 ? 1 : 0 ))
