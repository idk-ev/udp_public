# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# UDP-Cockpit – Produktions-Image (Mehrstufen-Build)
# Build aus dem Repo-Root:  docker build -f gui/Dockerfile -t udp/cockpit:1.0.0 .
# (Kontext = Repo-Root, weil die nginx-Konfiguration aus platform/ kommt.)
FROM node:24-alpine AS build
WORKDIR /app
COPY gui/package.json gui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY gui/ .
RUN npm run build

# nginx-unprivileged statt nginx: der Master laeuft als 101 statt als Root.
# Das offizielle nginx-Image chownt beim Start die proxy_cache_path-Verzeichnisse
# auf den Worker-Benutzer – ohne CAP_CHOWN (Kubernetes: capabilities drop ALL)
# scheitert es mit  chown("/var/cache/nginx/udp", 101) failed (1: Operation not
# permitted). Der unprivilegierte Master laesst den Benutzerwechsel und damit
# das chown ganz weg und lauscht auf 8080 (kein CAP_NET_BIND_SERVICE noetig).
FROM nginxinc/nginx-unprivileged:1.30-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# /etc/nginx/templates: der Entrypoint (20-envsubst-on-templates.sh) ersetzt die
# Platzhalter und legt das Ergebnis unter /etc/nginx/conf.d/default.conf ab.
COPY platform/config/nginx/cockpit.conf.template /etc/nginx/templates/default.conf.template

# Der Entrypoint liest die Nameserver aus /etc/resolv.conf nach
# NGINX_LOCAL_RESOLVERS – so stimmt der resolver in Docker (127.0.0.11) wie in
# Kubernetes (Cluster-DNS), ohne ihn irgendwo zu pflegen.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
# Nur diese Variablen ersetzen lassen – sonst könnte envsubst nginx-eigene
# Variablen treffen, sobald eine gleichnamige Umgebungsvariable existiert.
ENV NGINX_ENVSUBST_FILTER=^(UDP_|NGINX_LOCAL_RESOLVERS)
# Vorbelegung für Docker/Compose (kurze Servicenamen). Kubernetes überschreibt
# beide: nginx wendet auf Namen, die es über den resolver auflöst, die
# search-Domains nicht an und braucht daher voll qualifizierte Servicenamen.
ENV UDP_GATEWAY_UPSTREAM=apisix:9080 \
    UDP_NODERED_UPSTREAM=node-red:1880
EXPOSE 8080
