/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Smart-City-Dashboards — gemeinsame Frontend-Bibliothek (F2).
   Primitive für alle Seiten: Fetch/Temporal, Formatierung, KPI-Kacheln,
   SVG-Zeitreihen mit Crosshair, Balken, Leaflet-Helfer mit Navi-Popups.
   Farben ausschließlich über CSS-Custom-Properties (smartcity-theme.css). */
"use strict";
(function (w) {
  const GW = "/gateway";
  const $ = s => document.querySelector(s);
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const SLOT = () => [css("--series-1"), css("--series-2"), css("--series-3"), css("--series-4"), css("--series-5")];
  let _gcnt = 0;
  const fmtN = n => n == null ? "–" : n.toLocaleString("de-DE");
  const fmtT = t => new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const fmtDay = d => d ? new Date(String(d).slice(0, 10) + "T12:00:00").toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) : "–";
  const val = (e, a) => (e && e[a] && e[a].value != null) ? e[a].value : null;
  // HTML-Maskierung für alles, was aus dem Broker (oder einer anderen entfernten
  // Quelle) in Markup interpoliert wird. Deckt Text- UND Attributkontext ab, weil
  // mehrere Senken in doppelt bzw. einfach quotierten Attributen sitzen.
  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ESC_MAP[c]);
  // href-Werte brauchen zusätzlich eine Schema-Positivliste: Maskierung allein
  // hält "javascript:…" nicht auf, weil es das Attribut gar nicht verlässt.
  // Erlaubt sind http/https und schemalose (relative) Ziele.
  const safeUrl = u => {
    const s = String(u == null ? "" : u).trim();
    if (!s) return "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return /^https?:/i.test(s) ? s : "";
    return /^\s*[/.?#]/.test(s) || !s.includes(":") ? s : "";
  };
  const asArray = v => Array.isArray(v) ? v : (v == null ? [] : [v]); // Orion-LD entpackt 1-elementige Arrays
  // Tupel-Compounds ([[a,b,c], ...]): Orion-LD entpackt eine einzelne Zeile zu
  // [a,b,c] — dann wieder in eine Zeilenliste einbetten.
  const asRows = v => { const a = asArray(v); return a.length && !Array.isArray(a[0]) ? [a] : a; };

  async function jget(url) {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(url.split("?")[0] + " → HTTP " + r.status);
    return r.json();
  }
  const entities = (type, extra) => jget(`${GW}/ngsi-ld/v1/entities?type=${type}&limit=1000${extra || ""}`);
  const entity = id => jget(`${GW}/ngsi-ld/v1/entities/${encodeURIComponent(id)}`).catch(() => null);
  // limit 1000: Großstädte haben mehrere hundert Ladestandorte je Gemeinde.
  // Optionale attrs-Projektion: nur die gebrauchten Felder holen (spart bei
  // dichten Stations-Listen hunderte KB je Seitenaufruf).
  const byAgs = (type, ags, attrs) =>
    jget(`${GW}/ngsi-ld/v1/entities?type=${type}&q=ags%3D%3D%22${ags}%22&limit=1000` +
         (attrs ? `&attrs=${attrs}` : "")).catch(() => []);
  const hist = (id, attrs, hours = 24) => {
    const t = new Date(Date.now() - hours * 3600e3).toISOString();
    return jget(`${GW}/temporal/temporal/entities/${encodeURIComponent(id)}?attrs=${attrs}&timerel=after&timeAt=${t}&options=temporalValues`)
      .catch(() => ({}));
  };
  const series = (t, a) => (t && t[a] && t[a].values ? t[a].values.map(([v, ts]) => [new Date(ts).getTime(), v]) : []);

  /* ---------- KPI-Kachel ---------- */
  function tile(label, value, unit, opts = {}) {
    const status = opts.status ? `<span class="dot" style="background:${opts.status}"></span>` : "";
    const topic = opts.topic ? ` data-topic="${opts.topic}"` : "";
    const explain = opts.explain ? ` data-explain="${esc(opts.explain)}"` : "";
    // Klickbare Kacheln sind per Tastatur bedienbar (BITV): role+tabindex, die
    // Enter/Space-Behandlung sitzt in wireTileDetails.
    const detail = opts.detail ? ` data-detail="${opts.detail}" data-title="${esc(label)}" role="button" tabindex="0"` : "";
    // Zahlen einheitlich deutsch darstellen (Tausenderpunkt, Dezimalkomma):
    // aus 22.4 wird 22,4, aus 1234 wird 1.234. Bereits formatierte Strings
    // (Bereiche wie „25–30“, Uhrzeiten) bleiben unangetastet.
    const shown = typeof value === "number"
      ? value.toLocaleString("de-DE", { maximumFractionDigits: 1 })
      : (value != null ? value : "–");
    // Index-Kacheln (UV, Luftqualität, NO₂, Puls, Luftfeuchte): kompakter Tacho
    // mit Farbsegmenten und Zeigernadel rechts vom Wert.
    const mini = opts.mini ? `<span class="tile-mini">${miniGaugeSvg(opts.mini)}</span>` : "";
    // Wetter-Kachel (Wind): kompakte Windrose mit Richtungspfeil rechts vom Wert.
    const compass = opts.compass ? `<span class="tile-mini">${miniCompassSvg(opts.compass)}</span>` : "";
    // Schadstoff-Kacheln (Feinstaub): farbiges Schwellenband unter dem Wert.
    const band = opts.band ? miniBand(opts.band.v, opts.band.max, opts.band.stops) : "";
    // Ordinale Kacheln (Hitze/Pollen): kompakte Stufenanzeige unter dem Wert.
    const steps = opts.steps ? miniSteps(opts.steps) : "";
    // Temperatur-Kachel: liegendes Thermometer mit Gefühlt-Markierung unter dem Wert.
    const thermo = opts.thermo ? `<span class="mini-thermo-wrap">${miniThermo(opts.thermo.v, opts.thermo.feels, opts.thermo.min, opts.thermo.max)}</span>` : "";
    // label/shown werden maskiert; opts.hint bleibt bewusst roh — mehrere Aufrufer
    // liefern dort gebautes Markup (Marken-Chips, <br>), das an der Baustelle
    // maskiert wird.
    return `<div class="tile"${topic}${explain}${detail}><div class="label">${esc(label)}</div>
      <div class="value">${status}<span class="v-num">${esc(shown)}<span class="unit">${unit || ""}</span></span>${mini}${compass}</div>
      ${band}${steps}${thermo}${opts.hint ? `<div class="hint">${opts.hint}</div>` : ""}</div>`;
  }
  // Kompaktes Schwellenband für die Kachel (CSS-Balken, kein SVG-Skalierungsproblem).
  // stops = [[a,b,color,name], …]; Marker auf dem Momentanwert.
  function miniBand(v, max, stops) {
    const segs = (stops || []).map(s => `<span style="flex:${s[1] - s[0]};background:${s[2]}"></span>`).join("");
    const left = Math.max(0, Math.min(100, v / max * 100));
    return `<span class="mini-band" aria-hidden="true"><span class="mb-track">${segs}</span><span class="mb-mark" style="left:${left.toFixed(1)}%"></span></span>`;
  }
  // Kompaktes Thermometer für die Temperatur-Kachel: liegende Röhre mit Kolben,
  // Füllung bis zum Istwert (temperaturfarben) + Markierung für die gefühlte Temp.
  function miniThermo(v, feels, min, max) {
    min = min == null ? -10 : min; max = max == null ? 40 : max;
    const span = (max - min) || 1, W = 100, H = 16, x0 = 15, x1 = 96, by = 8;
    const sc = t => x0 + (x1 - x0) * Math.max(0, Math.min(1, (t - min) / span));
    const col = t => "hsl(" + Math.round(210 - Math.max(0, Math.min(1, (t + 10) / 50)) * 210) + ",75%,55%)";
    const fx = sc(v), tempC = col(v);
    const feelsMk = feels != null
      ? `<path d="M${sc(feels).toFixed(1)},2 l-2.5,-3 h5 z" fill="#fff"/><line x1="${sc(feels).toFixed(1)}" y1="2" x2="${sc(feels).toFixed(1)}" y2="14" stroke="#fff" stroke-width="1.4"/>` : "";
    return `<svg class="mini-thermo" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" aria-hidden="true">
      <rect x="${x0}" y="${by - 3}" width="${x1 - x0}" height="6" rx="3" fill="rgba(255,255,255,.25)"/>
      <rect x="${x0}" y="${by - 3}" width="${(fx - x0).toFixed(1)}" height="6" rx="3" fill="${tempC}"/>
      <circle cx="9" cy="${by}" r="6" fill="${tempC}"/>
      ${feelsMk}</svg>`;
  }
  // Kompakte Stufenanzeige für ordinale Kacheln (Hitze/Pollen): aktive Stufe voll,
  // übrige gedämpft. o = {level, colors}.
  function miniSteps(o) {
    const segs = (o.colors || []).map((c, i) =>
      `<span style="background:${i === o.level ? c : "rgba(255,255,255,.22)"}"></span>`).join("");
    return `<span class="mini-steps" aria-hidden="true">${segs}</span>`;
  }
  const grade = (v, warn, serious) =>
    v == null ? null : v >= serious ? css("--status-serious") : v >= warn ? css("--status-warn") : css("--status-good");

  /* ---------- SVG-Zeitreihe mit Crosshair-Tooltip ---------- */
  function chart(el, seriesList, opts = {}) {
    const host = typeof el === "string" ? $(el) : el;
    host.innerHTML = "";
    const all = seriesList.flatMap(s => s.data);
    if (!all.length) { host.innerHTML = `<div class="desc">Noch keine Daten (Historie füllt sich)</div>`; return; }
    const W = 640, H = 210, m = { l: 42, r: 10, t: 10, b: 24 };
    const spanH = opts.hours || 24;
    const x1 = Date.now() - spanH * 3600e3, x2 = Date.now();
    let lo = Math.min(...all.map(p => p[1])), hi = Math.max(...all.map(p => p[1]));
    if (opts.zero) lo = Math.min(0, lo);
    const pad = (hi - lo) * 0.12 || 1; lo -= (opts.zero ? 0 : pad); hi += pad;
    const X = t => m.l + (t - x1) / (x2 - x1) * (W - m.l - m.r);
    const Y = v => m.t + (hi - v) / (hi - lo) * (H - m.t - m.b);
    let g = "";
    for (let i = 0; i <= 4; i++) {
      const v = lo + (hi - lo) * i / 4, y = Y(v);
      g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}" stroke="var(--grid)"/>` +
           `<text x="${m.l - 6}" y="${y + 3}" text-anchor="end" font-size="10" fill="var(--text-muted)">${(+v.toFixed(Math.abs(hi) < 10 ? 1 : 0))}</text>`;
    }
    const step = spanH <= 24 ? 6 : spanH <= 48 ? 12 : 24;
    for (let h = 0; h <= spanH; h += step) {
      const t = x1 + h * 3600e3, x = X(t);
      const lbl = spanH > 48 ? new Date(t).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) : fmtT(t);
      g += `<text x="${x}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${lbl}</text>`;
    }
    const baseY = H - m.b;
    let defs = "", areas = "", dots = "";
    const paths = seriesList.map(s => {
      const pts = s.data.filter(p => p[0] >= x1).sort((a, b) => a[0] - b[0]);
      if (!pts.length) return "";
      const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
      // Flächenverlauf nur bei EINER Serie (bei mehreren würde er sich überlagern).
      if (seriesList.length === 1) {
        const gid = "cg" + (_gcnt++);
        defs += `<linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".28"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`;
        areas += `<path d="${d}L${X(pts[pts.length - 1][0]).toFixed(1)},${baseY}L${X(pts[0][0]).toFixed(1)},${baseY}Z" fill="url(#${gid})"/>`;
      }
      const lp = pts[pts.length - 1];
      dots += `<circle cx="${X(lp[0]).toFixed(1)}" cy="${Y(lp[1]).toFixed(1)}" r="3.2" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1.5"/>`;
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>`;
    }).join("");
    host.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs>${defs}</defs>${g}${areas}${paths}${dots}
         <line class="xh" y1="${m.t}" y2="${H - m.b}" stroke="var(--text-muted)" stroke-dasharray="3 3" style="display:none"/>
       </svg><div class="tip"></div>` +
      (seriesList.length > 1
        ? `<div class="legend">${seriesList.map(s => `<span><span class="chip" style="background:${s.color}"></span>${esc(s.name)}</span>`).join("")}</div>`
        : "");
    const svg = host.querySelector("svg"), tip = host.querySelector(".tip"), xh = host.querySelector(".xh");
    // Screenreader-Alternative zum SVG (BITV): Kennwerte je Serie als Tabelle.
    const u = opts.unit || "";
    const zusammenfassung = seriesList.map(s => {
      const v = s.data.map(p => p[1]); if (!v.length) return null;
      return { name: s.name, akt: v[v.length - 1], min: Math.min(...v), max: Math.max(...v) };
    }).filter(Boolean);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Verlaufsdiagramm; Werte als Tabelle darunter." +
      zusammenfassung.map(z => ` ${z.name}: aktuell ${(+z.akt.toFixed(1))}${u}, Minimum ${(+z.min.toFixed(1))}${u}, Maximum ${(+z.max.toFixed(1))}${u}.`).join(""));
    if (zusammenfassung.length) host.insertAdjacentHTML("beforeend",
      `<table class="sr-only"><caption>Kennwerte</caption><thead><tr><th>Reihe</th><th>aktuell</th><th>Minimum</th><th>Maximum</th></tr></thead><tbody>` +
      zusammenfassung.map(z => `<tr><td>${esc(z.name)}</td><td>${(+z.akt.toFixed(1))}${u}</td><td>${(+z.min.toFixed(1))}${u}</td><td>${(+z.max.toFixed(1))}${u}</td></tr>`).join("") +
      `</tbody></table>`);
    // pointer* deckt Maus UND Touch ab — auf dem Smartphone war der Tooltip bisher tot.
    const move = ev => {
      const r = svg.getBoundingClientRect();
      const t = x1 + ((ev.clientX - r.left) / r.width * W - m.l) / (W - m.l - m.r) * (x2 - x1);
      if (t < x1 || t > x2) { tip.style.display = xh.style.display = "none"; return; }
      xh.setAttribute("x1", X(t)); xh.setAttribute("x2", X(t)); xh.style.display = "";
      const rows = seriesList.map(s => {
        const pts = s.data; if (!pts.length) return "";
        let best = pts[0]; for (const p of pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
        return `<div><span style="background:${s.color};display:inline-block;width:10px;height:3px;border-radius:2px;margin-right:5px;vertical-align:middle"></span>${esc(s.name)}: <b>${(+best[1].toFixed(1))}</b>${u}</div>`;
      }).join("");
      tip.innerHTML = `<div style="color:var(--text-muted)">${fmtT(t)}</div>` + rows;
      tip.style.display = "block";
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(ev.clientX - r.left + 14, r.width - tw - 4) + "px";
      tip.style.top = (ev.clientY - r.top - 10) + "px";
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerdown", move);
    svg.addEventListener("pointerleave", () => { tip.style.display = xh.style.display = "none"; });
  }

  /* ---------- SVG-Balken ---------- */
  function barSvg(el, rows, opts = {}) {
    const host = typeof el === "string" ? $(el) : el;
    if (!rows || !rows.length) { host.innerHTML = `<div class="desc">Noch keine Daten</div>`; return; }
    const W = 640, H = 190, m = { l: 8, r: 8, t: 12, b: 22 };
    const hi = Math.max(...rows.map(r => r[1])) || 1;
    const bw = (W - m.l - m.r) / rows.length;
    const gid = "bg" + (_gcnt++);
    let s = `<defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--series-1)"/><stop offset="1" stop-color="var(--series-1)" stop-opacity=".55"/></linearGradient></defs>`;
    rows.forEach((r, i) => {
      const h = (H - m.t - m.b) * r[1] / hi, x = m.l + i * bw;
      s += `<rect x="${(x + bw * 0.12).toFixed(1)}" y="${(H - m.b - h).toFixed(1)}" width="${(bw * 0.76).toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="url(#${gid})"><title>${esc(r[0])}: ${fmtN(r[1])}${opts.unit || ""}</title></rect>`;
      if (i % Math.ceil(rows.length / 9) === 0)
        s += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle" font-size="9" fill="var(--text-muted)">${esc(opts.xLabel ? opts.xLabel(r[0]) : r[0])}</text>`;
      if (rows.length <= 9)
        s += `<text x="${(x + bw / 2).toFixed(1)}" y="${(H - m.b - h - 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="var(--text-secondary)">${r[1] >= 1000 ? Math.round(r[1] / 1000) + "k" : r[1]}</text>`;
    });
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${s}</svg>`;
  }

  /* ---------- Gestapelter 100%-Balken (Sprint 3.7) ---------- */
  function stackBar(el, segments, opts = {}) {
    const host = typeof el === "string" ? $(el) : el;
    const total = segments.reduce((s, x) => s + (x.value || 0), 0);
    if (!total) { host.innerHTML = `<div class="desc">Noch keine Daten</div>`; return; }
    let x = 0, rects = "";
    for (const seg of segments) {
      const w = seg.value / total * 100;
      if (w > 0) rects += `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="26" fill="${seg.color}"><title>${esc(seg.label)}: ${fmtN(seg.value)}${opts.unit || ""}</title></rect>`;
      x += w;
    }
    host.innerHTML =
      `<svg viewBox="0 0 100 26" preserveAspectRatio="none" style="width:100%;height:34px;border-radius:8px;display:block">${rects}</svg>` +
      `<div class="legend">${segments.filter(s => s.value > 0).map(s =>
        `<span><span class="chip" style="background:${s.color}"></span>${esc(s.label)} (${fmtN(s.value)})</span>`).join("")}</div>`;
  }

  /* ---------- Basiskarte ---------- */
  // basemap.de (BKG, dl-de/by-2-0) statt OSM-Kacheln: die OSMF-Tile-Policy
  // untersagt produktive Nutzung. WMS statt WMTS, weil basemap.de die
  // ADV-Kachelmatrix mit eigenem Ursprung nutzt (nicht XYZ-kompatibel).
  // Fällt bei wiederholten Kachelfehlern auf OSM zurück, damit die Karte
  // nie leer bleibt.
  const BM_ATTR = '© <a href="https://basemap.de/">basemap.de</a> / BKG (dl-de/by-2-0)';
  const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL)';
  function baseLayer(map) {
    const bm = L.tileLayer.wms("https://sgx.geodatenzentrum.de/wms_basemapde", {
      layers: "de_basemapde_web_raster_farbe", format: "image/png",
      transparent: false, version: "1.3.0", maxZoom: 19, attribution: BM_ATTR,
    });
    let fehler = 0;
    bm.on("tileerror", () => {
      if (++fehler !== 6) return;               // vereinzelte Aussetzer ignorieren
      map.removeLayer(bm);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        { maxZoom: 19, attribution: OSM_ATTR }).addTo(map);
    });
    return bm.addTo(map);
  }

  /* ---------- Leaflet-Helfer ---------- */
  // lat/lon landen in href-Attributen: numerisch erzwingen, damit eine nicht-
  // numerische Koordinate aus dem Broker das Attribut nicht verlassen kann.
  const navLinks = it => {
    const la = Number(it.lat), lo = Number(it.lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return "";
    return `<a class="navlink" href="geo:${la},${lo}?q=${la},${lo}(${encodeURIComponent(it.name || "Ziel")})">📍 Im Navi öffnen</a> · ` +
      `<a class="navlink" href="https://www.google.com/maps/dir/?api=1&destination=${la},${lo}" target="_blank" rel="noopener">Route (Google Maps)</a>`;
  };
  // Popup mit optionalem „Verlauf/Details ansehen“-Link, wenn die Ebene eine
  // Detailansicht hat (gr.detail = Registry-Schlüssel). Der Klick wird auf der
  // Kartenebene delegiert abgefangen (openDetailByKey).
  // it.extra bleibt bewusst roh: die Aufrufer bauen dort mehrzeiliges Markup
  // (<br>, farbige Spans) und maskieren die Broker-Anteile an der Baustelle.
  // gr.name wird mitmaskiert: seit der E-Scooter-Ebene stammen Gruppennamen
  // (Anbieter) aus dem Broker und nicht mehr nur aus Literalen im Code.
  const popupHtml = (gr, it) => `<b>${esc(it.name)}</b><br>${esc(gr.name)}${it.extra ? "<br>" + it.extra : ""}<br>${navLinks(it)}` +
    (gr.detail ? `<br><a class="pop-detail" href="#d=${gr.detail}" data-detail="${gr.detail}">📈 Verlauf/Details ansehen →</a>` : "");
  const openDetailByKey = key => { if (_detailReg[key]) openDetail(_detailReg[key], key); };
  const groupColor = (gr, i) => gr.color || SLOT()[i % SLOT().length];
  // Symbol-Marker: das Symbol DIREKT auf der Karte (kein farbiger Kreis darunter).
  // Weißer Umriss macht es auf der Basiskarte lesbar; die Ebenenfarbe kommt als
  // dezenter farbiger Schein (drop-shadow), nicht als Fläche. CSP-konform.
  const markerIcon = (color, sym, big) => L.divIcon({
    className: "", iconSize: [big ? 30 : 24, big ? 30 : 24],
    iconAnchor: [big ? 15 : 12, big ? 15 : 12], popupAnchor: [0, big ? -14 : -11],
    html: `<div class="mkr${big ? " mkr-big" : ""}"${color ? ` style="filter:drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 3px ${color})"` : ""}>${sym || "•"}</div>`,
  });
  const pos = e => {
    const c = e && e.location && e.location.value && e.location.value.coordinates;
    return c ? { lon: c[0], lat: c[1] } : null;
  };

  /* ---------- F6: Theme-Selektor ---------- */
  const THEMES = [
    ["", "Münster-Blau", "#0066cc"], ["wald", "Wald", "#1e7a4f"],
    ["bordeaux", "Bordeaux", "#8e2b47"], ["petrol", "Petrol", "#0f766e"],
    ["violett", "Violett", "#5b46a8"], ["bernstein", "Bernstein", "#a85f00"],
    ["schiefer", "Schiefer", "#46586a"],
  ];
  function themeKey() { return "sc-theme:" + location.pathname.replace(/\/$/, ""); }
  function applyTheme(theme, mode) {
    const de = document.documentElement;
    if (theme) de.dataset.theme = theme; else delete de.dataset.theme;
    if (mode === "dark" || mode === "light") de.dataset.mode = mode; else delete de.dataset.mode;
    document.dispatchEvent(new CustomEvent("sc-theme-changed"));
  }
  function initTheme(kommuneDefault) {
    const urlTheme = new URLSearchParams(location.search).get("theme");
    const stored = localStorage.getItem(themeKey());
    const mode = localStorage.getItem("sc-mode") || "";
    const theme = urlTheme != null ? urlTheme : (stored != null ? stored : (kommuneDefault || ""));
    applyTheme(theme, mode);
    return { theme, mode };
  }
  function themeSelector(mountSel, kommuneDefault) {
    const state = initTheme(kommuneDefault);
    const mount = typeof mountSel === "string" ? $(mountSel) : mountSel;
    if (!mount) return;
    const el = document.createElement("div");
    el.className = "themesel";
    el.innerHTML = `<button type="button" title="Farbschema & Modus" aria-label="Farbschema wählen">🎨</button>
      <div class="pop">
        <div style="font-size:.82rem;font-weight:600">Farbschema</div>
        <div class="row">${THEMES.map(([id, name, c]) =>
          `<div class="sw${id === state.theme ? " active" : ""}" data-t="${id}" title="${name}" style="background:${c}"></div>`).join("")}</div>
        <div style="font-size:.82rem;font-weight:600">Hell / Dunkel</div>
        <div class="row">${[["", "Auto"], ["light", "Hell"], ["dark", "Dunkel"]].map(([m, n]) =>
          `<button type="button" class="mode${m === state.mode ? " active" : ""}" data-m="${m}">${n}</button>`).join("")}</div>
        <div class="note">Kommunen können ein eigenes Standard-Schema festlegen — <a href="/mitmachen.html">mitmachen</a>. Alle Schemata sind kontrast- und farbfehlsichtigkeitsgeprüft.</div>
      </div>`;
    mount.appendChild(el);
    el.querySelector("button").addEventListener("click", () => el.classList.toggle("open"));
    document.addEventListener("click", ev => { if (!ev.target.closest(".themesel")) el.classList.remove("open"); });
    el.addEventListener("click", ev => {
      const sw = ev.target.closest(".sw"), md = ev.target.closest(".mode");
      if (sw) {
        el.querySelectorAll(".sw").forEach(x => x.classList.toggle("active", x === sw));
        localStorage.setItem(themeKey(), sw.dataset.t);
        applyTheme(sw.dataset.t, localStorage.getItem("sc-mode") || "");
      }
      if (md) {
        el.querySelectorAll(".mode").forEach(x => x.classList.toggle("active", x === md));
        localStorage.setItem("sc-mode", md.dataset.m);
        applyTheme(document.documentElement.dataset.theme || "", md.dataset.m);
      }
    });
  }

  /* ---------- B3: Detail-Modal (Zeitreihen / Balken / Stationskarten) ----------
     Generisch für ALLE Seiten. Kachel trägt data-detail="<key>"; die Seite füllt
     eine Registry key -> def und ruft wireTileDetails(registry). def.kind:
       "chart"    { series:[{id,attr,name,factor?}], unit?, zero?, ranges? }
       "bars"     { rows:[[label,val]], unit?, xLabel?, note? }
       "stations" { center:[lat,lon], groups:[{name,color?,items:[{lat,lon,name,extra?}]}], bars?, list?[] } */
  let _modalMap = null, _detailReg = {};
  function detailModal() {
    if ($("#sc-modal")) return;
    document.body.insertAdjacentHTML("beforeend",
      `<div id="sc-modal-backdrop"></div>
       <div id="sc-modal" role="dialog" aria-modal="true">
         <button class="m-close" id="sc-modal-close" aria-label="Schließen">✕</button>
         <h3 id="sc-modal-title"></h3>
         <div class="m-meta" id="sc-modal-meta"></div>
         <div class="m-explain" id="sc-modal-explain"></div>
         <div id="sc-modal-body"></div>
       </div>`);
    $("#sc-modal-close").addEventListener("click", closeModal);
    $("#sc-modal-backdrop").addEventListener("click", closeModal);
    document.addEventListener("keydown", ev => { if (ev.key === "Escape" && modalOpen()) closeModal(); });
    // Fokus-Falle (BITV): Tab bleibt im Dialog, solange er offen ist.
    $("#sc-modal").addEventListener("keydown", ev => {
      if (ev.key !== "Tab") return;
      const f = [...$("#sc-modal").querySelectorAll('button, a[href], input, [tabindex]:not([tabindex="-1"])')]
        .filter(el => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    });
  }
  let _modalOpener = null;
  function closeModal() {
    const m = $("#sc-modal"); if (!m) return;
    m.classList.remove("open"); $("#sc-modal-backdrop").classList.remove("open");
    if (_modalMap) { _modalMap.remove(); _modalMap = null; }
    $("#sc-modal-body").innerHTML = "";
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    // Fokus zur öffnenden Kachel zurückgeben (BITV).
    if (_modalOpener && _modalOpener.focus) { try { _modalOpener.focus(); } catch (e) {} }
    _modalOpener = null;
    document.dispatchEvent(new CustomEvent("sc-modal-closed"));
  }
  const modalOpen = () => { const m = $("#sc-modal"); return !!(m && m.classList.contains("open")); };

  function modalMapFrom(groups, center, height = 380) {
    $("#sc-modal-body").insertAdjacentHTML("beforeend", `<div id="modal-map" style="height:${height}px"></div>`);
    _modalMap = L.map("modal-map", { scrollWheelZoom: true }).setView(center || [48.5, 9.2], 13);
    baseLayer(_modalMap);
    const pts = [], seen = {};
    const lonStretch = center ? 1 / Math.cos(center[0] * Math.PI / 180) : 1.5;
    // Je Ebene ein eigener Marker-Layer, damit die Legende sie an/aus schalten kann.
    const layers = groups.map((gr, i) => {
      const lg = L.layerGroup();
      (gr.items || []).forEach(it => {
        if (it.lat == null) return;
        // deckungsgleiche Marker im Kreis auffächern (goldener Winkel) — wie auf der
        // Hauptkarte, damit dichte Stapel nicht übereinanderliegen
        const k = it.lat.toFixed(4) + "/" + it.lon.toFixed(4);
        const n = seen[k] = (seen[k] || 0) + 1;
        let ll = [it.lat, it.lon];
        if (n > 1) {
          const r = 0.00055 * Math.ceil(Math.sqrt(n)), a = n * 2.399963;
          ll = [it.lat + r * Math.cos(a), it.lon + r * lonStretch * Math.sin(a)];
        }
        pts.push(ll);
        const sym = it.sym || gr.sym;
        const m = sym
          ? L.marker(ll, { icon: markerIcon(it.color || groupColor(gr, i), sym), keyboard: false })
          : L.circleMarker(ll, { radius: 6, weight: 1.6, color: "#fff", fillColor: it.color || groupColor(gr, i), fillOpacity: 0.95 });
        m.bindPopup(popupHtml(gr, it)).addTo(lg);
      });
      lg.addTo(_modalMap);
      return lg;
    });
    if (pts.length) _modalMap.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
    setTimeout(() => _modalMap && _modalMap.invalidateSize(), 80);
    // Legende: ab zwei benannten Ebenen als An/Aus-Filter (klickbar), sonst als
    // reiner Symbol-Schlüssel (z. B. Versorgung je Einrichtungsart).
    const named = groups.filter(g => g.name && (g.items || []).length);
    if (named.length >= 2) {
      const host = document.createElement("div");
      host.className = "map-legend"; host.style.marginTop = "6px";
      host.innerHTML = groups.map((g, i) => {
        if (!g.name || !(g.items || []).length) return "";
        const sym = (g.items[0] && g.items[0].sym) || g.sym || "•";
        return `<span class="leg-item" data-gi="${i}" role="button" tabindex="0" aria-pressed="true" title="Ein-/Ausblenden"><span class="leg-sym">${sym}</span>${esc(g.name)} (${g.items.length})</span>`;
      }).join("");
      const toggle = span => {
        const i = +span.dataset.gi, lg = layers[i], on = !span.classList.contains("off");
        if (on) { _modalMap.removeLayer(lg); span.classList.add("off"); span.setAttribute("aria-pressed", "false"); }
        else { lg.addTo(_modalMap); span.classList.remove("off"); span.setAttribute("aria-pressed", "true"); }
      };
      host.addEventListener("click", e => { const s = e.target.closest(".leg-item[data-gi]"); if (s) toggle(s); });
      host.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { const s = e.target.closest(".leg-item[data-gi]"); if (s) { e.preventDefault(); toggle(s); } } });
      $("#sc-modal-body").appendChild(host);
    } else {
      const seenSym = new Map();
      groups.forEach(gr => (gr.items || []).forEach(it => {
        const s = it.sym || gr.sym; if (!s) return;
        const lbl = it.legend || (gr.items.some(x => x.extra && x.extra !== it.extra) ? it.extra : null) || gr.name || "";
        if (!seenSym.has(s)) seenSym.set(s, lbl);
      }));
      if (seenSym.size > 1 || (seenSym.size === 1 && groups.some(g => (g.items || []).some(i => i.extra)))) {
        const leg = [...seenSym].map(([s, lbl]) => `<span class="leg-item"><span class="leg-sym">${s}</span>${esc(lbl)}</span>`).join("");
        $("#sc-modal-body").insertAdjacentHTML("beforeend", `<div class="map-legend leg-key" style="margin-top:6px">${leg}</div>`);
      }
    }
  }

  async function renderChartRange(def, hours) {
    const wrap = $("#sc-modal-body").querySelector(".m-chartwrap");
    wrap.innerHTML = `<div class="desc">lädt…</div>`;
    const slot = SLOT();
    const ts = await Promise.all(def.series.map(s => hist(s.id, s.attr, hours)));
    const seriesList = def.series.map((s, i) => {
      let data = series(ts[i], s.attr);
      if (s.factor) data = data.map(([x, v]) => [x, v * s.factor]);
      return { name: s.name, color: slot[i % slot.length], data };
    });
    wrap.innerHTML = `<div class="chart" id="modal-chart"></div>`;
    chart("#modal-chart", seriesList, { unit: def.unit, hours, zero: def.zero });
    _lastSeries = seriesList;
  }
  let _lastSeries = null;                 // für den Export: zuletzt gezeichnete Reihen

  /* ---------- Grafische Momentanwert-Bausteine (reines Inline-SVG) ----------
     Alle erben die Design-Tokens der Plattform, brauchen keine Historie und
     bleiben barrierearm: Farbe nie allein, immer Zahl + Klartextstufe. */
  const _pol = (cx, cy, r, deg) => { const a = deg * Math.PI / 180; return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; };
  const _arc = (cx, cy, r, d1, d2) => {                 // gesampelte Bogen-Polylinie (robust)
    let s = "", n = 40;
    for (let i = 0; i <= n; i++) { const p = _pol(cx, cy, r, d1 + (d2 - d1) * i / n); s += (i ? "L" : "M") + p[0].toFixed(2) + "," + p[1].toFixed(2); }
    return s;
  };
  const _ang = f => 180 - 180 * Math.max(0, Math.min(1, f));   // Wert-Anteil -> Zeigerwinkel (Halbkreis oben)

  // Halbkreis-Gauge für Indizes/Grenzwerte. o = {v,min,max,unit,stops:[[a,b,color,label]],state,threshold,flip}
  // flip=true dreht die Skala (Maximum links) — für Indizes, bei denen „hoch = gut"
  // ist, damit auch dort Grün links und Rot rechts steht.
  function gaugeSvg(o) {
    const W = 220, H = 150, cx = W / 2, cy = 122, r = 88, sw = 15, span = (o.max - o.min) || 1;
    const ang = v => _ang(o.flip ? (o.max - v) / span : (v - o.min) / span);
    let seg = "";
    (o.stops || []).forEach(s => {
      seg += `<path d="${_arc(cx, cy, r, ang(s[0]), ang(s[1]))}" fill="none" stroke="${s[2]}" stroke-width="${sw}"/>`;
    });
    let mark = "";
    if (o.threshold != null) {
      const a = ang(o.threshold), pi = _pol(cx, cy, r - sw / 2 - 2, a), po = _pol(cx, cy, r + sw / 2 + 3, a);
      mark = `<line x1="${pi[0].toFixed(1)}" y1="${pi[1].toFixed(1)}" x2="${po[0].toFixed(1)}" y2="${po[1].toFixed(1)}" stroke="var(--text-primary)" stroke-width="2"/>`;
    }
    const av = ang(o.v), tip = _pol(cx, cy, r - 2, av), bl = _pol(cx, cy, 7, av - 90), br = _pol(cx, cy, 7, av + 90);
    const cat = (o.stops || []).filter(s => o.v >= s[0] && o.v < s[1])[0];
    const state = o.state || (cat ? cat[3] : "");
    return `<div class="viz-gauge"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${o.label || ""} ${o.v}${o.unit || ""} ${state}">
      ${seg}${mark}
      <path d="M${bl[0].toFixed(1)},${bl[1].toFixed(1)}L${tip[0].toFixed(1)},${tip[1].toFixed(1)}L${br[0].toFixed(1)},${br[1].toFixed(1)}Z" fill="var(--text-primary)"/>
      <circle cx="${cx}" cy="${cy}" r="6.5" fill="var(--text-primary)"/>
      <text x="${cx}" y="${cy - 24}" text-anchor="middle" font-size="30" font-weight="800" fill="var(--text-primary)">${fmtN(o.v)}</text>
      ${o.unit ? `<text x="${cx}" y="${cy - 8}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--text-secondary)">${o.unit}</text>` : ""}
      <text x="${cx - r}" y="${cy + 18}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${o.flip ? o.max : o.min}</text>
      <text x="${cx + r}" y="${cy + 18}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${o.flip ? o.min : o.max}</text>
    </svg><div class="viz-state"${cat ? ` style="color:${cat[2]}"` : ""}>${state}</div></div>`;
  }

  // Windkompass. o = {deg (Herkunft, met.), speed, unit}
  function compassSvg(o) {
    const S = 150, c = S / 2, r = 58;
    const col = o.speed >= 62 ? "var(--status-serious)" : o.speed >= 29 ? "#f97316" : o.speed >= 12 ? "var(--status-warn)" : "var(--status-good)";
    const frac = Math.min(1, o.speed / 60), fromDeg = 90 - o.deg;
    const tail = _pol(c, c, r - 30, fromDeg), head = _pol(c, c, r - 30, fromDeg + 180);
    const h1 = _pol(head[0], head[1], 11, fromDeg + 180 + 140), h2 = _pol(head[0], head[1], 11, fromDeg + 180 - 140);
    const dirs = ["N", "O", "S", "W"].map((l, i) => { const p = _pol(c, c, r - 20, 90 - i * 90); return `<text x="${p[0].toFixed(1)}" y="${(p[1] + 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="var(--text-muted)">${l}</text>`; }).join("");
    const dirName = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"][Math.round(o.deg / 45) % 8];
    return `<div class="viz-gauge"><svg viewBox="0 0 ${S} ${S}" role="img" aria-label="Wind ${o.speed} ${o.unit} aus ${dirName}">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--grid)" stroke-width="10"/>
      <path d="${_arc(c, c, r, 90, 90 - 360 * frac)}" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round"/>
      ${dirs}
      <line x1="${tail[0].toFixed(1)}" y1="${tail[1].toFixed(1)}" x2="${head[0].toFixed(1)}" y2="${head[1].toFixed(1)}" stroke="${col}" stroke-width="4" stroke-linecap="round"/>
      <path d="M${head[0].toFixed(1)},${head[1].toFixed(1)}L${h1[0].toFixed(1)},${h1[1].toFixed(1)}L${h2[0].toFixed(1)},${h2[1].toFixed(1)}Z" fill="${col}"/>
      <text x="${c}" y="${c - 1}" text-anchor="middle" font-size="22" font-weight="800" fill="var(--text-primary)">${fmtN(o.speed)}</text>
      <text x="${c}" y="${c + 14}" text-anchor="middle" font-size="10" font-weight="600" fill="var(--text-secondary)">${o.unit}</text>
    </svg><div class="viz-state">aus ${dirName}</div></div>`;
  }

  // Schwellenband für Schadstoffe. o = {v,max,unit,label,stops:[[a,b,color,name]],threshold}
  function thresholdBar(o) {
    const W = 240, H = 96, x0 = 8, x1 = W - 8, y = 46, h = 20, sc = v => x0 + (x1 - x0) * Math.max(0, Math.min(1, v / o.max));
    let seg = "", ticks = "";
    (o.stops || []).forEach(s => {
      seg += `<rect x="${sc(s[0]).toFixed(1)}" y="${y}" width="${(sc(s[1]) - sc(s[0]) - 1.5).toFixed(1)}" height="${h}" rx="2" fill="${s[2]}"/>`;
      ticks += `<text x="${sc(s[0]).toFixed(1)}" y="${y + h + 13}" font-size="8.5" fill="var(--text-muted)">${s[0]}</text>`;
    });
    const mx = sc(o.v), cat = (o.stops || []).filter(s => o.v >= s[0] && o.v < s[1])[0] || (o.stops || [])[o.stops.length - 1];
    const thr = o.threshold != null ? `<line x1="${sc(o.threshold).toFixed(1)}" y1="${y - 5}" x2="${sc(o.threshold).toFixed(1)}" y2="${y + h + 4}" stroke="var(--text-primary)" stroke-width="1.5" stroke-dasharray="2 2"/>` : "";
    return `<div class="viz-band"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${o.label} ${o.v} ${o.unit} ${cat ? cat[3] : ""}">
      <text x="${x0}" y="20" font-size="11" font-weight="600" fill="var(--text-secondary)">${o.label}</text>
      <text x="${x1}" y="20" text-anchor="end" font-size="17" font-weight="800" fill="var(--text-primary)">${fmtN(o.v)} ${o.unit}</text>
      ${seg}${thr}${ticks}
      <text x="${x1}" y="${y + h + 13}" text-anchor="end" font-size="8.5" fill="var(--text-muted)">${o.max}</text>
      <path d="M${mx.toFixed(1)},${(y - 3)}l-6,-9 l12,0 Z" fill="var(--text-primary)"/>
      <line x1="${mx.toFixed(1)}" y1="${y - 3}" x2="${mx.toFixed(1)}" y2="${y + h + 3}" stroke="var(--text-primary)" stroke-width="2"/>
    </svg><div class="viz-state"${cat ? ` style="color:${cat[2]}"` : ""}>${cat ? "● " + cat[3] : ""}</div></div>`;
  }

  // Thermometer für Momentantemperatur. o = {v,min,max,feels,unit}. Zahlwerte an
  // festen Positionen rechts (Istwert oben, gefühlt darunter) — überlagern sich nie.
  function thermoSvg(o) {
    const W = 172, H = 150, x = 38, top = 16, bot = 112, span = (o.max - o.min) || 1;
    const frac = Math.max(0, Math.min(1, (o.v - o.min) / span));
    const col = "hsl(" + Math.round(210 - Math.max(0, Math.min(1, (o.v + 10) / 50)) * 210) + ",72%,50%)";
    const fillTop = bot - (bot - top) * frac, tx = x + 26;
    let feels = "";
    if (o.feels != null) {
      const fy = bot - (bot - top) * Math.max(0, Math.min(1, (o.feels - o.min) / span));
      feels = `<line x1="${x + 9}" y1="${fy.toFixed(1)}" x2="${x + 17}" y2="${fy.toFixed(1)}" stroke="var(--text-secondary)" stroke-width="2"/>
        <text x="${tx}" y="98" font-size="12" font-weight="600" fill="var(--text-secondary)">gefühlt ${fmtN(o.feels)}°</text>`;
    }
    return `<div class="viz-gauge"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Temperatur ${fmtN(o.v)} ${o.unit || "°C"}${o.feels != null ? ", gefühlt " + fmtN(o.feels) + "°" : ""}">
      <rect x="${x - 7}" y="${top}" width="14" height="${bot - top}" rx="7" fill="var(--surface-2)" stroke="var(--border)"/>
      <rect x="${x - 7}" y="${fillTop.toFixed(1)}" width="14" height="${(bot - fillTop).toFixed(1)}" rx="7" fill="${col}"/>
      <circle cx="${x}" cy="${bot + 8}" r="15" fill="${col}"/>
      ${feels}
      <text x="${tx}" y="70" font-size="30" font-weight="800" fill="var(--text-primary)">${fmtN(o.v)}°</text>
    </svg></div>`;
  }

  // Kompakter Tacho für Index-Kacheln — voller Halbkreis mit Farbsegmenten und
  // Zeigernadel wie in der Detailansicht. o = {v,min,max,stops:[[a,b,color,label]],flip}.
  function miniGaugeSvg(o) {
    const W = 76, H = 46, cx = W / 2, cy = 41, r = 32, sw = 8, span = (o.max - o.min) || 1;
    const ang = v => _ang(o.flip ? (o.max - v) / span : (v - o.min) / span);
    // Grundbogen (leicht durchscheinend) + farbige Kategoriensegmente
    let seg = `<path d="${_arc(cx, cy, r, 180, 0)}" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="${sw}" stroke-linecap="round"/>`;
    (o.stops || []).forEach(s => {
      seg += `<path d="${_arc(cx, cy, r, ang(s[0]), ang(s[1]))}" fill="none" stroke="${s[2]}" stroke-width="${sw}"/>`;
    });
    const av = ang(o.v), tip = _pol(cx, cy, r - 1, av), bl = _pol(cx, cy, 4.5, av - 90), br = _pol(cx, cy, 4.5, av + 90);
    return `<svg class="mini-gauge" viewBox="0 0 ${W} ${H}" aria-hidden="true">${seg}
      <path d="M${bl[0].toFixed(1)},${bl[1].toFixed(1)}L${tip[0].toFixed(1)},${tip[1].toFixed(1)}L${br[0].toFixed(1)},${br[1].toFixed(1)}Z" fill="#fff"/>
      <circle cx="${cx}" cy="${cy}" r="3.4" fill="#fff"/></svg>`;
  }
  // Kompakte Radial-Miniatur (Restnutzung/Fallback ohne Kategorienfarben).
  function miniRadialSvg(v, min, max) {
    const f = Math.max(0, Math.min(1, (v - min) / ((max - min) || 1)));
    const col = f < .3 ? "var(--status-good)" : f < .6 ? "var(--status-warn)" : f < .78 ? "#f97316" : "var(--status-serious)";
    return miniGaugeSvg({ v, min, max, stops: [[min, max, col]] });
  }

  // Kompakte Windrose für die Wind-Kachel — Ring mit N-Marke und Richtungspfeil
  // (meteorologische Herkunft: der Pfeil zeigt, wohin der Wind weht), farbcodiert
  // nach Geschwindigkeit wie der große Kompass. o = {deg (Herkunft), speed}.
  function miniCompassSvg(o) {
    const S = 46, c = S / 2, r = 19;
    const col = o.speed >= 62 ? "var(--status-serious)" : o.speed >= 29 ? "#f97316" : o.speed >= 12 ? "var(--status-warn)" : "var(--status-good)";
    const fromDeg = 90 - o.deg;
    const tail = _pol(c, c, r - 7, fromDeg), head = _pol(c, c, r - 7, fromDeg + 180);
    const h1 = _pol(head[0], head[1], 5.5, fromDeg + 180 + 140), h2 = _pol(head[0], head[1], 5.5, fromDeg + 180 - 140);
    const dirName = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"][Math.round(o.deg / 45) % 8];
    return `<svg class="mini-compass" viewBox="0 0 ${S} ${S}" role="img" aria-label="Wind aus ${dirName}">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="rgba(255,255,255,.32)" stroke-width="2.4"/>
      <text x="${c}" y="8.5" text-anchor="middle" font-size="7" fill="rgba(255,255,255,.72)">N</text>
      <line x1="${tail[0].toFixed(1)}" y1="${tail[1].toFixed(1)}" x2="${head[0].toFixed(1)}" y2="${head[1].toFixed(1)}" stroke="${col}" stroke-width="2.8" stroke-linecap="round"/>
      <path d="M${head[0].toFixed(1)},${head[1].toFixed(1)}L${h1[0].toFixed(1)},${h1[1].toFixed(1)}L${h2[0].toFixed(1)},${h2[1].toFixed(1)}Z" fill="${col}"/></svg>`;
  }

  // Miniatur-Sparkline (24-h-Trend) für Messwert-Kacheln. Gibt SVG-String zurück.
  function sparklineSvg(data, color) {
    if (!data || data.length < 2) return "";
    const W = 150, H = 28, lo = Math.min(...data), hi = Math.max(...data), sp = (hi - lo) || 1;
    const X = i => i / (data.length - 1) * W, Y = v => H - 3 - (v - lo) / sp * (H - 6);
    const d = data.map((v, i) => (i ? "L" : "M") + X(i).toFixed(1) + "," + Y(v).toFixed(1)).join("");
    const gid = "sk" + (_gcnt++), col = color || "var(--accent)";
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".3"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
      <path d="${d}L${W},${H}L0,${H}Z" fill="url(#${gid})"/>
      <path d="${d}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round"/>
      <circle cx="${X(data.length - 1).toFixed(1)}" cy="${Y(data[data.length - 1]).toFixed(1)}" r="2.4" fill="${col}"/></svg>`;
  }

  // 7-Tage-Vorhersagestreifen (min→max je Tag, in der Wochenspanne). days = [[label, lo, hi, rain, wind, uv], …]
  function forecastStrip(days) {
    if (!days || !days.length) return "";
    const los = days.map(d => d[1]), his = days.map(d => d[2]);
    const wMin = Math.min(...los), wMax = Math.max(...his), sp = (wMax - wMin) || 1;
    const col = t => "hsl(" + Math.round(210 - Math.max(0, Math.min(1, t / 32)) * 210) + ",75%,52%)";
    const rows = days.map(d => {
      const left = (d[1] - wMin) / sp * 100, w = Math.max(6, (d[2] - d[1]) / sp * 100);
      const meta = (d[3] != null ? `💧 ${fmtN(d[3])} mm` : "") + (d[4] != null ? ` · 🌬 ${Math.round(d[4])}` : "");
      return `<div class="fc-row"><span class="fc-d">${d[0]}</span>
        <span class="fc-track"><span class="fc-bar" style="left:${left.toFixed(0)}%;width:${w.toFixed(0)}%;background:linear-gradient(90deg,${col(d[1])},${col(d[2])})"></span></span>
        <span class="fc-hi">${Math.round(d[2])}°</span><span class="fc-lo">${Math.round(d[1])}°</span>
        <span class="fc-meta">${meta}</span></div>`;
    }).join("");
    return `<div class="fc-strip"><div class="fc-title">7-Tage-Vorhersage</div>${rows}</div>`;
  }

  // Ordinale Stufenskala (Hitze/Pollen/Warnstufen). o = {level, labels, colors, caption}
  function stepsHtml(o) {
    const segs = o.labels.map((lbl, i) => {
      const on = i === o.level, c = o.colors[i];
      return `<div class="step${on ? " on" : ""}" style="${on ? `background:${c};border-color:${c}` : ""}">${esc(lbl)}</div>`;
    }).join("");
    return `<div class="viz-steps"><div class="steps-row">${segs}</div>${o.caption ? `<div class="steps-cap">${esc(o.caption)}</div>` : ""}</div>`;
  }

  // Kopfgrafik einer Detailkarte aus der def.head-Spezifikation rendern.
  function headHtml(head) {
    if (!head) return "";
    const inner = head.type === "gauge" ? gaugeSvg(head)
      : head.type === "compass" ? compassSvg(head)
      : head.type === "band" ? thresholdBar(head)
      : head.type === "thermo" ? thermoSvg(head)
      : head.type === "steps" ? stepsHtml(head) : "";
    return inner ? `<div class="m-head">${inner}</div>` : "";
  }

  function chartUI(def) {
    const ranges = def.ranges || [["24 h", 24], ["48 h", 48], ["7 Tage", 168]];
    $("#sc-modal-body").innerHTML =
      headHtml(def.head) +
      forecastStrip(def.forecast) +
      `<div class="m-range">${ranges.map(([l, h], i) => `<button data-h="${h}" class="${i === 0 ? "active" : ""}">${l}</button>`).join("")}</div>
       <div class="m-chartwrap"></div>
       <div class="m-export"><button data-exp="csv">CSV ↓</button><button data-exp="png">PNG ↓</button></div>`;
    $("#sc-modal-body").querySelector(".m-range").addEventListener("click", ev => {
      const b = ev.target.closest("button[data-h]"); if (!b) return;
      $("#sc-modal-body").querySelectorAll(".m-range button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      renderChartRange(def, parseInt(b.dataset.h, 10));
    });
    $("#sc-modal-body").querySelector(".m-export").addEventListener("click", ev => {
      const b = ev.target.closest("button[data-exp]"); if (!b) return;
      if (b.dataset.exp === "csv") exportCSV(def);
      else exportPNG(def);
    });
    renderChartRange(def, ranges[0][1]);
  }
  // Offene Daten weiterverwendbar machen (Ratsvorlage/Presse) — CSP-konform per Blob.
  function download(name, blob) {
    const a = document.createElement("a"), url = URL.createObjectURL(blob);
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportCSV(def) {
    if (!_lastSeries) return;
    const t = new Set(); _lastSeries.forEach(s => s.data.forEach(p => t.add(p[0])));
    const zeit = [...t].sort((a, b) => a - b);
    const idx = _lastSeries.map(s => { const m = {}; s.data.forEach(p => m[p[0]] = p[1]); return m; });
    const head = ["Zeit", ..._lastSeries.map(s => s.name)];
    const rows = zeit.map(z => [new Date(z).toISOString(), ...idx.map(m => m[z] != null ? m[z] : "")]);
    const csv = [head, ...rows].map(r => r.join(";")).join("\n");
    download((def.title || "verlauf").replace(/[^\w-]+/g, "_") + ".csv", new Blob(["﻿" + csv], { type: "text/csv" }));
  }
  function exportPNG(def) {
    const svg = $("#sc-modal-body").querySelector("svg"); if (!svg) return;
    // CSS-Variablen inlinen, sonst zeichnet der Canvas Gitter/Achsen unsichtbar.
    const cs = getComputedStyle(document.documentElement);
    const clone = svg.cloneNode(true);
    clone.setAttribute("width", 640); clone.setAttribute("height", 210);
    clone.querySelectorAll("*").forEach(el => {
      ["stroke", "fill"].forEach(p => {
        const v = el.getAttribute(p);
        if (v && v.startsWith("var(")) el.setAttribute(p, cs.getPropertyValue(v.slice(4, -1).trim()).trim() || "#888");
      });
    });
    const bg = cs.getPropertyValue("--surface-1").trim() || "#fff";
    const svgStr = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = 1280; c.height = 420;
      const ctx = c.getContext("2d"); ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => b && download((def.title || "verlauf").replace(/[^\w-]+/g, "_") + ".png", b));
    };
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgStr)));
  }

  function openDetail(def, key) {
    if (!def) return;
    detailModal();
    _modalOpener = document.activeElement;
    $("#sc-modal-title").textContent = def.title || "";
    $("#sc-modal-explain").textContent = def.explain || "";
    $("#sc-modal-meta").textContent = "Live aus der Urbanen Datenplattform · Stand " + new Date().toLocaleTimeString("de-DE");
    $("#sc-modal-body").innerHTML = "";
    $("#sc-modal").classList.add("open"); $("#sc-modal-backdrop").classList.add("open");
    // Deep-Link: teilbare/wiederherstellbare Ansicht je Kachel.
    if (key) history.replaceState(null, "", "#d=" + encodeURIComponent(key));
    setTimeout(() => { const c = $("#sc-modal-close"); c && c.focus(); }, 0);
    document.dispatchEvent(new CustomEvent("sc-modal-opened"));
    if (def.kind === "chart") {
      chartUI(def);
    } else if (def.kind === "info") {
      $("#sc-modal-body").innerHTML = headHtml(def.head) +
        (def.note ? `<div class="desc" style="margin-top:4px">${def.note}</div>` : "");
    } else if (def.kind === "table") {
      $("#sc-modal-body").innerHTML =
        headHtml(def.head) +
        `<table><thead><tr>${(def.header || []).map(h => `<th>${h}</th>`).join("")}</tr></thead>
         <tbody>${(def.rows || []).map(r => `<tr>${r.map((c, i) => `<td${i ? "" : ' style="font-weight:600"'}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>` +
        (def.note ? `<div class="desc" style="margin-top:8px">${def.note}</div>` : "");
    } else if (def.kind === "bars") {
      $("#sc-modal-body").innerHTML = `<div class="bars" id="modal-bars"></div>` + (def.note ? `<div class="desc">${def.note}</div>` : "");
      barSvg("#modal-bars", def.rows, { unit: def.unit, xLabel: def.xLabel });
    } else if (def.kind === "stations") {
      if (def.bars && def.bars.rows && def.bars.rows.length) {
        $("#sc-modal-body").insertAdjacentHTML("beforeend", `<div class="bars" id="modal-bars" style="margin-bottom:12px"></div>`);
        barSvg("#modal-bars", def.bars.rows, { unit: def.bars.unit, xLabel: def.bars.xLabel });
      }
      modalMapFrom(def.groups || [], def.center);
      if (def.list && def.list.length)
        $("#sc-modal-body").insertAdjacentHTML("beforeend", `<div class="m-list">${def.list.map(x => `<div>${x}</div>`).join("")}</div>`);
    }
  }

  function wireTileDetails(registry, sel) {
    _detailReg = registry || {};
    const host = $(sel || "#tiles"); if (!host) return;
    const open = t => { if (t && _detailReg[t.dataset.detail]) openDetail(_detailReg[t.dataset.detail], t.dataset.detail); };
    if (!host._scWired) {
      host._scWired = true;
      host.addEventListener("click", ev => open(ev.target.closest("[data-detail]")));
      // Tastaturbedienung (BITV): Enter/Space auf der fokussierten Kachel.
      host.addEventListener("keydown", ev => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        const t = ev.target.closest("[data-detail]");
        if (t) { ev.preventDefault(); open(t); }
      });
    }
    // Deep-Link beim Laden bzw. bei #-Änderung: passende Kachel öffnen.
    if (!window._scHashWired) {
      window._scHashWired = true;
      const fromHash = () => {
        const m = /[#&]d=([^&]+)/.exec(location.hash);
        if (m && _detailReg[decodeURIComponent(m[1])]) openDetail(_detailReg[decodeURIComponent(m[1])], decodeURIComponent(m[1]));
      };
      window.addEventListener("hashchange", fromHash);
      fromHash();
    }
  }

  // Progressive Enhancement: 24-h-Sparkline in alle Messwert-Kacheln mit
  // Zeitreihen-Detail. Läuft nach dem Erstrender; jede Kachel füllt sich, sobald
  // ihre kurze Historie geladen ist — kein Blockieren, Fehler still ignorieren.
  async function sparkTiles(registry, sel) {
    const host = $(sel || "#tiles"); if (!host || !registry) return;
    const jobs = [];
    host.querySelectorAll("[data-detail]").forEach(tileEl => {
      const def = registry[tileEl.dataset.detail];
      if (!def || def.kind !== "chart" || !def.series || !def.series.length || def.noSpark) return;
      // Keine Sparkline, wenn die Kachel bereits eine Grafik trägt (Tacho/Band/Stufen)
      // oder schon eine Sparkline hat.
      if (!tileEl.classList.contains("tile") || tileEl.querySelector(".spark, .tile-mini, .mini-band, .mini-steps")) return;
      const s = def.series[0];
      jobs.push(hist(s.id, s.attr, 24).then(ts => {
        let data = series(ts, s.attr).map(p => p[1]).filter(v => v != null);
        if (s.factor) data = data.map(v => v * s.factor);
        const svg = sparklineSvg(data, "rgba(255,255,255,.92)");
        if (svg && !tileEl.querySelector(".spark")) tileEl.insertAdjacentHTML("beforeend", svg);
      }).catch(() => {}));
    });
    await Promise.allSettled(jobs);
  }

  // PWA: Service-Worker registrieren (installierbar, Offline-Kiosk). Läuft auf
  // jeder Seite, die die Lib lädt; Fehler still ignorieren (z. B. ohne HTTPS).
  if ("serviceWorker" in navigator && location.protocol !== "file:")
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));

  // Nur die von den Seiten genutzte Oberfläche exportieren; Interna (SLOT, Themes,
  // Modal-Innereien, navLinks) bleiben privat.
  w.SC = { GW, $, css, esc, safeUrl, fmtN, fmtT, fmtDay, val, asArray,
           jget, entities, entity, byAgs, hist, series, asRows,
           tile, grade, chart, barSvg, stackBar, popupHtml, groupColor, pos, baseLayer,
           themeSelector, modalOpen, wireTileDetails, openDetailByKey, markerIcon,
           gaugeSvg, compassSvg, thresholdBar, thermoSvg, miniRadialSvg, miniGaugeSvg, miniCompassSvg, sparklineSvg,
           forecastStrip, stepsHtml, sparkTiles, miniBand, miniSteps, miniThermo };
})(window);
