/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { useEffect, useRef, useState } from "react";
// maplibre-gl 6 ist ESM-only und hat keinen Default-Export mehr – Namespace-Import.
import * as maplibregl from "maplibre-gl";
import { Map as MlMap, Marker, Popup } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { NgsiEntity, demoEntities, entityCoords, escapeHtml, fetchEntities, plainValue } from "../api";

// Farbzuordnung folgt der Entität (Typ), nie dem Rang – feste Slots.
const typeColors = [
  "var(--series-1)", "var(--series-2)", "var(--series-3)",
  "var(--series-4)", "var(--series-5)", "var(--series-6)",
];

// basemap.de (BKG, dl-de/by-2-0) statt OSM-Kacheln — die OSMF-Tile-Policy
// untersagt produktive Nutzung. WMS-Quelle, weil basemap.de die ADV-Kachel-
// matrix mit eigenem Ursprung verwendet und damit nicht XYZ-kompatibel ist.
const basemapStyle: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    basemapde: {
      type: "raster",
      tiles: [
        "https://sgx.geodatenzentrum.de/wms_basemapde?SERVICE=WMS&VERSION=1.3.0" +
          "&REQUEST=GetMap&LAYERS=de_basemapde_web_raster_farbe&STYLES=&FORMAT=image/png" +
          "&TRANSPARENT=false&CRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}",
      ],
      tileSize: 256,
      attribution: "© basemap.de / BKG (dl-de/by-2-0)",
    },
  },
  layers: [{ id: "basemapde", type: "raster", source: "basemapde" }],
};

export default function Karte() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const [entities, setEntities] = useState<NgsiEntity[]>([]);
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    fetchEntities(undefined, 500)
      .then((e) => {
        const withLoc = e.filter((x) => entityCoords(x));
        if (withLoc.length === 0) { setEntities(demoEntities); setDemo(true); }
        else setEntities(withLoc);
      })
      .catch(() => { setEntities(demoEntities); setDemo(true); });
  }, []);

  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    mapRef.current = new maplibregl.Map({
      container: mapEl.current,
      style: basemapStyle,
      center: [8.9, 50.65], // Mittelhessen
      zoom: 9,
      attributionControl: { compact: false },
    });
    mapRef.current.addControl(new maplibregl.NavigationControl(), "top-right");
    mapRef.current.addControl(new maplibregl.FullscreenControl(), "top-right");
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const types = Array.from(new Set(entities.map((e) => e.type))).sort();
    const bounds = new maplibregl.LngLatBounds();

    for (const e of entities) {
      const c = entityCoords(e);
      if (!c) continue;
      bounds.extend(c);
      const color = typeColors[types.indexOf(e.type) % typeColors.length];

      const el = document.createElement("button");
      el.setAttribute("aria-label", `${e.type}: ${e.id}`);
      el.style.cssText = `width:16px;height:16px;border-radius:50%;border:2px solid var(--surface-1);background:${color};cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.35);padding:0;`;

      const rows = Object.entries(e)
        .filter(([k]) => !["id", "type", "@context", "location"].includes(k))
        .slice(0, 6)
        .map(([k, v]) => `<tr><td style="padding-right:10px;color:#666">${escapeHtml(k)}</td><td><b>${escapeHtml(plainValue(v))}</b></td></tr>`)
        .join("");

      const marker = new Marker({ element: el })
        .setLngLat(c)
        .setPopup(
          new Popup({ offset: 12, maxWidth: "320px" }).setHTML(
            `<div style="font:13px system-ui"><div style="font-weight:600;margin-bottom:2px">${escapeHtml(e.type)}</div>
             <div style="color:#666;font-size:11.5px;word-break:break-all;margin-bottom:6px">${escapeHtml(e.id)}</div>
             <table>${rows}</table></div>`,
          ),
        )
        .addTo(map);
      markersRef.current.push(marker);
    }

    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 60, maxZoom: 12 });
  }, [entities]);

  const types = Array.from(new Set(entities.map((e) => e.type))).sort();

  return (
    <>
      {demo && (
        <div className="banner" role="status">
          <strong>Demo-Modus:</strong>&nbsp;Beispieldaten – Context Broker nicht erreichbar.
        </div>
      )}
      <div className="card" style={{ padding: 12 }}>
        <div ref={mapEl} className="map-wrap" role="application" aria-label="Karte der Entitäten" />
        <div className="legend" aria-hidden={types.length < 2}>
          {types.map((t, i) => (
            <span className="l-item" key={t}>
              <span className="l-swatch" style={{ background: typeColors[i % typeColors.length], borderRadius: "50%" }} />
              {t}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}
