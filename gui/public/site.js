/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Operator additions shared by every page (public dashboards, city pages and
   the cockpit SPA), driven by window.UDP_CONFIG (/config.js, rendered by the
   Helm chart from cockpit.analytics / cockpit.legal):

   - analytics.headHtml: a web-analytics snippet, inserted verbatim into
     <head>. Scripts parsed from markup never run, so every top-level <script>
     is recreated as a fresh element with the same attributes and code. The
     nodes are inserted one after another: after an external script without
     an async attribute the next node waits for its load/error event (at most
     LOAD_TIMEOUT_MS), so "<script src=lib.js></script><script>Lib.init()"
     works as in static markup. Other top-level elements (link, meta, …) are
     cloned; <noscript> is skipped – this code only runs with JavaScript
     enabled anyway. Scripts nested inside other elements stay inert.
     In the cockpit SPA (script tag with data-udp-context="cockpit") the
     snippet only runs with analytics.includeCockpit: that is where admin
     sessions and tokens live.
   - legal.impressumUrl / legal.datenschutzUrl: links rendered into every
     element carrying the attribute data-udp-legal. Only http(s) URLs and
     site-relative paths are accepted (same rule as the chart's render-time
     check), so a stray javascript: or //host value never becomes a link.

   Plain ES2020 without a build step. It must run once per page: city pages
   load it through a bundle loader, a second copy would add the snippet twice.
   window.UDP_SITE marks it as done and exposes the helpers to the tests. */
(function () {
  "use strict";
  // Read synchronously: currentScript is only set during this first run.
  const script = document.currentScript;
  const context = (script && script.getAttribute("data-udp-context")) || "public";
  if (window.UDP_SITE) return;

  const cfg = window.UDP_CONFIG || {};
  const analytics = cfg.analytics || {};
  // An external script whose load/error never fires (e.g. an unknown type)
  // must not stall the rest of the snippet forever.
  const LOAD_TIMEOUT_MS = 10000;

  // http(s) with a host, or a path starting with exactly one "/" ("//host"
  // and "/\host" are protocol-relative in browsers). No whitespace, control
  // or invisible format characters (U+200B, U+202E, U+FEFF, …).
  // Mirrors udp.cockpitConfigJs in helm/udp/templates/_helpers.tpl.
  const SAFE_URL =
    /^(?:https?:\/\/[^/\\\s\p{Cc}\p{Cf}\p{Z}][^\s\p{Cc}\p{Cf}\p{Z}]*|\/(?:[^/\\\s\p{Cc}\p{Cf}\p{Z}][^\s\p{Cc}\p{Cf}\p{Z}]*)?)$/iu;
  const isSafeUrl = url => typeof url === "string" && SAFE_URL.test(url);

  // Inserts one node; resolves once the next node may follow.
  function insert(node) {
    if (node.localName !== "script") {
      document.head.appendChild(document.importNode(node, true));
      return Promise.resolve();
    }
    const el = document.createElement("script");
    for (const attr of Array.from(node.attributes)) el.setAttribute(attr.name, attr.value);
    el.textContent = node.textContent;
    if (!el.hasAttribute("src") || el.hasAttribute("async")) {
      document.head.appendChild(el);
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const timer = setTimeout(done, LOAD_TIMEOUT_MS);
      function done() {
        clearTimeout(timer);
        el.removeEventListener("load", done);
        el.removeEventListener("error", done);
        resolve();
      }
      el.addEventListener("load", done);
      el.addEventListener("error", done);
      document.head.appendChild(el);
    });
  }

  // Resolves with the number of inserted nodes once the snippet is complete.
  function injectAnalytics(html) {
    if (typeof html !== "string" || !html.trim()) return Promise.resolve(0);
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const nodes = Array.from(tpl.content.children).filter(n => n.localName !== "noscript");
    return nodes.reduce(
      (chain, node) =>
        chain.then(() => insert(node)).catch(e => {
          console.warn("site.js: analytics snippet could not be inserted completely", e);
        }),
      Promise.resolve(),
    ).then(() => nodes.length);
  }

  function legalLinks() {
    const legal = cfg.legal || {};
    return [
      ["Impressum", legal.impressumUrl],
      ["Datenschutz", legal.datenschutzUrl],
    ].filter(([, url]) => isSafeUrl(url));
  }

  // Idempotent: replaces the content of each container on every call.
  // Links open in the same tab.
  function renderLegal(root) {
    const links = legalLinks();
    for (const box of Array.from((root || document).querySelectorAll("[data-udp-legal]"))) {
      const nodes = links.map(([label, url]) => {
        const a = document.createElement("a");
        a.setAttribute("href", url);
        a.textContent = label;
        return a;
      });
      box.replaceChildren(...nodes);
      if (nodes.length) box.removeAttribute("hidden");
    }
    return links.length;
  }

  const runAnalytics = context !== "cockpit" || analytics.includeCockpit === true;
  const analyticsDone = runAnalytics ? injectAnalytics(analytics.headHtml) : Promise.resolve(0);

  window.UDP_SITE = Object.freeze({ isSafeUrl, renderLegal, context, analyticsDone });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => renderLegal(), { once: true });
  } else {
    renderLegal();
  }
})();
