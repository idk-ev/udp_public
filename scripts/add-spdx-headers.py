#!/usr/bin/env python3
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

"""Ergänzt fehlende SPDX-Lizenzkopfzeilen in den Quelldateien des Repositorys.

Eingefügt wird je Datei (in der Kommentarsyntax des Dateityps):

    SPDX-License-Identifier: EUPL-1.2
    © 2024–2026 Thomas Kieß and contributors

Das Skript ist idempotent: Dateien, die bereits einen SPDX-Bezeichner tragen,
bleiben unverändert. Shebang-Zeilen, XML-Deklarationen und `<!DOCTYPE>` bleiben
immer die erste Zeile — der Header wird darunter eingefügt.

Bewusst NICHT angefasst:
  * `gui/public/vendor/`   — eingekaufter Fremdcode (Leaflet, BSD-2-Clause).
                             Ein EUPL-Header wäre dort eine falsche Lizenzangabe.
  * `gui/public/g/`        — aus Templates erzeugte Gemeindeseiten. Der Header
                             steht in `scripts/generate-city-pages.py`; er käme
                             beim nächsten Generatorlauf sonst wieder abhanden.
  * JSON und Ableger       — das Format kennt keine Kommentare.
  * `helm/**/NOTES.txt`    — wird Nutzern bei `helm install` angezeigt.
  * Markdown, Lizenztexte, Binärdateien.

Aufruf:
    python3 scripts/add-spdx-headers.py            # schreibt
    python3 scripts/add-spdx-headers.py --check    # nur prüfen (Exit 1 bei Fund)
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

SPDX = "SPDX-License-Identifier: EUPL-1.2"
COPYRIGHT = "© 2024–2026 Thomas Kieß and contributors"

REPO = Path(__file__).resolve().parent.parent

# Kommentarsyntax je Dateityp: (Präfix, Zeilenpräfix, Suffix)
BLOCK = ("/*", " * ", " */")          # C-artig
HASH = (None, "# ", None)             # Shell, Python, YAML, Konfigurationen
XML = ("<!--", "  ", "-->")           # HTML, SVG
SQL = (None, "-- ", None)
GOTPL = ("{{/*", "  ", "*/}}")        # Helm-Templates

BY_SUFFIX = {
    ".js": BLOCK, ".mjs": BLOCK, ".cjs": BLOCK,
    ".ts": BLOCK, ".tsx": BLOCK, ".jsx": BLOCK,
    ".css": BLOCK,
    ".py": HASH, ".sh": HASH, ".bash": HASH,
    ".yml": HASH, ".yaml": HASH, ".conf": HASH, ".template": HASH,
    ".example": HASH, ".ini": HASH, ".toml": HASH,
    ".html": XML, ".htm": XML, ".svg": XML, ".xml": XML,
    ".sql": SQL,
    ".tpl": GOTPL,
}

BY_NAME = {
    "Dockerfile": HASH,
    "pre-commit": HASH,
    "Makefile": HASH,
}

# Pfad-Präfixe, die vollständig übersprungen werden
SKIP_PREFIXES = (
    "gui/public/vendor/",
    "gui/public/g/",
    "gui/dist/",
    "gui/node_modules/",
    "platform/config/masterportal/",
)

SKIP_NAMES = {"LICENSE", "LICENSE.de", "NOTES.txt", ".helmignore", ".gitignore",
              ".dockerignore", ".gitattributes"}

SKIP_SUFFIXES = {".md", ".json", ".webmanifest", ".png", ".jpg", ".jpeg",
                 ".gif", ".ico", ".webp", ".woff", ".woff2", ".ttf", ".zip",
                 ".pdf", ".txt", ".lock"}

# Zeilen, die vor dem Header stehen bleiben müssen
def _leading_lines(lines: list[str], suffix: str) -> int:
    keep = 0
    if lines and lines[0].startswith("#!"):
        keep = 1
    if suffix in (".html", ".htm", ".xml", ".svg"):
        while keep < len(lines):
            stripped = lines[keep].lstrip().lower()
            if stripped.startswith("<?xml") or stripped.startswith("<!doctype"):
                keep += 1
            else:
                break
    return keep


def tracked_files() -> list[Path]:
    out = subprocess.check_output(["git", "ls-files"], cwd=REPO, text=True)
    return [REPO / line for line in out.splitlines() if line]


def style_for(path: Path):
    rel = path.relative_to(REPO).as_posix()
    if any(rel.startswith(p) for p in SKIP_PREFIXES):
        return None
    if path.name in SKIP_NAMES or path.suffix in SKIP_SUFFIXES:
        return None
    # ".json.tpl" u. Ä.: JSON bleibt JSON
    if path.name.endswith(".json.tpl"):
        return None
    if path.name in BY_NAME:
        return BY_NAME[path.name]
    return BY_SUFFIX.get(path.suffix)


def render(style) -> str:
    open_tok, line_pfx, close_tok = style
    parts = []
    if open_tok:
        parts.append(open_tok)
    parts.append(f"{line_pfx}{SPDX}".rstrip())
    parts.append(f"{line_pfx}{COPYRIGHT}".rstrip())
    if close_tok:
        parts.append(close_tok)
    return "\n".join(parts) + "\n"


def process(path: Path, style, write: bool) -> bool:
    """True, wenn ein Header fehlte (und ggf. ergänzt wurde)."""
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, FileNotFoundError):
        return False
    # Nur den Dateikopf prüfen: eine Datei, die den Bezeichner irgendwo im
    # Fließtext erwähnt (etwa dieses Skript), gilt sonst fälschlich als versorgt.
    if "SPDX-License-Identifier" in "\n".join(text.split("\n")[:15]):
        return False

    lines = text.split("\n")
    keep = _leading_lines(lines, path.suffix)
    header = render(style)

    head = "\n".join(lines[:keep])
    tail = "\n".join(lines[keep:])
    if head:
        new = f"{head}\n{header}{tail}"
    else:
        new = f"{header}{tail}"
    # genau eine Leerzeile zwischen Header und Inhalt
    if not tail.startswith("\n") and tail.strip():
        insert_at = len(head) + 1 + len(header) if head else len(header)
        new = new[:insert_at] + "\n" + new[insert_at:]

    if write:
        path.write_text(new, encoding="utf-8")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true",
                    help="nichts schreiben; Exit 1, wenn Header fehlen")
    args = ap.parse_args()

    missing, skipped = [], 0
    for path in tracked_files():
        if not path.is_file():
            continue
        style = style_for(path)
        if style is None:
            skipped += 1
            continue
        if process(path, style, write=not args.check):
            missing.append(path.relative_to(REPO).as_posix())

    verb = "fehlt in" if args.check else "ergänzt in"
    print(f"SPDX-Header {verb} {len(missing)} Datei(en); {skipped} übersprungen.")
    for rel in missing:
        print(f"  {rel}")
    if args.check and missing:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
