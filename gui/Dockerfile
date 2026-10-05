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
# Pre-compressed copies for gzip_static (cockpit.conf.template): nginx serves
# them as they are instead of compressing the same bytes on every request.
# config.js is left out – Kubernetes mounts its own over it (ConfigMap), and a
# config.js.gz from the image would be served in place of the mounted file.
RUN find dist -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' -o -name '*.json' -o -name '*.svg' \) \
      ! -path dist/config.js -size +1k -exec gzip -9 -k {} +

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
# worker_connections: the image default of 1024 per worker is tight – a
# cache miss on /gateway/ngsi-ld/ holds four connections (client, loopback
# hop in and out, gateway). 4096 per worker; the container's open-file limit
# is far above that. Fails the build if the image's line ever changes.
RUN sed -i 's/^\(\s*worker_connections\s*\)1024;/\14096;/' /etc/nginx/nginx.conf \
 && grep -q 'worker_connections *4096;' /etc/nginx/nginx.conf
# Trusted proxy networks for the client address (UDP_TRUSTED_PROXIES).
COPY --chmod=755 gui/docker/16-udp-realip.envsh /docker-entrypoint.d/16-udp-realip.envsh
# Upstream of /abfahrten and /warnungen.ics (the connector service), checked.
COPY --chmod=755 gui/docker/17-udp-upstreams.envsh /docker-entrypoint.d/17-udp-upstreams.envsh
# Access rule of /dashboard.html: basic auth if an htpasswd file is mounted at
# /etc/nginx/udp-auth/htpasswd, else 404.
COPY --chmod=755 gui/docker/18-udp-dashboard-auth.envsh /docker-entrypoint.d/18-udp-dashboard-auth.envsh

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
    UDP_CONNECTORS_UPSTREAM=connectors:1880
EXPOSE 8080
