#!/usr/bin/env bash
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# Triggers a connector's pipeline right away (first fill, or after changes).
# Needed for connectors with refireOnRestart=false (e.g. the weekly Overpass
# sources), which deliberately do not fire on every restart.
#
#   bash scripts/trigger-connector.sh <connector-id>      e.g. ausflug-bw
#
# Where the connector runs comes from the registry (platform/config/connectors.json):
#
#   runtime "nodered" (default)  POST /inject/<node> on the Node-RED admin API
#                                (NODERED_URL, default http://localhost:4900).
#   runtime "app"                POST /trigger/<id> on the connector service's
#                                ADMIN port (1881). That port is in no Service
#                                and not published, and /trigger answers loopback
#                                peers only — so the request is made INSIDE the
#                                container:
#                                  Compose (default): docker exec udp-connectors node -e …
#                                  Kubernetes:
#                                    CONNECTORS_EXEC="kubectl -n <namespace> exec deploy/connectors --" \
#                                      bash scripts/trigger-connector.sh <id>
#                                202 = run started; 429 = cooldown (60 s) or a run
#                                is still active; 404 = not scheduled there.
#
# Environment:
#   CONNECTORS_EXEC      command prefix running a command in the service container
#                        (default: "docker exec udp-connectors")
#   NODERED_URL          Node-RED base URL (default http://localhost:4900)
#   CONNECTORS_REGISTRY  registry to read (default: the one in this checkout;
#                        it must match what the deployed images/flows carry)
#   PYTHON               Python 3 interpreter (default python3)
#
# Exit status: 0 triggered, 1 refused or failed, 2 usage error.
set -euo pipefail

usage() { sed -n '5,35p' "$0" | sed 's/^# \{0,1\}//'; }
case "${1:-}" in
  ""|-h|--help) usage; [ -n "${1:-}" ] && exit 0 || exit 2 ;;
esac
ID="$1"
if ! [[ "$ID" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "error: invalid connector id '$ID'" >&2
  exit 2
fi

read -r -a PY <<<"${PYTHON:-python3}"
REG="${CONNECTORS_REGISTRY:-$(dirname "$0")/../platform/config/connectors.json}"

# "<runtime> <prefix> <prefix> …" of the connector; the id is passed as an
# argument, never spliced into the code. The runtime is checked exactly like the
# generator and the service do it: absent/null = "nodered", else "nodered" or "app".
INFO=$("${PY[@]}" -c '
import json, sys
reg, cid = sys.argv[1], sys.argv[2]
with open(reg, encoding="utf-8") as f:
    entries = json.load(f)["connectors"]
match = [c for c in entries if c["id"] == cid]
if not match:
    sys.exit("error: unknown connector: " + cid)
c = match[0]
runtime = c.get("runtime")
if runtime is None:
    runtime = "nodered"
if runtime not in ("nodered", "app"):
    sys.exit("error: %s: runtime must be \"nodered\" or \"app\", got %r" % (cid, runtime))
print(runtime, *c.get("nodePrefixes", []))
' "$REG" "$ID")
# An array, not word splitting of a string: no glob expansion of the prefixes.
read -r -a FIELDS <<<"$INFO"
RUNTIME="${FIELDS[0]}"
PREFIXES=("${FIELDS[@]:1}")

case "$RUNTIME" in
  app|nodered) ;;
  *) echo "error: $ID: invalid runtime '$RUNTIME'" >&2; exit 1 ;;
esac

if [ "$RUNTIME" = "app" ]; then
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
    429) echo "$ID: refused (HTTP 429): $REASON — retry in ${RETRY} s" >&2; exit 1 ;;
    404) echo "$ID: not scheduled in the connector service (HTTP 404): $REASON" >&2; exit 1 ;;
    000) echo "$ID: connector service admin port not reachable: $REASON" >&2; exit 1 ;;
    *)   echo "$ID: unexpected answer (HTTP $CODE): $REASON" >&2; exit 1 ;;
  esac
  exit 0
fi

# runtime "nodered": fire every inject node of the connector's node prefixes.
NR="${NODERED_URL:-http://localhost:4900}"
for p in ${PREFIXES[@]+"${PREFIXES[@]}"}; do
  NODE=$(curl -s "$NR/flows" | "${PY[@]}" -c '
import json, sys
prefix = sys.argv[1]
print(next((n["id"] for n in json.load(sys.stdin)
            if n.get("type") == "inject" and str(n.get("id", "")).startswith(prefix)), ""))
' "$p")
  [ -n "$NODE" ] || continue
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$NR/inject/$NODE")
  echo "$ID: $NODE triggered in Node-RED (HTTP $code)"
done
