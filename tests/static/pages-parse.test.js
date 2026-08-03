/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Inline-Skripte aller ausgelieferten Seiten müssen syntaktisch valide sein. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const PUB = path.join(__dirname, "..", "..", "gui", "public");

const scriptsOf = html =>
  [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);

exports["Inline-Skripte parsen (stadt/kreis/dashboard/mitmachen/404)"] = () => {
  for (const f of ["stadt.html", "kreis.html", "dashboard.html", "mitmachen.html", "404.html"]) {
    const html = fs.readFileSync(path.join(PUB, f), "utf8");
    for (const src of scriptsOf(html)) {
      try {
        new Function(src); // Syntaxprüfung; await im Body via async-Wrapper testen
      } catch {
        new Function(`(async()=>{${src}})`);
      }
    }
  }
};

exports["smartcity-lib.js parst und exportiert SC-Oberfläche"] = () => {
  const src = fs.readFileSync(path.join(PUB, "smartcity-lib.js"), "utf8");
  new Function(src);
  for (const fn of ["jget", "entity", "byAgs", "hist", "series", "tile", "chart", "barSvg", "themeSelector", "wireTileDetails"])
    assert(src.includes(fn), `Export ${fn} fehlt`);
};

exports["Keine externen CDN-Einbindungen in den Dashboards"] = () => {
  for (const f of fs.readdirSync(PUB).filter(x => x.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(PUB, f), "utf8");
    const ext = [...html.matchAll(/<(?:script[^>]*src|link[^>]*href)="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
    assert.deepStrictEqual(ext, [], `${f} lädt extern: ${ext.join(", ")}`);
  }
};
