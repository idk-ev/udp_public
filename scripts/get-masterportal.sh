#!/usr/bin/env bash
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# Lädt das offizielle Masterportal-Release (Geowerkstatt Hamburg, MIT-Lizenz)
# und legt es unter platform/config/masterportal ab.
# Zip-Struktur: mastercode/<version>/ (Runtime) + Basic/ (Beispielportal).
# Danach: docker compose --profile viz-extra up -d
# Portal-URL über das Gateway: http://localhost:8780/portal/Basic/
set -euo pipefail

VERSION="${1:-3.5.0}"
TARGET="$(cd "$(dirname "$0")/../platform/config/masterportal" && pwd)"
URL="https://bitbucket.org/geowerkstatt-hamburg/masterportal/downloads/examples-${VERSION}.zip"

echo ">> Lade Masterportal ${VERSION} ..."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/mp.zip"
unzip -q "$TMP/mp.zip" -d "$TMP"

cp -r "$TMP/mastercode" "$TARGET/"
cp -r "$TMP/Basic" "$TARGET/"

echo ">> Masterportal nach $TARGET installiert (Runtime + Portal 'Basic')."
echo ">> UDP-Anpassungen (Titel, GeoServer-Layer): $TARGET/Basic/config.json"
