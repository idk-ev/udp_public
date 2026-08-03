#!/usr/bin/env python3
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

"""Erzeugt gui/public/bw-gemeinden.json: alle Gemeinden Baden-Württembergs.

Quellen:
- opendatasoft georef-germany-gemeinde (Namen, Regionalschlüssel, Zentroide, Typ)
- Wikidata (Einwohnerzahlen über den Amtlichen Gemeindeschlüssel, P439/P1082)

Format (kompakte Arrays, ~70 KB):
  { "stand": "...", "gemeinden": [[ags, name, lat, lon, kreis, typ, einwohner, dashboardUrl|null], ...] }
  typ: "S" = Stadt, "G" = Gemeinde, "F" = gemeindefreies Gebiet
"""
import json
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "gui" / "public" / "bw-gemeinden.json"
UA = {"User-Agent": "UDP-Referenzimplementierung/1.0 (Urbane Datenplattform)"}

# Kuratierte Liste öffentlicher Smart-City-Dashboards (Masterplan-Recherche 2026-07)
DASHBOARDS = {
    "08421000": "https://datenhub.ulm.de",                    # Ulm
    "08222000": "https://smartmannheim.de",                   # Mannheim
    "08136088": "https://www.aahdhgemeinsamdigital.de",       # Aalen (MPSC mit Heidenheim)
    "08135019": "https://www.aahdhgemeinsamdigital.de",       # Heidenheim
}

# Die 44 Stadt- und Landkreise BW (Kreisschlüssel -> Name); Gebietsstand seit 1973
# unverändert, daher kuratiert statt aus einer weiteren Quelle geladen.
KREISE = {
    "08111": "Stuttgart", "08115": "Böblingen", "08116": "Esslingen",
    "08117": "Göppingen", "08118": "Ludwigsburg", "08119": "Rems-Murr-Kreis",
    "08121": "Heilbronn", "08125": "Heilbronn", "08126": "Hohenlohekreis",
    "08127": "Schwäbisch Hall", "08128": "Main-Tauber-Kreis", "08135": "Heidenheim",
    "08136": "Ostalbkreis", "08211": "Baden-Baden", "08212": "Karlsruhe",
    "08215": "Karlsruhe", "08216": "Rastatt", "08221": "Heidelberg",
    "08222": "Mannheim", "08225": "Neckar-Odenwald-Kreis", "08226": "Rhein-Neckar-Kreis",
    "08231": "Pforzheim", "08235": "Calw", "08236": "Enzkreis",
    "08237": "Freudenstadt", "08311": "Freiburg im Breisgau", "08315": "Breisgau-Hochschwarzwald",
    "08316": "Emmendingen", "08317": "Ortenaukreis", "08325": "Rottweil",
    "08326": "Schwarzwald-Baar-Kreis", "08327": "Tuttlingen", "08335": "Konstanz",
    "08336": "Lörrach", "08337": "Waldshut", "08415": "Reutlingen",
    "08416": "Tübingen", "08417": "Zollernalbkreis", "08421": "Ulm",
    "08425": "Alb-Donau-Kreis", "08426": "Biberach", "08435": "Bodenseekreis",
    "08436": "Ravensburg", "08437": "Sigmaringen",
}


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def load_georef() -> list[dict]:
    base = "https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/georef-germany-gemeinde/exports/json"
    url = base + "?" + urllib.parse.urlencode({"where": 'lan_name="Baden-Württemberg"'})
    return json.loads(get(url))


def load_populations() -> dict[str, int]:
    query = (
        'SELECT ?ags ?pop WHERE { ?m wdt:P439 ?ags . '
        'FILTER(STRSTARTS(?ags,"08")) . OPTIONAL { ?m wdt:P1082 ?pop } }'
    )
    url = "https://query.wikidata.org/sparql?" + urllib.parse.urlencode(
        {"query": query, "format": "json"})
    data = json.loads(get(url))
    pops: dict[str, int] = {}
    for b in data["results"]["bindings"]:
        ags = b["ags"]["value"]
        if len(ags) != 8:
            continue
        pop = int(float(b["pop"]["value"])) if "pop" in b else None
        # Bei mehreren Angaben die höchste (aktuellste) behalten
        if pop is not None and (ags not in pops or pops[ags] is None or pop > pops[ags]):
            pops[ags] = pop
        pops.setdefault(ags, pop)
    return pops


def rs_to_ags(rs: str) -> str:
    """12-stelliger Regionalschlüssel -> 8-stelliger AGS (Verbandsschlüssel Pos. 6-9 entfällt)."""
    return rs[:5] + rs[9:12]


