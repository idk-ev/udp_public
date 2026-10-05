/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Cockpit nginx micro-cache (cockpit.conf.template): an empty context API
   answer is cached for 10 s only (through the loopback hop that adds
   X-Accel-Expires), a non-empty one keeps its TTL, the temporal API keeps its
   direct route, and /abfahrten caches no error answers. The behaviour itself
   was checked against the nginx image with a mock gateway; this pins the
   configuration that produces it. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

const NGINX = fs.readFileSync(path.join(ROOT, "platform", "config", "nginx", "cockpit.conf.template"), "utf8");
const DOCKERFILE = fs.readFileSync(path.join(ROOT, "gui", "Dockerfile"), "utf8");
const block = (re, what) => {
  const m = NGINX.match(re);
  assert(m, `${what} missing in cockpit.conf.template`);
  return m[1];
};
const location = loc => {
  const at = NGINX.indexOf(`location ^~ ${loc} {`);
  assert(at >= 0, `${loc} missing in cockpit.conf.template`);
  return NGINX.slice(at, NGINX.indexOf("\n    }", at));
};

exports["cockpit nginx: empty NGSI-LD answers get a 10 s TTL through the loopback hop"] = () => {
  // Empty = 200 with Content-Length 2 ([]) -> X-Accel-Expires: 10.
  const map = block(/map "\$upstream_status:\$upstream_http_content_length" \$udp_empty_ttl \{([\s\S]*?)\n\}/, "map $udp_empty_ttl");
  assert.match(map, /"200:2"\s+10;/);
  assert.match(map, /default\s+"";/, "non-empty answers must keep the location's TTL");
  // The hop: loopback only, marks the answer, passes the client address on.
  const hop = block(/server \{\n    listen 127\.0\.0\.1:8081;([\s\S]*?)\n\}/, "loopback hop server");
  assert.match(hop, /add_header X-Accel-Expires \$udp_empty_ttl;/);
  assert.match(hop, /limit_except GET HEAD OPTIONS \{ deny all; \}/);
  assert.match(hop, /proxy_set_header X-Real-IP \$http_x_real_ip;/);
  assert.match(hop, /set \$gateway http:\/\/\$\{UDP_GATEWAY_UPSTREAM\};/);
  // Tenant only via NGSILD-Tenant, also on the hop.
  assert.match(hop, /proxy_set_header Fiware-Service "";/);
  assert.match(hop, /proxy_set_header Fiware-ServicePath "";/);
  // Gateway errors stay traceable: the hop logs its 5xx with the APISIX address.
  assert.match(hop, /access_log \S+ udp_hop if=\$udp_hop_log;/);
  assert.match(NGINX, /log_format udp_hop [^;]*upstream=\$upstream_addr/);
  assert.match(block(/map \$status \$udp_hop_log \{([\s\S]*?)\n\}/, "map $udp_hop_log"), /~\^5\s+1;/);
  assert(!/listen\s+(0\.0\.0\.0:)?8081|listen\s+\[::\]:8081/.test(NGINX), "the hop must not listen beyond loopback");
  const up = block(/upstream udp_gateway_hop \{([\s\S]*?)\n\}/, "upstream udp_gateway_hop");
  assert.match(up, /server 127\.0\.0\.1:8081;/);
  assert.match(up, /keepalive \d+;/);

  const body = location("/gateway/ngsi-ld/");
  assert.match(body, /proxy_pass http:\/\/udp_gateway_hop;/, "context API not through the hop");
  // Keepalive towards the hop needs HTTP/1.1 without "Connection: close".
  assert.match(body, /proxy_http_version 1\.1;/);
  assert.match(body, /proxy_set_header Connection "";/);
  assert(body.includes("proxy_cache_valid 200 60s;"), "TTL for non-empty answers changed");
  assert.match(body, /proxy_set_header X-Real-IP \$remote_addr;/, "client address for the rate limit");
  // X-Accel-Expires must be honoured, and proxy_no_cache would leave the old
  // non-empty entry to be served stale (use_stale updating).
  assert(!/proxy_ignore_headers/.test(body), "X-Accel-Expires ignored");
  assert(!/proxy_no_cache/.test(body), "proxy_no_cache keeps stale non-empty answers alive");
  assert.match(body, /proxy_cache_use_stale updating /);
};

exports["cockpit nginx: the temporal API goes straight to the gateway, 60 s"] = () => {
  // Mintaka has no 2-byte "empty" answer for entity queries, the hop would do nothing.
  const body = location("/gateway/temporal/");
  assert.match(body, /proxy_pass \$gateway;/);
  assert(!/udp_gateway_hop/.test(body), "temporal API through the hop");
  // Pages refresh every 2 min and round timeAt to the minute: at most ~1 min old.
  assert(body.includes("proxy_cache_valid 200 60s;"));
  assert.match(body, /proxy_set_header X-Real-IP \$remote_addr;/);
};

exports["cockpit image: worker_connections raised for the hop's extra connections"] = () => {
  assert.match(DOCKERFILE, /sed -i 's\/\^\\\(\\s\*worker_connections\\s\*\\\)1024;\/\\14096;\/' \/etc\/nginx\/nginx\.conf/);
  assert.match(DOCKERFILE, /grep -q 'worker_connections \*4096;' \/etc\/nginx\/nginx\.conf/, "the build must fail if the sed did nothing");
};

exports["cockpit nginx: /abfahrten caches no error answers"] = () => {
  const body = block(/location = \/abfahrten \{([\s\S]*?)\n    \}/, "/abfahrten");
  const valid = [...body.matchAll(/proxy_cache_valid ([^;]+);/g)].map(m => m[1]);
  assert.deepStrictEqual(valid, ["200 60s", "404 30s"], "a 5xx must not be cached (stale is served instead)");
};
