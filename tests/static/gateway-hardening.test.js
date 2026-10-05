/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Public gateway of the cockpit nginx (cockpit.conf.template): only the API
   paths the pages and the cockpit use, no client-chosen tenant or @context,
   no operations data (PlatformStatus) outside the dashboard login, embedding
   only for the public municipality pages. The behaviour (bypass spellings,
   header stripping, fail-closed /ops/, frame headers, limits) was checked
   against the nginx image with a mock gateway; this pins the configuration
   that produces it. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { JSDOM, ROOT, renderPage, labels } = require("./page-harness");

const read = p => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const NGINX = read("platform/config/nginx/cockpit.conf.template");
const ENVSH = "gui/docker/19-udp-public.envsh";
const location = head => {
  const at = NGINX.indexOf(head);
  assert(at >= 0, `${head} missing in cockpit.conf.template`);
  return NGINX.slice(at, NGINX.indexOf("\n    }", at));
};
const map = name => {
  const m = new RegExp(`\\nmap [^\\n]* \\${name} \\{([\\s\\S]*?)\\n\\}`).exec(NGINX);
  assert(m, `map ${name} missing`);
  return m[1];
};

exports["public context API: only entities, entity by id and types"] = () => {
  const paths = map("$udp_ngsild_path");
  const entries = [...paths.matchAll(/^\s+(\S+)\s+(\S+);$/gm)].map(m => [m[1], m[2]]);
  assert.deepStrictEqual(entries, [
    ['"~^/gateway/ngsi-ld/v1/entities$"', "list"],
    ['"~^/gateway/ngsi-ld/v1/entities/."', "entity"],
    ["/gateway/ngsi-ld/v1/types", "types"],
    ["default", '""'],
  ]);
  const body = location("location ^~ /gateway/ngsi-ld/ {");
  const at = s => body.indexOf(s);
  for (const s of ['if ($udp_ngsild_path = "") { return 404; }', 'if ($uri ~* "platformstatus") { return 403; }',
    'if ($args ~* "platformstatus|%(3[0-9]|[46][1-9a-f]|[57][0-9a])") { return 403; }',
    "if ($udp_ngsild_query_ok = 0) { return 400; }"])
    assert(at(s) > 0 && at(s) < at("rewrite ^/gateway/(.*)$ /$1 break;"), `${s} missing or after the rewrite`);
  // A list query names exactly one parameter of plain type names.
  const query = map("$udp_ngsild_query_ok");
  const re = [...query.matchAll(/"~(\^list:[^"]*)"\s+(\d);/g)].map(m => [new RegExp(m[1]), m[2]]);
  const ok = args => { for (const [r, v] of re) if (r.test(`list:${args}`)) return v === "1"; return true; };
  for (const good of ["type=CityPulse&limit=1", "type=RoadWork&q=ags~%3D%5E08415&limit=1000", "limit=1&type=A,B"])
    assert(ok(good), `rejected: ${good}`);
  for (const bad of ["idPattern=.*", "local=true&limit=500", "type=*", "type=https://x.org/T", "type=A%7CB",
    "type=A;B", "type=A&type=B", "Type=A", "atype=A", "type="])
    assert(!ok(bad), `accepted: ${bad}`);
  // The cockpit's version probe gets an empty query, never the version banner.
  const probe = location("location = /gateway/ngsi-ld/ex/v1/version {");
  assert.match(probe, /rewrite \^ \/gateway\/ngsi-ld\/v1\/entities\?type=UdpProbe&limit=1 last;/);
};

exports["public temporal API: entity history and health only, 60 s"] = () => {
  const body = location("location ^~ /gateway/temporal/ {");
  assert(body.includes('if ($uri !~ "^/gateway/temporal/(temporal/entities/.|health$)") { return 404; }'));
  assert(body.includes('if ($uri ~* "platformstatus") { return 403; }'));
  assert(body.includes("proxy_cache_valid 200 60s;"));
  // smartcity-lib.js and api.ts ask exactly this path.
  assert(read("gui/public/smartcity-lib.js").includes("${GW}/temporal/temporal/entities/${encodeURIComponent(id)}"));
};

