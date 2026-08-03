/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

// Zeitreihen-Liniendiagramm (SVG) nach den Dataviz-Vorgaben:
// 2px-Linie, dezente Hairline-Gitterlinien, Crosshair + Tooltip, keine
// Wertebeschriftung an jedem Punkt, Text in Text-Tokens (nie Serienfarbe).

import { useMemo, useRef, useState } from "react";
import type { TemporalPoint } from "../api";

export interface Series {
  name: string;
  color: string; // CSS-Variable, z. B. "var(--series-1)"
  points: TemporalPoint[];
  unit?: string;
}

interface Props {
  series: Series[];
  height?: number;
  ariaLabel: string;
}

const PAD = { top: 12, right: 16, bottom: 28, left: 48 };

export default function LineChart({ series, height = 280, ariaLabel }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ x: number; idx: number } | null>(null);

  // Breite responsiv beobachten
  const roRef = useRef<ResizeObserver | null>(null);
  const setWrap = (el: HTMLDivElement | null) => {
    (wrapRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    roRef.current?.disconnect();
    if (el) {
      roRef.current = new ResizeObserver((es) => setWidth(es[0].contentRect.width));
      roRef.current.observe(el);
    }
  };

  const { xs, yMin, yMax, xMin, xMax, ticksY, ticksX } = useMemo(() => {
    const all = series.flatMap((s) => s.points);
    const times = all.map((p) => new Date(p.time).getTime());
    const vals = all.map((p) => p.value);
    const xMin = Math.min(...times, Date.now() - 1);
    const xMax = Math.max(...times, Date.now());
    let yMin = Math.min(...vals, 0);
    let yMax = Math.max(...vals, 1);
    const pad = (yMax - yMin) * 0.08 || 1;
    yMin = Math.floor(yMin - pad);
    yMax = Math.ceil(yMax + pad);
    const ticksY = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * (yMax - yMin));
    const ticksX = [0, 0.25, 0.5, 0.75, 1].map((f) => xMin + f * (xMax - xMin));
    const xs = series.map((s) => s.points.map((p) => new Date(p.time).getTime()));
    return { xs, yMin, yMax, xMin, xMax, ticksY, ticksX };
  }, [series]);

  const w = Math.max(width, 320);
  const iw = w - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  const px = (t: number) => PAD.left + ((t - xMin) / (xMax - xMin || 1)) * iw;
  const py = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin || 1)) * ih;

  const paths = series.map((s) =>
    s.points
      .map((p, i) => `${i === 0 ? "M" : "L"}${px(new Date(p.time).getTime()).toFixed(1)},${py(p.value).toFixed(1)}`)
      .join(" "),
  );

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    if (mx < PAD.left || mx > w - PAD.right || !series[0]?.points.length) {
      setHover(null);
      return;
    }
    const t = xMin + ((mx - PAD.left) / iw) * (xMax - xMin);
    // nächstliegender Punkt der ersten Serie als Zeit-Anker
    let best = 0;
    let bestD = Infinity;
    xs[0].forEach((xt, i) => {
      const d = Math.abs(xt - t);
      if (d < bestD) { bestD = d; best = i; }
    });
    setHover({ x: px(xs[0][best]), idx: best });
  }

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  const hasData = series.some((s) => s.points.length > 0);

  return (
    <div ref={setWrap} style={{ position: "relative" }}>
      <svg
        role="img"
        aria-label={ariaLabel}
        width={w}
        height={height}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        style={{ display: "block", maxWidth: "100%" }}
      >
        {/* Gitter (hairline) + Y-Achsenbeschriftung */}
        {ticksY.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={w - PAD.right} y1={py(v)} y2={py(v)}
              stroke="var(--grid)" strokeWidth={1} />
            <text x={PAD.left - 8} y={py(v) + 4} textAnchor="end"
              fontSize={11} fill="var(--text-muted)"
              style={{ fontVariantNumeric: "tabular-nums" }}>
              {Number.isInteger(v) ? v : v.toFixed(1)}
            </text>
          </g>
        ))}
        {/* X-Achsenbeschriftung */}
        {ticksX.map((t) => (
          <text key={t} x={px(t)} y={height - 8} textAnchor="middle"
            fontSize={11} fill="var(--text-muted)">
            {new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
          </text>
        ))}
        {/* Basislinie */}
        <line x1={PAD.left} x2={w - PAD.right} y1={py(yMin)} y2={py(yMin)}
          stroke="var(--baseline)" strokeWidth={1} />

        {/* Serien */}
        {paths.map((d, i) => (
          <path key={i} d={d} fill="none" stroke={series[i].color} strokeWidth={2}
            strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {/* Crosshair + Hover-Punkte (2px Surface-Ring) */}
        {hover && hasData && (
          <g>
            <line x1={hover.x} x2={hover.x} y1={PAD.top} y2={height - PAD.bottom}
              stroke="var(--baseline)" strokeWidth={1} strokeDasharray="3 3" />
            {series.map((s, i) => {
              const p = s.points[Math.min(hover.idx, s.points.length - 1)];
              if (!p) return null;
              return (
                <circle key={i} cx={px(new Date(p.time).getTime())} cy={py(p.value)}
                  r={5} fill={s.color} stroke="var(--surface-1)" strokeWidth={2} />
              );
            })}
          </g>
        )}

        {!hasData && (
          <text x={w / 2} y={height / 2} textAnchor="middle" fontSize={13} fill="var(--text-muted)">
            Keine Daten im gewählten Zeitraum
          </text>
        )}
      </svg>

      {/* Tooltip */}
      {hover && hasData && (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(hover.x + 12, w - 190),
            top: 8,
          }}
        >
          <div className="t-time">
            {fmtTime(series[0].points[Math.min(hover.idx, series[0].points.length - 1)]?.time ?? "")}
          </div>
          {series.map((s, i) => {
            const p = s.points[Math.min(hover.idx, s.points.length - 1)];
            return (
              <div className="t-row" key={i}>
                <span className="t-swatch" style={{ background: s.color }} />
                <span>{s.name}</span>
                <span className="t-val">
                  {p ? p.value.toLocaleString("de-DE") : "–"}{s.unit ? ` ${s.unit}` : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Legende ab 2 Serien */}
      {series.length >= 2 && (
        <div className="legend">
          {series.map((s, i) => (
            <span className="l-item" key={i}>
              <span className="l-swatch" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
