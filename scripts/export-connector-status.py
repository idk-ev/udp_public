#!/usr/bin/env python3
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

"""Exports the connector registry (platform/config/connectors.json) as two
status files.

  gui/public/connectors-status.json  public, read by the city pages: only the
                                     fields they need, without the platform's
                                     own operations connectors (scope
                                     "betrieb").
  gui/ops/connectors-status.json     complete, read by the main dashboard and
                                     scripts/healthcheck.sh. The cockpit
                                     serves it as /ops/connectors-status.json,
                                     behind the login of /dashboard.html
                                     (platform/config/nginx/cockpit.conf.template).

One entry per registry entry in registry order. The connectors themselves run
in the connector service (platform/connectors), which reads the registry
directly.
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# The exported fields; a field missing in the registry is exported as null.
FIELDS = ("id", "name", "scope", "enabledFor", "sollMinutes", "sampleEntity",
          "provides", "attribution", "attributionLinks", "license", "licenseUrl",
          "requiresSecret", "active", "supersededBy", "pending", "refireOnRestart",
          "healthUrl")
# What the public pages read (gui/public/stadt.html; sampleEntity: the
# Passanten tile asks for it), plus the licence of every source
# (attributionLinks link the credit texts in the page footers; license and
# licenseUrl state the licence machine-readably, docs/api.md). Secret names,
# health URLs, schedules and the pending/superseded states stay in the
# operations export.
PUBLIC_FIELDS = ("id", "name", "enabledFor", "provides", "attribution", "attributionLinks",
                 "license", "licenseUrl", "active", "sampleEntity")
# Operations connectors (host metrics, database statistics): no public use.
PRIVATE_SCOPES = ("betrieb",)


def write(path, stand, connectors):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"stand": stand, "connectors": connectors}, f, ensure_ascii=False, indent=1)
        f.write("\n")


def main():
    cli = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    cli.add_argument("--registry", default=str(ROOT / "platform" / "config" / "connectors.json"),
                     help="connector registry to read (default: platform/config/connectors.json)")
    cli.add_argument("--status-export", default=str(ROOT / "gui" / "public" / "connectors-status.json"),
                     help="public status export to write (default: gui/public/connectors-status.json)")
    cli.add_argument("--ops-export", default=str(ROOT / "gui" / "ops" / "connectors-status.json"),
                     help="complete status export to write (default: gui/ops/connectors-status.json)")
    args = cli.parse_args()

    with open(args.registry, encoding="utf-8") as f:
        registry = json.load(f)["connectors"]
    full = [{k: c.get(k) for k in FIELDS} for c in registry]
    public = [{k: c.get(k) for k in PUBLIC_FIELDS} for c in registry
              if c.get("scope") not in PRIVATE_SCOPES]
    # "stand" = modification time of the registry, not of this run: otherwise
    # every run would produce a diff although nothing changed.
    stand = datetime.fromtimestamp(Path(args.registry).stat().st_mtime,
                                   timezone.utc).isoformat(timespec="seconds")
    Path(args.ops_export).parent.mkdir(parents=True, exist_ok=True)
    write(args.status_export, stand, public)
    write(args.ops_export, stand, full)
    print(f"OK: {len(public)} public / {len(full)} connectors -> {args.status_export}, {args.ops_export}")


if __name__ == "__main__":
    main()