exports["gateway: no tenant, no @context, neither in the cache key"] = () => {
  for (const head of ["location ^~ /gateway/ngsi-ld/ {", "location ^~ /gateway/temporal/ {", "location ^~ /gateway/ {",
    "location ^~ /ops/gateway/ {"]) {
    const body = location(head);
    for (const h of ["Link", "NGSILD-Tenant", "Fiware-Service", "Fiware-ServicePath"])
      assert(body.includes(`proxy_set_header ${h} "";`), `${head}: ${h} passed through`);
  }
  for (const head of ["location ^~ /gateway/ngsi-ld/ {", "location ^~ /gateway/temporal/ {"])
    assert(location(head).includes('proxy_cache_key "$request_uri|$http_accept";'), `${head}: cache key`);
  assert(!/\$http_(link|ngsild_tenant)/.test(NGINX), "Link or tenant header still read");
  const hop = /server \{\n    listen 127\.0\.0\.1:8081;([\s\S]*?)\n\}/.exec(NGINX)[1];
  assert(hop.includes('proxy_set_header Link "";') && hop.includes('proxy_set_header NGSILD-Tenant "";'));
};

exports["gateway catch-all: component allowlist, request and connection limits"] = () => {
  const body = location("location ^~ /gateway/ {");
  assert(body.includes('if ($uri !~ "^/gateway/(FROST-Server|catalog|geoserver|portal|iot)(/|$)") { return 404; }'));
  assert.match(body, /limit_req zone=udp_gateway burst=\d+ nodelay;/);
  assert.match(body, /limit_conn udp_gateway_conn \d+;/);
  assert.match(NGINX, /limit_req_zone \$binary_remote_addr zone=udp_abfahrten:10m rate=120r\/m;/);
  assert.match(location("location = /abfahrten {"), /limit_req zone=udp_abfahrten burst=60 nodelay;/);
  // APISIX limits FROST, CKAN and GeoServer per client as well.
  const apisix = read("helm/udp/files/apisix/apisix.yaml.tpl");
  for (const id of ["sensorthings", "open-data", "geo"]) {
    const route = apisix.slice(apisix.indexOf(`- id: ${id}\n`), apisix.indexOf("\n\n", apisix.indexOf(`- id: ${id}\n`)));
    assert(route.includes('include "udp.apisixRateLimit"'), `route ${id} without rate limit`);
  }
};

