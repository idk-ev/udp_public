#!/usr/bin/env bash
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# Releases the blocked prunes of a connector after the source was checked.
# A prune whose share cap blocked it holds back every entity that went
# missing with that loss - never deleted automatically (healthcheck.sh:
# "PRUNE BLOCKED", /healthz stateStore.blockedPrunes). When the loss is real
# (e.g. a provider really left the feed), release it: from the next run on
# the held entities are deleted under the ordinary rules.
#
#   bash scripts/release-prunes.sh <connector-id>      e.g. carsharing-bw
#
# Calls POST /release-prunes/<id> on the connector service's ADMIN port,
# inside the container (loopback only), like trigger-connector.sh:
#   Compose (default): docker exec udp-connectors node -e ...
#   Kubernetes:
#     CONNECTORS_EXEC="kubectl -n <namespace> exec deploy/connectors --" \
#       bash scripts/release-prunes.sh <id>
#
# Exit status: 0 released (or nothing to release), 1 refused or failed, 2 usage error.
set -euo pipefail

usage() { sed -n '5,20p' "$0" | sed 's/^# \{0,1\}//'; }
case "${1:-}" in
  ""|-h|--help) usage; [ -n "${1:-}" ] && exit 0 || exit 2 ;;
esac
ID="$1"
if ! [[ "$ID" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "error: invalid connector id '$ID'" >&2
  exit 2
fi

read -r -a EXEC <<<"${CONNECTORS_EXEC:-docker exec udp-connectors}"
JS='const id = process.argv[1];
const port = process.env.UDP_CONNECTORS_ADMIN_PORT || "1881";
fetch("http://127.0.0.1:" + port + "/release-prunes/" + encodeURIComponent(id), { method: "POST" })
  .then(async (r) => process.stdout.write(r.status + "\t" + (await r.text()).trim().replace(/\s+/g, " ") + "\n"))
  .catch((e) => process.stdout.write("000\t" + e.message + "\n"));'
if ! OUT=$("${EXEC[@]}" node -e "$JS" "$ID"); then
  echo "$ID: cannot reach the connector service container (via ${EXEC[0]})" >&2
  exit 1
fi
IFS=$'\t' read -r CODE BODY <<<"$OUT"
case "$CODE" in
  200) echo "$ID: released ($BODY)" ;;
  *)   echo "$ID: not released (HTTP $CODE): $BODY" >&2; exit 1 ;;
esac
