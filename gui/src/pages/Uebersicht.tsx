/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { useEffect, useState } from "react";
import {
  ComponentStatus, NgsiEntity, demoEntities, demoTemporal,
  fetchEntities, probeComponents, TemporalPoint,
} from "../api";
import LineChart from "../components/LineChart";

export default function Uebersicht() {
  const [status, setStatus] = useState<ComponentStatus[]>([]);
  const [entities, setEntities] = useState<NgsiEntity[]>([]);
  const [demo, setDemo] = useState(false);
  const [trend] = useState<TemporalPoint[]>(() => demoTemporal(24));

  useEffect(() => {
    probeComponents().then(setStatus);
    fetchEntities(undefined, 500)
      .then((e) => {
        if (e.length === 0) {
          setEntities(demoEntities);
          setDemo(true);
        } else setEntities(e);
      })
      .catch(() => {
        setEntities(demoEntities);
        setDemo(true);
      });
  }, []);

  const types = new Set(entities.map((e) => e.type));
  const online = status.filter((s) => s.ok).length;

  return (
    <>
      {demo && (
        <div className="banner" role="status">
          <strong>Demo-Modus:</strong>&nbsp;Der Context Broker ist nicht erreichbar –
          es werden Beispieldaten angezeigt. Plattform starten mit&nbsp;
          <code>docker compose up -d</code>.
        </div>
      )}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="stat-value">{entities.length.toLocaleString("de-DE")}</div>
          <div className="stat-label">Entitäten im Context Broker</div>
          <div className="stat-hint">NGSI-LD, aktueller Mandant</div>
        </div>
        <div className="card">
          <div className="stat-value">{types.size}</div>
          <div className="stat-label">Datenmodelle (Entitätstypen)</div>
          <div className="stat-hint">FIWARE Smart Data Models</div>
        </div>
        <div className="card">
          <div className="stat-value">
            {status.length ? `${online}/${status.length}` : "–"}
          </div>
          <div className="stat-label">Kernkomponenten erreichbar</div>
          <div className="stat-hint">Live-Prüfung über API-Gateway</div>
        </div>
        <div className="card">
          <div className="stat-value">99,5 %</div>
          <div className="stat-label">Verfügbarkeitsziel (SLA)</div>
          <div className="stat-hint">Monatliche Durchschnittsverfügbarkeit</div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h2>Messwerte der letzten 24 Stunden</h2>
          <p className="sub">Beispielhafte Zeitreihe (Temperatur, Demo-Station)</p>
          <LineChart
            ariaLabel="Liniendiagramm der Messwerte der letzten 24 Stunden"
            series={[{ name: "Temperatur", color: "var(--series-1)", points: trend, unit: "°C" }]}
          />
        </div>

        <div className="card">
          <h2>Plattform-Status</h2>
          <p className="sub">Erreichbarkeit der Kernkomponenten über das API-Gateway</p>
          <table className="data">
            <thead>
              <tr><th>Komponente</th><th>Aufgabe</th><th>Status</th></tr>
            </thead>
            <tbody>
              {status.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td>{s.role}</td>
                  <td>
                    {s.ok === null ? (
                      <span className="badge">prüfe…</span>
                    ) : s.ok ? (
                      <span className="badge ok"><span className="dot" /> online</span>
                    ) : (
                      <span className="badge down"><span className="dot" /> offline</span>
                    )}
                  </td>
                </tr>
              ))}
              {status.length === 0 && (
                <tr><td colSpan={3}><span className="badge">Prüfung läuft…</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
