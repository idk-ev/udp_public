# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

# APISIX im Standalone-Modus: Routen deklarativ aus apisix.yaml (GitOps-fähig)
apisix:
  node_listen: 9080
  enable_admin: false
  # Status server for the Kubernetes probes: /status (nginx up) and
  # /status/ready (all workers have loaded the route config).
  status:
    ip: 0.0.0.0
    port: 7085

nginx_config:
  # "auto" would count the node's cores, not the container's CPU limit.
  worker_processes: {{ .Values.apisix.workerProcesses }}
  http:
    upstream:
      # Idle keep-alive connections to the backends. Must stay BELOW
      # orionLd.reqTimeout (60 s): otherwise APISIX reuses a socket Orion-LD
      # has just closed and the request fails with 502.
      keepalive: 64
      keepalive_timeout: 30s

deployment:
  role: data_plane
  role_data_plane:
    config_provider: yaml

plugin_attr:
  prometheus:
    export_addr:
      ip: 0.0.0.0
      port: 9091
