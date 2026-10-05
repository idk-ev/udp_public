/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* The main dashboard (/dashboard.html: Kommunen-Suche plus operations data)
   is for operators only: HTTP basic auth in the cockpit nginx, 404 without an
   htpasswd file. Public pages lead to the start page (/) instead. The
   behaviour (bypass spellings, gzip_static, bcrypt/apr1, fail closed) was
   checked against the nginx image; this pins the configuration that
   produces it. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const PUB = path.join(ROOT, "gui", "public");
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const walk = dir => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);

const NGINX = read("platform/config/nginx/cockpit.conf.template");
const ENVSH = "gui/docker/18-udp-dashboard-auth.envsh";
const HTPASSWD = "/etc/nginx/udp-auth/htpasswd";

const locationBody = head => {
  const at = NGINX.indexOf(head);
  assert(at >= 0, `${head} missing in cockpit.conf.template`);
  return NGINX.slice(at, NGINX.indexOf("\n    }", at));
};

exports["public pages do not link to /dashboard.html"] = () => {
  // config.js: the operator link of the cockpit SPA (module tile).
  // sw.js: names the page only to keep its hands off it.
  const allowed = new Set(["dashboard.html", "config.js", "sw.js"].map(f => path.join(PUB, f)));
  const hits = walk(PUB)
    .filter(f => /\.(html|js|json|webmanifest)$/.test(f) && !allowed.has(f))
    .filter(f => fs.readFileSync(f, "utf8").includes("/dashboard.html"))
    .map(f => path.relative(ROOT, f));
  assert.deepStrictEqual(hits, [], "public pages link to the login-protected main dashboard – link / instead");
  const gen = read("scripts/generate-city-pages.py");
  assert(!gen.includes("dashboard.html"), "generate-city-pages.py links to the main dashboard");
  const manifest = JSON.parse(read("gui/public/manifest.webmanifest"));
  assert.strictEqual(manifest.start_url, "/", "installed app must start on the public start page");
};

exports["service worker: /dashboard.html neither precached nor intercepted"] = () => {
  const sw = read("gui/public/sw.js");
  const shell = /const SHELL = \[([\s\S]*?)\];/.exec(sw);
  assert(shell, "SHELL list not found");
  assert(!shell[1].includes("/dashboard.html"), "a 401/404 in SHELL makes addAll() fail and the worker never installs");
  assert(/"\/",/.test(shell[1]), "the start page (offline fallback) is not precached");
  assert.match(sw, /const PRIVATE = \[[^\]]*"\/dashboard\.html"[^\]]*\];/);
  // /ops/… (the dashboard's operations data) is private as well.
  assert.match(sw, /const isPrivate = p => PRIVATE\.includes\(p\) \|\| p\.startsWith\("\/ops\/"\);/);
  assert.match(sw, /isPrivate\(u\.pathname\)\) return;/);
  assert.match(sw, /caches\.match\("\/"\)/, "offline fallback for pages is not the start page");
};

exports["cockpit nginx: /dashboard.html behind the access rule, .gz copies unreachable"] = () => {
  const dash = locationBody("location ~* ^/dashboard\\.html {");
  assert.match(dash, /\n        \$\{UDP_DASHBOARD_ACCESS\}\n/, "access rule missing");
  assert.match(dash, /add_header Cache-Control "private, no-store" always;/);
  // add_header in a location drops the server-level headers.
  for (const h of ["X-Content-Type-Options nosniff", "X-Frame-Options SAMEORIGIN", "Referrer-Policy strict-origin-when-cross-origin"])
    assert(dash.includes(`add_header ${h} always;`), `${h} not repeated in the dashboard location`);
  assert.match(dash, /try_files \$uri =404;/);

  const gz = locationBody("location ~* \\.gz$ {");
  assert.match(gz, /return 404;/);
  // Regex locations: the first match wins. Both must come before the .html one.
  const at = s => NGINX.indexOf(s);
  const html = at("location ~* \\.(css|js|html|json)$ {");
  assert(html > 0);
  assert(at("location ~* \\.gz$ {") < html && at("location ~* ^/dashboard\\.html {") < html,
    "the .html regex location would answer /dashboard.html without a login");
  assert(at("location ~* \\.gz$ {") < at("location ~* ^/dashboard\\.html {"),
    "/dashboard.html.gz must be refused, not served after the login as a raw file");
  assert(!/location\s+(=\s+)?\/dashboard/.test(NGINX), "a second, unprotected location for the dashboard");
  assert.match(NGINX, /location = \/kommunen\.html \{ return 301 \/; \}/);
};

