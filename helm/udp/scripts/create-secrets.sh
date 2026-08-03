#!/usr/bin/env bash
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# =============================================================================
# UDP – Secrets für Produktion anlegen (secrets.create=false / Weg B).
#
# Erzeugt die beiden vom Chart erwarteten Secrets mit starken Zufallspasswörtern:
#   - udp-db        (POSTGRES_USER, POSTGRES_PASSWORD)
#   - udp-keycloak  (KEYCLOAK_ADMIN, KEYCLOAK_ADMIN_PASSWORD)
#
# SICHERHEIT – ZIELCLUSTER: --context ist PFLICHT. Das Skript wählt niemals
# implizit den "current-context" (Schutz vor versehentlichem Deploy auf den
# falschen Cluster) und zeigt vor jeder Änderung Cluster + Namespace zur
# Bestätigung an.
#
# IDEMPOTENT: existierende Secrets werden NICHT überschrieben (kein versehent-
# liches Rotieren eines Passworts, das die laufende DB bereits nutzt). Zum
# bewussten Rotieren: --force.
#
# Beispiele:
#   ./create-secrets.sh --context prod-cluster
#   ./create-secrets.sh --context prod --namespace udp-prod
#   ./create-secrets.sh --context prod --kubeconfig ~/.kube/prod.yaml
#   ./create-secrets.sh --context prod --force        # Passwörter rotieren
#   ./create-secrets.sh --context prod --sealed       # SealedSecret-YAML
#   ./create-secrets.sh --context prod -y             # ohne Rückfrage (CI)
# =============================================================================
set -euo pipefail

NAMESPACE="${NAMESPACE:-udp}"
DB_SECRET="${DB_SECRET:-udp-db}"
KC_SECRET="${KC_SECRET:-udp-keycloak}"
DB_USER="${DB_USER:-udp}"
KC_ADMIN="${KC_ADMIN:-admin}"
PW_LEN="${PW_LEN:-28}"
CONTEXT="${CONTEXT:-}"
KUBECONFIG_FILE="${KUBECONFIG_FILE:-}"
FORCE=0
SEALED=0
ASSUME_YES=0
OUT_DIR="${OUT_DIR:-./sealed}"

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    -c|--context)   CONTEXT="$2"; shift 2 ;;
    --kubeconfig)   KUBECONFIG_FILE="$2"; shift 2 ;;
    -n|--namespace) NAMESPACE="$2"; shift 2 ;;
    --db-user)      DB_USER="$2"; shift 2 ;;
    --kc-admin)     KC_ADMIN="$2"; shift 2 ;;
    --force)        FORCE=1; shift ;;
    --sealed)       SEALED=1; shift ;;
    -y|--yes)       ASSUME_YES=1; shift ;;
    -h|--help)      usage ;;
    *) echo "Unbekannte Option: $1" >&2; exit 1 ;;
  esac
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "FEHLER: '$1' nicht gefunden." >&2; exit 1; }; }
need kubectl
[ "$SEALED" -eq 1 ] && need kubeseal

# --- kubectl-Wrapper: immer mit explizitem Kontext (+ optional kubeconfig) ---
KUBECTL=(kubectl)
[ -n "$KUBECONFIG_FILE" ] && KUBECTL+=(--kubeconfig "$KUBECONFIG_FILE")
KUBECTL+=(--context "$CONTEXT")
kc() { "${KUBECTL[@]}" "$@"; }

# Für die Auflistung verfügbarer Kontexte (ohne --context) ----------------
KUBECTL_BASE=(kubectl)
[ -n "$KUBECONFIG_FILE" ] && KUBECTL_BASE+=(--kubeconfig "$KUBECONFIG_FILE")

# --- Kontext ist Pflicht ----------------------------------------------------
if [ -z "$CONTEXT" ]; then
  echo "FEHLER: Kein --context angegeben." >&2
  echo "Zur Sicherheit muss der Zielcluster explizit gewählt werden." >&2
  echo >&2
  echo "Verfügbare Kontexte:" >&2
  "${KUBECTL_BASE[@]}" config get-contexts >&2 || true
  echo >&2
  echo "Beispiel: $0 --context <name>" >&2
  exit 2
fi

# --- Kontext validieren -----------------------------------------------------
if ! "${KUBECTL_BASE[@]}" config get-contexts -o name 2>/dev/null | grep -Fxq "$CONTEXT"; then
  echo "FEHLER: Kontext '$CONTEXT' existiert nicht." >&2
  echo "Verfügbare Kontexte:" >&2
  "${KUBECTL_BASE[@]}" config get-contexts -o name >&2 || true
  exit 2
fi

# --- Passwortgenerator: kryptografisch, nur [A-Za-z0-9] ---------------------
# Alphanumerisch, weil das Postgres-Init-Skript (00-auth.sh) das Passwort in
# einfachen Anführungszeichen in SQL einsetzt -> Sonderzeichen/Quotes vermeiden.
gen_pw() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 64 | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c "$PW_LEN"
  elif [ -r /dev/urandom ]; then
    LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$PW_LEN"
  else
    echo "FEHLER: weder openssl noch /dev/urandom verfügbar." >&2; exit 1
  fi
}

