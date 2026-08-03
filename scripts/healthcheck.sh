#!/bin/bash
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# Registry-getriebener Health-Check aller Konnektoren (Masterplan §5 F1).
# Quelle: gui/public/connectors-status.json (Export des Flow-Generators).
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
STATUS="$REPO/gui/public/connectors-status.json"
GW="http://localhost:8780"
echo "== Konnektoren-Health $(date '+%H:%M:%S') =="
ids=$(jq -r '.connectors[] | select(.active != false and .sampleEntity != null) | .sampleEntity' "$STATUS" | paste -sd,)
resp=$(curl -s "$GW/ngsi-ld/v1/entities?id=$ids&options=sysAttrs&limit=100")
fail=0
while IFS=$'\t' read -r name soll sample secret pending; do
  mod=$(echo "$resp" | jq -r --arg id "$sample" '.[] | select(.id==$id) | .modifiedAt // .createdAt' 2>/dev/null)
  if [ -z "$mod" ] || [ "$mod" = "null" ]; then
    if [ "$secret" != "null" ] && [ -n "$secret" ]; then
      printf '%-46s %s\n' "$name" "WARTET (Secret/Freischaltung)"
    elif [ "$pending" = "true" ]; then
      printf '%-46s %s\n' "$name" "WARTET (erster Ingest ausstehend)"
    else
      printf '%-46s %s\n' "$name" "FEHLT"; fail=1
    fi
    continue
  fi
  age=$(( ( $(date +%s) - $(date -d "$mod" +%s) ) / 60 ))
  if [ "$age" -le $(( soll * 3 / 2 )) ]; then st="OK  "; elif [ "$age" -le $(( soll * 3 )) ]; then st="SPÄT"; else st="ROT "; fail=1; fi
  printf '%-46s %s %5d min (Soll %d)\n' "$name" "$st" "$age" "$soll"
done < <(jq -r '.connectors[] | select(.active != false and .sampleEntity != null) | [.name, (.sollMinutes // 60), .sampleEntity, (.requiresSecret // "null"), (.pending // false)] | @tsv' "$STATUS")
# Konnektoren ohne Entität (Endpunkte, Kontext-Caches) werden über healthUrl
# geprüft — sonst blieben sie unsichtbar, obwohl ein Ausfall Kacheln kostet.
while IFS=$'\t' read -r name url; do
  [ -n "$url" ] || continue
  code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$url" || true)
  [ "$code" = "000" ] && code="nicht erreichbar"
  case "$code" in 2*) st="OK  ";; *) st="ROT "; fail=1;; esac
  printf '%-46s %s %s\n' "$name" "$st" "HTTP $code"
done < <(jq -r '.connectors[] | select(.active != false and .healthUrl != null) | [.name, .healthUrl] | @tsv' "$STATUS")

echo "-- Node-RED-Fehler (70 min): $(docker logs udp-node-red --since 70m 2>&1 | grep -cE '\[error\]')"
# Warnungen mitzählen: Ein Komplettausfall einer Quelle (z. B. alle EFA-Städte
# gleichzeitig »JSON parse error«) erscheint nur als [warn] und blieb bisher
# unsichtbar. Die drei häufigsten Warnquellen werden benannt.
WARN=$(docker logs udp-node-red --since 70m 2>&1 | grep -cE '\[warn\]')
echo "-- Node-RED-Warnungen (70 min): $WARN"
if [ "$WARN" -gt 10 ]; then
    docker logs udp-node-red --since 70m 2>&1 | grep -E '\[warn\]' \
        | sed -E 's/.*\[warn\] \[([^]]*)\].*/   \1/' | sort | uniq -c | sort -rn | head -3
fi
echo "-- TRoE gesamt: $(docker exec udp-timescale psql -U udp -d orion -Atc 'SELECT count(*) FROM attributes;')"

# Gemeinde-Abdeckung je Datentyp: macht sichtbar, dass "Konnektor aktiv" nicht
# "flächendeckend" heißt (Audit Frage 3). Zählt eindeutige Gemeinden (ags) je Typ.
echo "-- Gemeinde-Abdeckung (von 1103):"
cov() {
  local n
  n=$(curl -s "$GW/ngsi-ld/v1/entities?type=$1&limit=1&count=true" -D- -o /dev/null 2>/dev/null | grep -i 'ngsild-results-count' | tr -d '\r' | grep -oE '[0-9]+')
  printf '    %-22s %s\n' "$1" "${n:-?}"
}
# PublicAmenity = Familie & Versorgung
for t in WeatherForecast EnergyMonitor ChargingSummary CivicStructure TouristDestination \
         CityPulse SharingSummary AirQualityObserved WaterLevelObserved ParkingSummary \
         PublicTransportStop HeatHealthWarning PublicAmenity; do cov "$t"; done

exit $fail
