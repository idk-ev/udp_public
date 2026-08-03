# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# CKAN mit DCAT-AP-Unterstützung (ckanext-dcat) für DCAT-AP.de-Metadaten
FROM ckan/ckan-base:2.10.10

# Basis-Image läuft als root; das Start-Skript (start_ckan.sh) übernimmt
# selbst die Rechtetrennung. Kein USER-Wechsel hier – der Entrypoint muss
# /srv/app/ckan.ini schreiben können.
RUN pip install --no-cache-dir \
    "ckanext-dcat>=1.7.0"

# Alpine-uwsgi ist plugin-basiert: ohne diese Plugins kennt es weder
# --wsgi-file noch --http ("unrecognized option: wsgi-file").
ENV UWSGI_PLUGINS=http,python3