# --- Zielcluster anzeigen + bestätigen --------------------------------------
CLUSTER_NAME="$("${KUBECTL_BASE[@]}" config view -o "jsonpath={.contexts[?(@.name=='$CONTEXT')].context.cluster}" 2>/dev/null || true)"
SERVER="$(kc config view --minify -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null || echo '?')"

echo "============================================================"
echo " Zielcluster-Kontext : $CONTEXT"
echo " Cluster / API-Server: ${CLUSTER_NAME:-?}  ($SERVER)"
echo " Namespace           : $NAMESPACE"
echo " Modus               : $([ "$SEALED" -eq 1 ] && echo 'SealedSecret-YAML' || echo 'im Cluster anlegen')$([ "$FORCE" -eq 1 ] && echo ' + FORCE (rotieren)')"
echo "============================================================"
if [ "$ASSUME_YES" -eq 0 ] && [ "$SEALED" -eq 0 ]; then
  printf "Auf DIESEN Cluster anwenden? [y/N] "
  read -r answer </dev/tty || answer=""
  case "$answer" in
    y|Y|yes|YES|j|J|ja|JA) ;;
    *) echo "Abgebrochen."; exit 1 ;;
  esac
fi

# --- Namespace sicherstellen (nur beim direkten Anlegen) --------------------
if [ "$SEALED" -eq 0 ] && ! kc get namespace "$NAMESPACE" >/dev/null 2>&1; then
  echo "Namespace '$NAMESPACE' anlegen…"
  kc create namespace "$NAMESPACE"
fi

# Erzeugt/aktualisiert ein generisches Secret aus key=value-Paaren.
# Args: <secret-name> <k1> <v1> [<k2> <v2> ...]
apply_secret() {
  local name="$1"; shift
  local args=()
  while [ $# -gt 0 ]; do args+=("--from-literal=$1=$2"); shift 2; done

  local manifest
  manifest="$(kc create secret generic "$name" -n "$NAMESPACE" \
    "${args[@]}" --dry-run=client -o yaml)"

  if [ "$SEALED" -eq 1 ]; then
    mkdir -p "$OUT_DIR"
    local seal=(kubeseal)
    [ -n "$KUBECONFIG_FILE" ] && seal+=(--kubeconfig "$KUBECONFIG_FILE")
    seal+=(--context "$CONTEXT" --format yaml)
    echo "$manifest" | "${seal[@]}" > "$OUT_DIR/$name.sealed.yaml"
    echo "  -> SealedSecret geschrieben: $OUT_DIR/$name.sealed.yaml"
  else
    echo "$manifest" | kc apply -f -
  fi
}

# Legt ein Secret an, sofern nicht vorhanden (oder --force).
ensure_secret() {
  local name="$1"; shift
  if [ "$SEALED" -eq 0 ] && [ "$FORCE" -eq 0 ] \
     && kc get secret "$name" -n "$NAMESPACE" >/dev/null 2>&1; then
    echo "Secret '$name' existiert bereits – übersprungen (--force zum Rotieren)."
    return 1
  fi
  apply_secret "$name" "$@"
  return 0
}

echo "== UDP-Secrets für Namespace '$NAMESPACE' =="

DB_PASS="$(gen_pw)"
KC_PASS="$(gen_pw)"

DB_WRITTEN=0; KC_WRITTEN=0
ensure_secret "$DB_SECRET" POSTGRES_USER "$DB_USER" POSTGRES_PASSWORD "$DB_PASS" && DB_WRITTEN=1 || true
ensure_secret "$KC_SECRET" KEYCLOAK_ADMIN "$KC_ADMIN" KEYCLOAK_ADMIN_PASSWORD "$KC_PASS" && KC_WRITTEN=1 || true

echo
if [ "$SEALED" -eq 1 ]; then
  echo "Fertig. SealedSecrets in '$OUT_DIR/' – ins Git-Repo committen und mit"
  echo "  kubectl --context $CONTEXT apply -f '$OUT_DIR/'  im Cluster ausrollen."
else
  echo "Fertig. In values-prod.yaml sicherstellen:"
  echo "  secrets.create: false"
  echo "  db.existingSecret: \"$DB_SECRET\""
  echo "  keycloak.existingSecret: \"$KC_SECRET\""
  echo
  echo "Passwörter jederzeit auslesbar:"
  echo "  kubectl --context $CONTEXT -n $NAMESPACE get secret $DB_SECRET -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d; echo"
  echo "  kubectl --context $CONTEXT -n $NAMESPACE get secret $KC_SECRET -o jsonpath='{.data.KEYCLOAK_ADMIN_PASSWORD}' | base64 -d; echo"
  [ "$KC_WRITTEN" -eq 1 ] && echo && echo "Keycloak-Admin: $KC_ADMIN / $KC_PASS  (jetzt sicher notieren)"
fi