exports["cockpit image and Compose run the access script"] = () => {
  const docker = read("gui/Dockerfile");
  assert(docker.includes(`COPY --chmod=755 ${ENVSH} /docker-entrypoint.d/18-udp-dashboard-auth.envsh`));
  assert.match(docker, /NGINX_ENVSUBST_FILTER=\^\(UDP_\|/, "UDP_DASHBOARD_ACCESS would not be substituted");
  const compose = read("platform/docker-compose.yml");
  assert(compose.includes(`../${ENVSH}:/docker-entrypoint.d/18-udp-dashboard-auth.envsh:ro`),
    "Compose: without the script the template keeps ${UDP_DASHBOARD_ACCESS} and nginx -t fails");
  assert(compose.includes("./config/nginx/udp-auth:/etc/nginx/udp-auth:ro"));
};

exports["entrypoint scripts are executable in git"] = () => {
  // Compose bind-mounts them with the mode of the checkout; a non-executable
  // .envsh is skipped by the nginx entrypoint and the template then fails to
  // load (unknown directive "${UDP_...}"), taking the whole cockpit down.
  const r = spawnSync("git", ["ls-files", "-s", "gui/docker/"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) return; // not a git checkout (e.g. source tarball)
  const lines = r.stdout.trim().split("\n").filter(l => /\.envsh$/.test(l));
  assert(lines.some(l => l.endsWith(ENVSH)), `${ENVSH} not tracked`);
  for (const l of lines) assert(l.startsWith("100755 "), `not executable: ${l}`);
};

exports["cockpit nginx: dashboard login is rate-limited"] = () => {
  assert(/limit_req_zone \$binary_remote_addr zone=udp_dashboard:/.test(NGINX));
  const body = locationBody("location ~* ^/dashboard\\.html {");
  assert(body.indexOf("limit_req zone=udp_dashboard") >= 0, "no limit_req in the dashboard location");
};

exports["helm: htpasswd Secret mounted read-only at the fixed path"] = () => {
  const values = read("helm/udp/values.yaml");
  // On by default with a chart-generated login; existingSecret only overrides.
  assert.match(values, /\n  dashboardAuth:\n(    #.*\n)*    enabled: true\n(    #.*\n)*    username: "betrieb"\n(    #.*\n)*    existingSecret: ""\n/);
  const apps = read("helm/udp/templates/apps.yaml");
  const cockpit = apps.slice(apps.indexOf("  name: cockpit\n"), apps.indexOf("kind: Service", apps.indexOf("  name: cockpit\n")));
  assert.match(cockpit, /\$dashboardAuth := include "udp\.dashboardAuthSecretName" \./);
  assert.match(cockpit, /- name: dashboard-auth\n\s+mountPath: \/etc\/nginx\/udp-auth\n\s+readOnly: true/);
  assert.match(cockpit, /secretName: \{\{ \$dashboardAuth \| quote \}\}/);
  assert.match(cockpit, /items: \[\{ key: htpasswd, path: htpasswd \}\]/);
};

exports["helm: generated login follows the conventions of the other chart secrets"] = () => {
  const secrets = read("helm/udp/templates/secrets.yaml");
  const at = secrets.indexOf('lookup "v1" "Secret" .Release.Namespace "udp-dashboard-auth"');
  assert(at > 0, "udp-dashboard-auth is not kept via lookup");
  const block = secrets.slice(secrets.lastIndexOf("{{- if", at), secrets.indexOf("{{- end }}\n", secrets.indexOf("htpasswd:", secrets.indexOf("stringData:", at))));
  assert.match(block, /\{\{- if and \.Values\.secrets\.create \(eq \(include "udp\.dashboardAuthSecretName" \.\) "udp-dashboard-auth"\) \}\}/);
  assert.match(block, /randAlphaNum \(\.Values\.secrets\.passwordLength \| int\)/);
  assert.match(block, /"helm\.sh\/resource-policy": keep/);
  // bcrypt via Helm; the old line is reused while username and password are
  // unchanged, otherwise every upgrade would get a new salt (Secret churn).
  assert.match(block, /htpasswd \$daUser \$daPass/);
  assert.match(block, /if and \(index \$daData "htpasswd"\) \(eq \$daSum \$daOldSum\)/);
  assert.match(block, /checksum\/htpasswd: \{\{ \$daSum \| quote \}\}/);
  for (const key of ["username", "password", "htpasswd"])
    assert(new RegExp(`\\n  ${key}: \\{\\{`).test(block), `key ${key} missing`);

  const helpers = read("helm/udp/templates/_helpers.tpl");
  const at2 = helpers.indexOf('{{- define "udp.dashboardAuthSecretName" -}}');
  assert(at2 >= 0, "helper udp.dashboardAuthSecretName missing");
  const def = helpers.slice(at2, helpers.indexOf("{{- end -}}\n{{- end -}}", at2));
  assert(def.includes('$existing | default "udp-dashboard-auth"'));
  assert(def.includes("regexMatch"), "username is not checked – a ':' would break the htpasswd line");
};

/* Renders the chart when helm is installed (locally; CI's chart job renders
   the same cases). lookup is empty here, so a fresh password is generated. */
exports["helm: rendered login for defaults, enabled=false and existingSecret"] = () => {
  const probe = spawnSync("helm", ["version", "--short"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) { console.log("    (skipped: no helm)"); return; }
  const chart = path.join(ROOT, "helm", "udp");
  const render = (...set) => {
    const r = spawnSync("helm", ["template", "udp", chart, ...set.flatMap(s => ["--set", s])],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.strictEqual(r.status, 0, r.stderr);
    const docs = r.stdout.replace(/\r\n/g, "\n").split(/\n---\n/);
    const secret = docs.find(d => /\nkind: Secret\n/.test(d) && /\n  name: udp-dashboard-auth\n/.test(d));
    const cockpit = docs.find(d => /\nkind: Deployment\n/.test(d) && /\n  name: cockpit\n/.test(d));
    assert(cockpit, "cockpit Deployment not rendered");
    const vol = cockpit.indexOf("- name: dashboard-auth\n          secret:");
    const name = vol >= 0 ? /secretName: "([^"]+)"/.exec(cockpit.slice(vol))[1] : null;
    assert.strictEqual(cockpit.includes("mountPath: /etc/nginx/udp-auth"), name !== null, "mount and volume disagree");
    return { secret, mounted: name };
  };
  const def = render();
  assert(def.secret, "no generated Secret by default");
  assert.strictEqual(def.mounted, "udp-dashboard-auth");
  assert.strictEqual(/\n  username: "([^"]+)"/.exec(def.secret)[1], "betrieb");
  assert.match(/\n  password: "([^"]+)"/.exec(def.secret)[1], /^[A-Za-z0-9]{32}$/);
  assert.match(def.secret, /\n  htpasswd: "betrieb:\$2a\$10\$[./A-Za-z0-9]{53}\\n"(\n|$)/,"htpasswd is not one bcrypt line for the username");

  assert.match(render("cockpit.dashboardAuth.username=ops").secret, /\n  htpasswd: "ops:\$2a\$10\$/);

  const off = render("cockpit.dashboardAuth.enabled=false");
  assert(!off.secret && off.mounted === null, "enabled=false must render neither Secret nor mount");

  const own = render("cockpit.dashboardAuth.existingSecret=dashboard-htpasswd");
  assert(!own.secret, "existingSecret set, but the chart still generates one");
  assert.strictEqual(own.mounted, "dashboard-htpasswd");

  const bad = spawnSync("helm", ["template", "udp", chart, "--set", "cockpit.dashboardAuth.username=a:b"], { encoding: "utf8" });
  assert.notStrictEqual(bad.status, 0, "a username with ':' must fail the render");
};

/* Runs the script itself with sh. The fixed path is swapped for a temporary
   one; everything else is the file as the image ships it. */
exports["access script: login with a usable htpasswd, 404 otherwise"] = () => {
  const probe = spawnSync("sh", ["-c", "exit 0"]);
  if (probe.error) { console.log("    (skipped: no sh)"); return; }
  const src = read(ENVSH);
  assert(src.includes(`udp_htpasswd=${HTPASSWD}\n`), "htpasswd path changed – Helm, Compose and docs name it");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udp-auth-"));
  const file = path.join(dir, "htpasswd").replace(/\\/g, "/");
  const script = path.join(dir, "18.envsh");
  fs.writeFileSync(script, src.replace(`udp_htpasswd=${HTPASSWD}\n`, `udp_htpasswd='${file}'\n`));
  const access = () => {
    const r = spawnSync("sh", ["-c", `. '${script.replace(/\\/g, "/")}' >/dev/null; printf '%s' "$UDP_DASHBOARD_ACCESS"`],
      { env: Object.assign({}, process.env, { UDP_DASHBOARD_ACCESS: "allow all;" }), encoding: "utf8" });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout;
  };
  try {
    assert.strictEqual(access(), "return 404;", "no file: must fail closed (and ignore a preset value)");
    fs.writeFileSync(file, "");
    assert.strictEqual(access(), "return 404;", "empty file: must fail closed");
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    assert.strictEqual(access(), "return 404;", "directory instead of a file: must fail closed");
    fs.rmdirSync(file);
    fs.writeFileSync(file, "betrieb:$apr1$abcdefgh$0123456789012345678901\n");
    assert.strictEqual(access(), `auth_basic "UDP-Hauptdashboard"; auth_basic_user_file ${file};`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