exports["/ops/: dashboard login on every location, no credentials upstream"] = () => {
  for (const head of ["location = /ops/connectors-status.json {", "location ^~ /ops/gateway/ {"]) {
    const body = location(head);
    // Top-level locations only: nested ones would not inherit "return 404;".
    assert.match(body, /\n        \$\{UDP_DASHBOARD_ACCESS\}\n/, `${head}: access rule missing`);
    assert.match(body, /limit_req zone=udp_ops /);
    assert.match(body, /limit_except GET HEAD \{ deny all; \}/);
    assert(body.includes('add_header Cache-Control "private, no-store" always;'));
  }
  assert(!/location [^{]*\/ops\/? \{/.test(NGINX), "a prefix location for /ops/ (nested locations lose the 404 rule)");
  assert(location("location ^~ /ops/gateway/ {").includes('proxy_set_header Authorization "";'));
  assert(location("location = /ops/connectors-status.json {").includes("alias /usr/share/nginx/ops/connectors-status.json;"));
  const docker = read("gui/Dockerfile");
  assert(docker.includes("COPY gui/ops/connectors-status.json /usr/share/nginx/ops/connectors-status.json"));
  assert(read("platform/docker-compose.yml").includes("../gui/ops:/usr/share/nginx/ops:ro"));
  // The page reads its operations data only through /ops/.
  const dash = read("gui/public/dashboard.html");
  assert(!/GW \+|SC\.GW|entity\(|SC\.hist\(/.test(dash), "dashboard.html still asks the public gateway");
  assert(dash.includes('jget("/ops/connectors-status.json")'));
};

exports["frame headers: only the municipality pages are embeddable"] = () => {
  const emb = map("$udp_embeddable");
  assert.match(emb, /"~\^\/g\/\[\^\/\]\+\/\(index\\\.html\)\?\$"\s+1;/);
  assert.match(emb, /\/stadt\.html\s+1;/);
  assert.match(emb, /\/kreis\.html\s+1;/);
  assert.match(map("$udp_frame_ancestors"), /1\s+"frame-ancestors \$\{UDP_FRAME_ANCESTORS\}";\s+default\s+"frame-ancestors 'self'";/);
  assert.match(map("$udp_frame_options"), /1\s+"";\s+default\s+SAMEORIGIN;/);
  const server = NGINX.slice(NGINX.indexOf("    # Sicherheits-Header"), NGINX.indexOf("    location = / {"));
  assert(server.includes("add_header X-Frame-Options $udp_frame_options always;"));
  assert(server.includes("add_header Content-Security-Policy $udp_frame_ancestors always;"));
  // Locations with their own add_header never use the embeddable variables.
  const own = [...NGINX.matchAll(/\n    location [^\n]*\{([\s\S]*?)\n    \}/g)].map(m => m[1]).filter(b => /add_header/.test(b));
  for (const b of own) assert(!b.includes("$udp_frame"), "a location repeats the embeddable frame headers");
  const dash = location("location ~* ^/dashboard\\.html {");
  assert(dash.includes("add_header X-Frame-Options SAMEORIGIN always;"));
  assert(dash.includes("add_header Content-Security-Policy \"frame-ancestors 'self'\" always;"));
  assert.match(NGINX, /^server_tokens off;$/m);
  assert(!/Strict-Transport-Security/.test(NGINX), "HSTS is the ingress' business (decision)");
  const values = read("helm/udp/values.yaml");
  assert(!/more_set_headers "X-Frame-Options/.test(values), "ingress example forbids embedding again");
  assert.match(values, /\n  embed:\n    frameAncestors: "\*"\n/);
};

exports["sitemap and robots: placeholder replaced with the public origin"] = () => {
  for (const [loc, type] of [["/sitemap.xml", "application/xml"], ["/robots.txt", "text/plain"]]) {
    const body = location(`location = ${loc} {`);
    assert(body.includes(`types { } default_type ${type};`));
    assert(body.includes(`sub_filter_types ${type};`));
    assert(body.includes("sub_filter '__PUBLIC_ORIGIN__' $udp_public_origin;"));
    assert(body.includes("sub_filter_once off;"));
    assert(body.includes("add_header X-Content-Type-Options nosniff always;"));
  }
  assert.match(map("$udp_public_origin"), /""\s+\$udp_request_scheme:\/\/\$host;/);
};

exports["entrypoint: frame-ancestors and public origin are checked"] = () => {
  const docker = read("gui/Dockerfile");
  assert(docker.includes(`COPY --chmod=755 ${ENVSH} /docker-entrypoint.d/19-udp-public.envsh`));
  assert(read("platform/docker-compose.yml").includes(`../${ENVSH}:/docker-entrypoint.d/19-udp-public.envsh:ro`));
  const probe = spawnSync("sh", ["-c", "exit 0"]);
  if (probe.error) { console.log("    (skipped: no sh)"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udp-public-"));
  const script = path.join(dir, "19.envsh");
  fs.writeFileSync(script, read(ENVSH));
  // "set -u" like the nginx entrypoint; undefined = variable not set at all.
  const run = (fa, origin) => {
    const env = Object.assign({}, process.env);
    delete env.UDP_FRAME_ANCESTORS; delete env.UDP_PUBLIC_ORIGIN;
    if (fa !== undefined) env.UDP_FRAME_ANCESTORS = fa;
    if (origin !== undefined) env.UDP_PUBLIC_ORIGIN = origin;
    const r = spawnSync("sh", ["-c", `set -u; . '${script.replace(/\\/g, "/")}' >/dev/null 2>&1 || exit 7; printf '%s|%s' "$UDP_FRAME_ANCESTORS" "$UDP_PUBLIC_ORIGIN"`],
      { env, encoding: "utf8" });
    return r.status === 0 ? r.stdout : null;
  };
  try {
    assert.strictEqual(run(), "*|", "unset variables (set -u)");
    assert.strictEqual(run(""), "*|");
    assert.strictEqual(run("  'self'   https://a.example.org https://*.example.de:8443 "), "'self' https://a.example.org https://*.example.de:8443|");
    assert.strictEqual(run("'none'", "https://udp.example.org/"), "'none'|https://udp.example.org");
    for (const bad of ["https://a.example.org;x", "$host", "'unsafe-inline'", "a\"b", "{x}"])
      assert.strictEqual(run(bad), null, `accepted frame-ancestors ${bad}`);
    for (const bad of ["udp.example.org", "https://a.example.org/x'", "javascript:x", "https://$host"])
      assert.strictEqual(run("*", bad), null, `accepted origin ${bad}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/* Renders the chart when helm is installed (CI's chart job lints it). */
exports["helm: probes, embedding, statement timeout, EFA cap"] = () => {
  const p = spawnSync("helm", ["version", "--short"], { encoding: "utf8" });
  if (p.error || p.status !== 0) { console.log("    (skipped: no helm)"); return; }
  const chart = path.join(ROOT, "helm", "udp");
  const render = (...set) => spawnSync("helm", ["template", "udp", chart, ...set.flatMap(s => ["--set", s])],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const doc = (out, kind, name) => out.replace(/\r\n/g, "\n").split(/\n---\n/)
    .find(d => new RegExp(`\\nkind: ${kind}\\n`).test(d) && new RegExp(`\\n  name: ${name}\\n`).test(d));
  const def = render();
  assert.strictEqual(def.status, 0, def.stderr);
  const cockpit = doc(def.stdout, "Deployment", "cockpit");
  assert(cockpit.includes('- { name: UDP_FRAME_ANCESTORS, value: "*" }'));
  assert(cockpit.includes('- { name: UDP_PUBLIC_ORIGIN, value: "https://'));
  assert.match(cockpit, /readinessProbe:\n\s+httpGet:\n.*\n.*\n\s+periodSeconds: 10\n\s+timeoutSeconds: 5\n/);
  assert.match(cockpit, /livenessProbe:\n\s+failureThreshold: 6\n\s+httpGet:\n.*\n.*\n\s+periodSeconds: 20\n\s+timeoutSeconds: 5\n/);
  const orion = doc(def.stdout, "Deployment", "orion-ld");
  assert.match(orion, /livenessProbe:\n\s+failureThreshold: 8\n/);
  const mintaka = doc(def.stdout, "Deployment", "mintaka");
  assert(mintaka.includes(`- { name: DATASOURCES_DEFAULT_CONNECTION_INIT_SQL, value: "SET statement_timeout = '30s'" }`));
  assert(!render("mintaka.statementTimeout=").stdout.includes("CONNECTION_INIT_SQL"));
  assert.notStrictEqual(render("mintaka.statementTimeout=30s;DROP").status, 0);
  assert.notStrictEqual(render("cockpit.embed.frameAncestors=https://a.example.org;script-src").status, 0);
  assert(render("cockpit.embed.frameAncestors=https://a.example.org https://*.example.de").stdout
    .includes('- { name: UDP_FRAME_ANCESTORS, value: "https://a.example.org https://*.example.de" }'));
  assert(!doc(def.stdout, "Deployment", "connectors").includes("UDP_EFA_ON_DEMAND_DAILY_CAP"));
  assert(render("connectors.efaOnDemandDailyCap=5000").stdout.includes('- { name: UDP_EFA_ON_DEMAND_DAILY_CAP, value: "5000" }'));
  assert.notStrictEqual(render("connectors.efaOnDemandDailyCap=lots").status, 0);
};

exports["dashboard.html: EFA tile from PlatformStatus, absent without the attributes"] = async () => {
  if (!JSDOM) return;
  const plat = cap => [{ id: "urn:ngsi-ld:PlatformStatus:udp", type: "PlatformStatus",
    cpuLoadPct: { type: "Property", value: 12 },
    ...(cap ? { efaOnDemandCallsToday: { type: "Property", value: 17000 },
      efaOnDemandDailyCap: { type: "Property", value: cap, unitCode: "C62" } } : {}) }];
  // Entity queries by id carry no type: the harness answers them with types.undefined.
  const w = await renderPage("dashboard.html", "https://udp.example/dashboard.html", null, {}, { undefined: plat(20000) });
  assert(labels(w.document).includes("EFA-Abfahrten heute"));
  const t = [...w.document.querySelectorAll("#tiles .tile")].find(x => /EFA-Abfahrten/.test(x.textContent));
  assert.match(t.textContent.replace(/\s+/g, " "), /17\.000 \/ 20\.000/);
  assert.match(t.textContent, /85 % des Tageslimits/);
  w.close();
  const old = await renderPage("dashboard.html", "https://udp.example/dashboard.html", null, {}, { undefined: plat(0) });
  assert(!labels(old.document).includes("EFA-Abfahrten heute"), "tile without the attributes");
  old.close();
};
