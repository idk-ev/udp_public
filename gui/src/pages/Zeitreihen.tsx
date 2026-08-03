/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { useEffect, useMemo, useState } from "react";
import {
  NgsiEntity, TemporalPoint, demoEntities, demoTemporal,
  fetchEntities, fetchTemporal,
} from "../api";
import LineChart from "../components/LineChart";

const RANGES = [
  { label: "6 Stunden", hours: 6 },
  { label: "24 Stunden", hours: 24 },
  { label: "7 Tage", hours: 168 },
];

export default function Zeitreihen() {
  const [entities, setEntities] = useState<NgsiEntity[]>([]);
  const [demo, setDemo] = useState(false);
  const [entityId, setEntityId] = useState("");
  const [attr, setAttr] = useState("");
  const [hours, setHours] = useState(24);
  const [points, setPoints] = useState<TemporalPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    fetchEntities(undefined, 500)
      .then((e) => {
        if (e.length === 0) { setEntities(demoEntities); setDemo(true); }
        else setEntities(e);
      })
      .catch(() => { setEntities(demoEntities); setDemo(true); });
  }, []);

  const selected = entities.find((e) => e.id === entityId);
  const numericAttrs = useMemo(() => {
    if (!selected) return [];
    return Object.entries(selected)
      .filter(([k, v]) =>
        !["id", "type", "@context", "location"].includes(k) &&
        typeof (v as { value?: unknown })?.value === "number")
      .map(([k]) => k);
  }, [selected]);

  useEffect(() => {
    if (entities.length && !entityId) setEntityId(entities[0].id);
  }, [entities, entityId]);

  useEffect(() => {
    if (numericAttrs.length && !numericAttrs.includes(attr)) setAttr(numericAttrs[0]);
  }, [numericAttrs, attr]);

  useEffect(() => {
    if (!entityId || !attr) return;
    setLoading(true);
    if (demo) {
      setPoints(demoTemporal(hours));
      setLoading(false);
      return;
    }
    fetchTemporal(entityId, attr, hours)
      .then(setPoints)
      .catch(() => setPoints([]))
      .finally(() => setLoading(false));
  }, [entityId, attr, hours, demo]);

  return (
    <>
      {demo && (
        <div className="banner" role="status">
          <strong>Demo-Modus:</strong>&nbsp;Beispieldaten – Temporal API nicht erreichbar.
        </div>
      )}

      <div className="toolbar">
        <label className="kbd-hint" htmlFor="ts-entity">Entität</label>
        <select id="ts-entity" value={entityId} onChange={(e) => setEntityId(e.target.value)} style={{ maxWidth: 380 }}>
          {entities.map((e) => (
            <option key={e.id} value={e.id}>{e.id.replace("urn:ngsi-ld:", "")}</option>
          ))}
        </select>

        <label className="kbd-hint" htmlFor="ts-attr">Attribut</label>
        <select id="ts-attr" value={attr} onChange={(e) => setAttr(e.target.value)}>
          {numericAttrs.map((a) => <option key={a} value={a}>{a}</option>)}
          {numericAttrs.length === 0 && <option value="">– keine numerischen Attribute –</option>}
        </select>

        <div role="group" aria-label="Zeitraum wählen" style={{ display: "flex", gap: 4 }}>
          {RANGES.map((r) => (
            <button
              key={r.hours}
              onClick={() => setHours(r.hours)}
              className={hours === r.hours ? "btn-primary" : ""}
              aria-pressed={hours === r.hours}
            >
              {r.label}
            </button>
          ))}
        </div>

        <div className="spacer" />
        <button onClick={() => setShowTable(!showTable)} aria-pressed={showTable}>
          {showTable ? "Diagramm" : "Tabellenansicht"}
        </button>
      </div>

      <div className="card">
        <h2>{attr || "Zeitreihe"}</h2>
        <p className="sub">
          {entityId} · letzte {hours} Std. · {points.length} Messwerte
          {loading ? " · lädt…" : ""}
        </p>

        {showTable ? (
          <div style={{ maxHeight: 420, overflow: "auto" }}>
            <table className="data">
              <thead><tr><th>Zeitpunkt</th><th>Wert</th></tr></thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.time}>
                    <td>{new Date(p.time).toLocaleString("de-DE")}</td>
                    <td>{p.value.toLocaleString("de-DE")}</td>
                  </tr>
                ))}
                {points.length === 0 && (
                  <tr><td colSpan={2} style={{ color: "var(--text-muted)" }}>Keine Daten.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <LineChart
            ariaLabel={`Zeitreihe des Attributs ${attr} der Entität ${entityId}`}
            series={[{ name: attr || "Wert", color: "var(--series-1)", points }]}
            height={340}
          />
        )}
      </div>
    </>
  );
}
