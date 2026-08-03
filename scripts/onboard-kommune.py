#!/usr/bin/env python3
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

"""Onboarding einer Kommune (Masterplan §5 F3).

Beispiele:
  scripts/onboard-kommune.py tuebingen --adoptiert --theme wald
  scripts/onboard-kommune.py tuebingen --adoptiert --primary "#0e6f5c" --accent "#12a380"
  scripts/onboard-kommune.py tuebingen --official-url https://www.tuebingen.de

Freie Farben werden mit dem Dataviz-Palettenvalidator geprüft (Kachel-
Kontrast weiß >= 3:1); Theme-IDs (F6-Katalog) sind vorvalidiert.
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DASH = ROOT / "gui" / "public" / "dashboards.json"
GEM = ROOT / "gui" / "public" / "bw-gemeinden.json"
THEMES = {"muenster", "wald", "bordeaux", "petrol", "violett", "bernstein", "schiefer"}


def rel_lum(hexcol: str) -> float:
    h = hexcol.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in (r, g, b)]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast_white(hexcol: str) -> float:
    l = rel_lum(hexcol)
    return (1.0 + 0.05) / (l + 0.05)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("slug")
    p.add_argument("--adoptiert", action="store_true",
                   help="Kommune hat das Dashboard offiziell übernommen (blendet den Disclaimer um)")
    p.add_argument("--theme", help="Theme-ID aus dem validierten Katalog (F6)")
    p.add_argument("--primary", help="Kachel-Farbe (Hex), weiße Schrift muss >= 3:1 erreichen")
    p.add_argument("--accent", help="Akzentfarbe (Hex)")
    p.add_argument("--logo-url")
    p.add_argument("--official-url")
    p.add_argument("--kontakt")
    p.add_argument("--link", action="append", default=[], metavar="KEY=URL",
                   help="Kuratierte Link-Kachel (veranstaltungen|maengelmelder|baeder|abfall)")
    args = p.parse_args()

    gem = json.loads(GEM.read_text())["gemeinden"]
    if not any(r[8] == args.slug for r in gem):
        sys.exit(f"Unbekannter Slug: {args.slug}")

    data = json.loads(DASH.read_text())
    k = data["kommunen"].setdefault(args.slug, {})
    if args.adoptiert:
        k["adoptiert"] = True
    branding = k.setdefault("branding", {})
    if args.theme:
        if args.theme not in THEMES:
            sys.exit(f"Unbekanntes Theme (Katalog: {', '.join(sorted(THEMES))})")
        branding["theme"] = args.theme
    if args.primary:
        c = contrast_white(args.primary)
        if c < 3.0:
            sys.exit(f"Validator: Kontrast weiß auf {args.primary} = {c:.2f}:1 (< 3:1) — dunklere Farbe wählen")
        print(f"Validator: Kachel-Kontrast {c:.2f}:1 PASS")
        branding["primary"] = args.primary
    if args.accent:
        branding["accent"] = args.accent
    if not branding:
        k.pop("branding", None)
    if args.logo_url:
        branding["logoUrl"] = args.logo_url
    if args.official_url:
        k["officialUrl"] = args.official_url
    if args.kontakt:
        k["kontakt"] = args.kontakt
    if args.link:
        k.setdefault("links", {}).update(dict(l.split("=", 1) for l in args.link))
    DASH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(f"OK: {args.slug} -> {json.dumps(k, ensure_ascii=False)}")
    print("Danach: npm --prefix gui run build (dist aktualisieren)")


if __name__ == "__main__":
    main()
