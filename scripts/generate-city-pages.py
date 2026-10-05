#!/usr/bin/env python3
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

"""SSG (F2): erzeugt je Kommune gui/public/g/<slug>/index.html — ein kleiner
Stub mit korrektem Title/OG, der das gemeinsame stadt.html-Bundle lädt.
Zusätzlich je Landkreis g/kreis-<slug>/index.html auf Basis von kreis.html;
Stadtkreise haben keine eigene Seite (ihr Slug zeigt auf das Stadt-Dashboard).
Außerdem gui/public/sitemap.xml mit allen diesen Seiten (siehe SITEMAP_ORIGIN)."""
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "gui" / "public"
OUT = ROOT / "g"
# Explicit UTF-8: the platform default (cp1252 on Windows) garbles every umlaut.
_data = json.loads((ROOT / "bw-gemeinden.json").read_text(encoding="utf-8"))
gem = _data["gemeinden"]
kreise = _data.get("kreise", [])
stadt = (ROOT / "stadt.html").read_text(encoding="utf-8")
# Amtliche Websites je AGS, um sie in die Seite zu inlinen (spart je Seite die
# 70-KB-Katalogdatei; s. gemeinde-services.json / Audit Frage 2).
_svc_path = ROOT / "gemeinde-services.json"
_services = json.loads(_svc_path.read_text(encoding="utf-8"))["dienste"] if _svc_path.exists() else {}

if OUT.exists():
    shutil.rmtree(OUT)
OUT.mkdir()

TPL = """<!DOCTYPE html>
<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Smart City {name} — Live-Dashboard</title>
<meta name="description" content="Live-Dashboard für {name}: Wetter, Warnungen, Baustellen, Umwelt-, Mobilitäts- und Energiedaten aus offenen Quellen. Urbane Datenplattform.">
<meta property="og:title" content="Smart City {name}">
<meta property="og:description" content="Offene Live-Daten für {name} ({ew} Einwohner): Wetter, Luft, Mobilität, Energie.">
<meta property="og:type" content="website">
<link rel="canonical" href="/{slug}">
<meta name="theme-color" content="#0074e8">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon">
<script>window.STADT = {stadt_json};</script>
<script>
// Bundle-Loader: gemeinsames Template übernimmt ab hier (Skripte sequenziell!)
fetch("/stadt.html").then(r => {{ if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); }}).then(async html => {{
  const doc = new DOMParser().parseFromString(html, "text/html");
  document.body.innerHTML = doc.body.innerHTML;
  for (const l of doc.querySelectorAll("link[rel=stylesheet], style")) document.head.appendChild(l.cloneNode(true));
  for (const s of doc.querySelectorAll("body script")) {{
    await new Promise((res, rej) => {{
      const n = document.createElement("script");
      if (s.src) {{ n.src = s.src; n.onload = res; n.onerror = res; }}
      else {{ n.textContent = s.textContent; }}
      document.body.appendChild(n);
      if (!s.src) res();
    }});
  }}
}}).catch(() => {{
  // Template not loadable (offline, deploy in progress): say so instead of a blank page.
  document.body.innerHTML = '<p role="alert" style="max-width:640px;margin:12vh auto;padding:0 16px;font:16px/1.5 system-ui,sans-serif">' +
    'Das Dashboard konnte gerade nicht geladen werden. Bitte die Seite in einigen Augenblicken neu laden. ' +
    '<a href="/">Zur Kommunen-Suche</a></p>';
}});
</script>
</head>
<body></body>
</html>
"""

