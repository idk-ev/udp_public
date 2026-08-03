/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { useEffect, useMemo, useState } from "react";
import { NgsiEntity, demoEntities, fetchEntities, plainValue } from "../api";

export default function Datenexplorer() {
  const [entities, setEntities] = useState<NgsiEntity[]>([]);
  const [demo, setDemo] = useState(false);
  const [typeFilter, setTypeFilter] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<NgsiEntity | null>(null);

  useEffect(() => {
    fetchEntities(undefined, 500)
      .then((e) => {
        if (e.length === 0) { setEntities(demoEntities); setDemo(true); }
        else setEntities(e);
      })
      .catch(() => { setEntities(demoEntities); setDemo(true); });
  }, []);

  const types = useMemo(
    () => Array.from(new Set(entities.map((e) => e.type))).sort(),
    [entities],
  );

  const filtered = entities.filter(
    (e) =>
      (!typeFilter || e.type === typeFilter) &&
      (!search || e.id.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <>
      {demo && (
        <div className="banner" role="status">
          <strong>Demo-Modus:</strong>&nbsp;Beispieldaten – Context Broker nicht erreichbar.
        </div>
      )}

      <div className="toolbar">
        <label htmlFor="typ" className="kbd-hint">Entitätstyp</label>
        <select id="typ" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">Alle Typen ({entities.length})</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t} ({entities.filter((e) => e.type === t).length})
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="Nach ID suchen…"
          aria-label="Entitäten nach ID durchsuchen"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 260 }}
        />
        <div className="spacer" />
        <span className="kbd-hint">{filtered.length} Einträge</span>
      </div>

      <div className="grid" style={{ gridTemplateColumns: selected ? "3fr 2fr" : "1fr", alignItems: "start" }}>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="data">
            <thead>
              <tr><th>Entitäts-ID</th><th>Typ</th><th>Attribute</th></tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map((e) => (
                <tr
                  key={e.id}
                  onClick={() => setSelected(e)}
                  style={{ cursor: "pointer" }}
                  aria-selected={selected?.id === e.id}
                >
                  <td><code>{e.id}</code></td>
                  <td>{e.type}</td>
                  <td>
                    {Object.keys(e)
                      .filter((k) => !["id", "type", "@context"].includes(k))
                      .slice(0, 4)
                      .join(", ")}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={3} style={{ color: "var(--text-muted)" }}>Keine Entitäten gefunden.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {selected && (
          <div className="card">
            <div className="toolbar" style={{ marginBottom: 8 }}>
              <h2 style={{ margin: 0, wordBreak: "break-all" }}>{selected.id}</h2>
              <div className="spacer" />
              <button onClick={() => setSelected(null)} aria-label="Detailansicht schließen">✕</button>
            </div>
            <table className="data" style={{ marginBottom: 12 }}>
              <tbody>
                {Object.entries(selected)
                  .filter(([k]) => !["id", "@context"].includes(k))
                  .map(([k, v]) => (
                    <tr key={k}>
                      <td style={{ fontWeight: 600, width: "40%" }}>{k}</td>
                      <td style={{ wordBreak: "break-all" }}>{k === "type" ? String(v) : plainValue(v)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <details>
              <summary className="kbd-hint" style={{ cursor: "pointer" }}>NGSI-LD (JSON) anzeigen</summary>
              <pre className="entity-detail">{JSON.stringify(selected, null, 2)}</pre>
            </details>
          </div>
        )}
      </div>
    </>
  );
}
