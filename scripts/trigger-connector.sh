#!/usr/bin/env bash
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# Löst die Pipeline eines Konnektors sofort aus (Erstbefüllung bzw. nach Änderungen).
# Nötig für Konnektoren mit refireOnRestart=false (z. B. die wöchentlichen
# Overpass-Quellen), die bewusst nicht bei jedem Node-RED-Neustart feuern.
#   Beispiel: bash scripts/trigger-connector.sh ausflug-bw
set -euo pipefail
ID="${1:?Konnektor-ID, z. B. ausflug-bw}"
NR="${NODERED_URL:-http://localhost:4900}"
REG="$(dirname "$0")/../platform/config/connectors.json"
PREFIXES=$(python3 -c "
import json,sys
r=json.load(open('$REG'))['connectors']
c=[x for x in r if x['id']=='$ID']
sys.exit('Unbekannter Konnektor: $ID') if not c else None
print(' '.join(c[0]['nodePrefixes']))")
for p in $PREFIXES; do
  NODE=$(curl -s "$NR/flows" | python3 -c "
import sys,json
print(next((n['id'] for n in json.load(sys.stdin)
            if n.get('type')=='inject' and str(n.get('id','')).startswith('$p')), ''))")
  [ -n "$NODE" ] || continue
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$NR/inject/$NODE")
  echo "$ID: $NODE ausgelöst (HTTP $code)"
done
