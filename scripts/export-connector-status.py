#!/usr/bin/env python3
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

"""Exports the connector registry (platform/config/connectors.json) to
gui/public/connectors-status.json, read by the main dashboard, the city pages
and scripts/healthcheck.sh.

Only the fields the frontend and the monitoring need, one entry per registry
entry in registry order. The connectors themselves run in the connector
service (platform/connectors), which reads the registry directly.
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# The exported fields; a field missing in the registry is exported as null.
FIELDS = ("id", "name", "scope", "enabledFor", "sollMinutes", "sampleEntity",
          "provides", "attribution", "requiresSecret", "active", "supersededBy",
          "pending", "refireOnRestart", "healthUrl")


def main():
    cli = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    cli.add_argument("--registry", default=str(ROOT / "platform" / "config" / "connectors.json"),
                     help="connector registry to read (default: platform/config/connectors.json)")
    cli.add_argument("--status-export", default=str(ROOT / "gui" / "public" / "connectors-status.json"),
                     help="status export to write (default: gui/public/connectors-status.json)")
    args = cli.parse_args()

    with open(args.registry, encoding="utf-8") as f:
        registry = json.load(f)["connectors"]
    status = [{k: c.get(k) for k in FIELDS} for c in registry]
    # "stand" = modification time of the registry, not of this run: otherwise
    # every run would produce a diff although nothing changed.
    stand = datetime.fromtimestamp(Path(args.registry).stat().st_mtime,
                                   timezone.utc).isoformat(timespec="seconds")
    with open(args.status_export, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"stand": stand, "connectors": status}, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"OK: {len(status)} connectors -> {args.status_export}")


if __name__ == "__main__":
    main()