KREIS_TPL = """<!DOCTYPE html>
<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{name} — Live-Dashboard</title>
<meta name="description" content="Kreis-Dashboard {name}: Warnungen, Baustellen, Energie- und Mobilitätsdaten aggregiert über alle {gems} Gemeinden. Urbane Datenplattform.">
<meta property="og:title" content="{name}">
<meta property="og:description" content="Offene Live-Daten für {name} ({ew} Einwohner, {gems} Gemeinden).">
<meta property="og:type" content="website">
<link rel="canonical" href="/{slug}">
<meta name="theme-color" content="#0074e8">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon">
<script>window.KREIS = {{"krs": "{krs}", "slug": "{slug}", "name": {name_json}}};</script>
<script>
// Bundle-Loader: gemeinsames Kreis-Template übernimmt ab hier (Skripte sequenziell!)
fetch("/kreis.html").then(r => {{ if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); }}).then(async html => {{
  const doc = new DOMParser().parseFromString(html, "text/html");
  document.body.innerHTML = doc.body.innerHTML;
  for (const l of doc.querySelectorAll("link[rel=stylesheet], style")) document.head.appendChild(l.cloneNode(true));
  for (const s of doc.querySelectorAll("body script")) {{
    await new Promise((res, rej) => {{
      const n = document.createElement("script");
      if (s.src) {{ n.src = s.src; n.onload = res; n.onerror = res; }}
      else {{ n.textContent = s.textContent; }}
      document.body.appendChild(n);
      if (!s.src) res();
    }});
  }}
}}).catch(() => {{
  // Template not loadable (offline, deploy in progress): say so instead of a blank page.
  document.body.innerHTML = '<p role="alert" style="max-width:640px;margin:12vh auto;padding:0 16px;font:16px/1.5 system-ui,sans-serif">' +
    'Das Dashboard konnte gerade nicht geladen werden. Bitte die Seite in einigen Augenblicken neu laden. ' +
    '<a href="/">Zur Kommunen-Suche</a></p>';
}});
</script>
</head>
<body></body>
</html>
"""


def write(path, text):
    path.write_text(text, encoding="utf-8", newline="\n")


def script_json(value):
    """JSON for an inline <script>: "<" as \\u003c, so no value (e.g. a
    municipality website from gemeinde-services.json) can close the script
    element ("</script>") or open a comment ("<!--"). Same value for JS."""
    return json.dumps(value, ensure_ascii=False).replace("<", "\\u003c")


# Sitemaps need absolute URLs, but the public address of an installation is
# only known where it is deployed. The placeholder is meant to be replaced per
# request by the cockpit nginx (sub_filter on /sitemap.xml and /robots.txt,
# with the scheme and host of the request); unreplaced, crawlers ignore it.
SITEMAP_ORIGIN = "__PUBLIC_ORIGIN__"
paths = ["/"]

n = 0
for row in gem:
    ags, name, _, _, _, _, ew, _, slug = row[:9]
    (OUT / slug).mkdir(exist_ok=True)
    # Vollständige Gemeindezeile + amtliche Website inline: das Template kommt so
    # ohne die großen Katalogdateien (bw-gemeinden.json 92 KB, gemeinde-services.json
    # 70 KB) je Seitenaufruf aus.
    stadt_obj = {"ags": ags, "slug": slug, "name": name, "row": row[:9],
                 "website": _services.get(ags, {}).get("website")}
    write(OUT / slug / "index.html", TPL.format(
        name=name.replace('"', ""), ags=ags, slug=slug,
        ew=f"{ew:,}".replace(",", ".") if ew else "–",
        stadt_json=script_json(stadt_obj)))
    paths.append("/" + slug)
    n += 1

nk = 0
for krs, name, _, _, typ, gems, ew, slug in kreise:
    if typ != "LK":
        continue
    (OUT / slug).mkdir(exist_ok=True)
    anzeige = name if name.lower().endswith("kreis") else "Landkreis " + name
    write(OUT / slug / "index.html", KREIS_TPL.format(
        name=anzeige.replace('"', ""), krs=krs, slug=slug, gems=gems,
        ew=f"{ew:,}".replace(",", ".") if ew else "–",
        name_json=script_json(name)))
    paths.append("/" + slug)
    nk += 1

# Slugs are ASCII ([a-z0-9-]); nothing to escape in the XML.
write(ROOT / "sitemap.xml",
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      + "".join(f"  <url><loc>{SITEMAP_ORIGIN}{p}</loc></url>\n" for p in paths)
      + "</urlset>\n")
print(f"OK: {n} City-Pages + {nk} Kreis-Pages -> {OUT}, sitemap.xml: {len(paths)} URLs")