def main() -> None:
    georef = load_georef()
    pops = load_populations()
    typ_map = {"Stadt": "S", "Gemeinde": "G", "Gemeindefreies Gebiet": "F"}
    rows = []
    for g in georef:
        rs = (g.get("gem_code") or [""])[0]
        name = (g.get("gem_name_short") or g.get("gem_name") or ["?"])[0]
        pt = g.get("geo_point_2d") or {}
        if len(rs) != 12 or not pt:
            print(f"übersprungen: {name} ({rs})", file=sys.stderr)
            continue
        ags = rs_to_ags(rs)
        kreis = ags[:5]
        typ = typ_map.get(g.get("gem_type") or "", "G")
        rows.append([
            ags, name,
            round(pt["lat"], 5), round(pt["lon"], 5),
            kreis, typ,
            pops.get(ags),
            DASHBOARDS.get(ags),
        ])
    rows.sort(key=lambda r: r[0])

    # Slugs (F2): dashboard.example.de/<slug>; Kollisionen -> Kreis-Suffix
    def slugify(name: str) -> str:
        s = name.lower()
        for a_, b_ in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
            s = s.replace(a_, b_)
        s = "".join(c if c.isalnum() else "-" for c in s)
        while "--" in s:
            s = s.replace("--", "-")
        return s.strip("-")

    RESERVED = {"dashboard", "bw", "g", "gateway", "assets", "mitmachen",
                "smartcity", "stadt", "index", "catalog", "cockpit"}
    counts: dict[str, int] = {}
    for r in rows:
        counts[slugify(r[1])] = counts.get(slugify(r[1]), 0) + 1
    taken: set[str] = set()
    for r in rows:
        s = slugify(r[1])
        if counts[s] > 1 or s in RESERVED:
            s = f"{s}-{r[4]}"
        if s in taken:  # z. B. Stadt + gemeindefreies Gebiet gleichen Namens im selben Kreis
            s = f"{slugify(r[1])}-{r[0]}"
        taken.add(s)
        r.append(s)
    # Kreis-Registry: [krs, name, lat, lon, typ(LK|SK), gemeinden, einwohner, slug]
    # Stadtkreise (genau eine Gemeinde) verweisen auf das Dashboard ihrer Stadt.
    kreise = []
    for krs, kname in sorted(KREISE.items()):
        member = [r for r in rows if r[4] == krs]
        if not member:
            continue
        typ = "SK" if len(member) == 1 else "LK"
        slug = member[0][8] if typ == "SK" else "kreis-" + slugify(kname)
        kreise.append([
            krs, kname,
            round(sum(r[2] for r in member) / len(member), 5),
            round(sum(r[3] for r in member) / len(member), 5),
            typ, len(member),
            sum(r[6] or 0 for r in member),
            slug,
        ])

    out = {"stand": date.today().isoformat(), "quelle":
           "opendatasoft georef-germany-gemeinde + Wikidata (P439/P1082)",
           "gemeinden": rows, "kreise": kreise}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n",
                   encoding="utf-8")
    staedte = sum(1 for r in rows if r[5] == "S")
    mit_ew = sum(1 for r in rows if r[6])
    print(f"OK: {len(rows)} Gemeinden ({staedte} Städte, {mit_ew} mit Einwohnerzahl) -> {OUT}")


if __name__ == "__main__":
    main()


# ---------------------------------------------------------------------------
# Punkt-in-Polygon-Grundlage (Masterplan §5 F1): vereinfachte Gemeindegrenzen
# ---------------------------------------------------------------------------
GRENZEN_OUT = Path(__file__).resolve().parent.parent / "gui" / "public" / "bw-grenzen.json"


def _dp(points: list, tol: float) -> list:
    """Douglas-Peucker (rein Python, Toleranz in Grad)."""
    if len(points) < 3:
        return points
    ax, ay = points[0]
    bx, by = points[-1]
    dx, dy = bx - ax, by - ay
    seg2 = dx * dx + dy * dy
    dmax, idx = 0.0, 0
    for i in range(1, len(points) - 1):
        px, py = points[i]
        if seg2 == 0:
            d2 = (px - ax) ** 2 + (py - ay) ** 2
        else:
            t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
            d2 = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2
        if d2 > dmax:
            dmax, idx = d2, i
    if dmax > tol * tol:
        left = _dp(points[: idx + 1], tol)
        right = _dp(points[idx:], tol)
        return left[:-1] + right
    return [points[0], points[-1]]


def generate_grenzen(tol: float = 0.0015) -> None:
    """Lädt geo_shape aller BW-Gemeinden, vereinfacht Außenringe, schreibt bw-grenzen.json."""
    base = "https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/georef-germany-gemeinde/exports/json"
    url = base + "?" + urllib.parse.urlencode(
        {"where": 'lan_name="Baden-Württemberg"', "select": "gem_code,geo_shape"})
    data = json.loads(get(url))
    out = {}
    for g in data:
        rs = (g.get("gem_code") or [""])[0]
        shp = (g.get("geo_shape") or {}).get("geometry") or g.get("geo_shape")
        if len(rs) != 12 or not shp:
            continue
        ags = rs_to_ags(rs)
        geom = shp.get("geometry", shp)
        gtype, coords = geom.get("type"), geom.get("coordinates")
        polys = coords if gtype == "MultiPolygon" else [coords] if gtype == "Polygon" else []
        rings = []
        for poly in polys:
            if not poly:
                continue
            outer = [(round(x, 5), round(y, 5)) for x, y in poly[0]]  # nur Außenring
            simp = _dp(outer, tol)
            if len(simp) >= 4:
                rings.append([[p[0], p[1]] for p in simp])
        if not rings:
            continue
        xs = [p[0] for r in rings for p in r]
        ys = [p[1] for r in rings for p in r]
        out[ags] = {"b": [round(min(xs), 4), round(min(ys), 4), round(max(xs), 4), round(max(ys), 4)],
                    "r": rings}
    GRENZEN_OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8")
    pts = sum(len(r) for v in out.values() for r in v["r"])
    print(f"Grenzen: {len(out)} Gemeinden, {pts} Punkte, {GRENZEN_OUT.stat().st_size // 1024} KB")


if __name__ == "__main__" and "--grenzen" in sys.argv:
    generate_grenzen()
