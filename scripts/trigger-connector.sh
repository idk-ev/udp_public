#!/usr/bin/env bash
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# Triggers a connector's run right away (first fill, or after changes).
# Needed for connectors with refireOnRestart=false (e.g. the weekly Overpass
# sources), which deliberately do not fire right after every restart.
#
#   bash scripts/trigger-connector.sh <connector-id>      e.g. ausflug-bw
#
# Every connector runs in the connector service. The script calls
# POST /trigger/<id> on its ADMIN port (1881). That port is in no Service and
# not published, and /trigger answers loopback peers only - so the request is
# made INSIDE the container:
#   Compose (default): docker exec udp-connectors node -e ...
#   Kubernetes:
#     CONNECTORS_EXEC="kubectl -n <namespace> exec deploy/connectors --" \
#       bash scripts/trigger-connector.sh <id>
# 202 = run started; 429 = cooldown (60 s) or a run is still active;
# 404 = unknown id, inactive, or no module for it.
#
# Environment:
#   CONNECTORS_EXEC      command prefix running a command in the service container
#                        (default: "docker exec udp-connectors")
#
# Exit status: 0 triggered, 1 refused or failed, 2 usage error.
set -euo pipefail

usage() { sed -n '5,26p' "$0" | sed 's/^# \{0,1\}//'; }
case "${1:-}" in
  ""|-h|--help) usage; [ -n "${1:-}" ] && exit 0 || exit 2 ;;
esac
ID="$1"
if ! [[ "$ID" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "error: invalid connector id '$ID'" >&2
  exit 2
fi

read -r -a EXEC <<<"${CONNECTORS_EXEC:-docker exec udp-connectors}"
# Runs inside the container (node is there, curl is not). Prints
# "<status>\t<retry-after>\t<reason>"; status 000 = admin port unreachable.
JS='const id = process.argv[1];
const port = process.env.UDP_CONNECTORS_ADMIN_PORT || "1881";
fetch("http://127.0.0.1:" + port + "/trigger/" + encodeURIComponent(id), { method: "POST" })
  .then(async (r) => {
    const text = (await r.text()).trim();
    let reason = text;
    try { reason = JSON.parse(text).reason ?? text; } catch {}
    process.stdout.write(r.status + "\t" + (r.headers.get("retry-after") ?? "-") + "\t" + reason + "\n");
  })
  .catch((e) => process.stdout.write("000\t-\t" + e.message + "\n"));'
if ! OUT=$("${EXEC[@]}" node -e "$JS" "$ID"); then
  # Only the command name: CONNECTORS_EXEC may carry credentials (a token,
  # a kubeconfig path) that do not belong in a log.
  echo "$ID: cannot reach the connector service container (via ${EXEC[0]})" >&2
  exit 1
fi
IFS=$'\t' read -r CODE RETRY REASON <<<"$OUT"
case "$CODE" in
  202) echo "$ID: triggered in the connector service (HTTP 202)" ;;
  429) echo "$ID: refused (HTTP 429): $REASON - retry in ${RETRY} s" >&2; exit 1 ;;
  404) echo "$ID: not scheduled in the connector service (HTTP 404): $REASON" >&2; exit 1 ;;
  000) echo "$ID: connector service admin port not reachable: $REASON" >&2; exit 1 ;;
  *)   echo "$ID: unexpected answer (HTTP $CODE): $REASON" >&2; exit 1 ;;
esac
