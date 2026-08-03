# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# Node-RED der UDP mit fest eingebauten Datenflüssen
#
# Warum ein eigenes Image:
#  * flows.json ist ein GENERIERTES Artefakt (scripts/generate-nodered-flows.py),
#    kein von Hand gepflegter Zustand. Es gehört damit zum Build, nicht in ein
#    beschreibbares Volume — genau wie die SPA im Cockpit-Image.
#  * Ohne die Flows startet Node-RED mit leerer Flow-Liste: kein Konnektor
#    ingestiert, /abfahrten und /warnungen.ics liefern 404.
#  * Ein ConfigMap-Weg scheidet aus: flows.json liegt bei ~420 KB und wächst
#    mit jedem Konnektor — die etcd-Grenze für ConfigMaps liegt bei 1 MiB.
#  * Digest-Pinning (values-prod.yaml) liefert damit exakt reproduzierbare
#    Datenflüsse, so wie bei cockpit, ckan-dcat und postgres-timescale-oss.
#
# settings.js ist nicht bloß Kosmetik:
#  * functionExternalModules=true erlaubt den beiden TRoE-Function-Nodes, das
#    npm-Modul "pg" zu laden (Statistik + Retention sprechen direkt SQL).
#  * contextStorage=localfilesystem hält die Änderungserkennung der Konnektoren
#    (gateChanged/csStand/ocSignatur) über einen Deploy-Zyklus hinweg.
#
# Der Build-Kontext ist das REPOSITORY-WURZELVERZEICHNIS (wie bei gui/Dockerfile),
# damit hier aus platform/config/nodered/ kopiert werden kann:
#   docker build -f platform/config/nodered/Dockerfile .
FROM nodered/node-red:4.1

# Alles als root einrichten und am Ende an den node-red-Benutzer (1000) geben;
# das Basis-Image wechselt selbst auf USER node-red zurück.
USER root

# "pg" fest ins Image statt zur Laufzeit nachinstallieren zu lassen: sonst zieht
# jeder Pod-Start das Modul erneut von npmjs.org (langsamer Start und eine
# Laufzeit-Abhängigkeit von einer externen Registry).
# NODE_PATH des Basis-Images enthält /data/node_modules — genau dort sucht auch
# der Function-Node nach extern deklarierten Modulen.
RUN mkdir -p /data \
 && cd /data \
 && npm install --no-audit --no-fund --omit=dev pg@8 \
 && npm cache clean --force

COPY platform/config/nodered/flows.json  /data/flows.json
COPY platform/config/nodered/settings.js /data/settings.js

# /data ist hier ein normaler Image-Layer (KEIN Volume): das Chart mountet
# bewusst nichts darüber, sonst würden die Flows vom leeren Volume verdeckt.
RUN chown -R 1000:1000 /data

USER node-red
