// SPDX-License-Identifier: EUPL-1.2
// © 2024–2026 Thomas Kieß and contributors

// MongoDB replica set reconciler.
//
// Runs as the sidecar "replset" next to every mongod of the StatefulSet
// "mongo" (templates/persistence.yaml):  mongosh --nodb --quiet replset.js
// One long-running mongosh process – starting mongosh costs about three
// CPU-seconds, a loop inside it costs next to nothing.
//
// Every INTERVAL_SECONDS it looks at its own mongod and
//   * on mongo-0, while no replica set config exists anywhere: initiates the
//     set with mongo-0 as the only member. mongo-0 is the member that carries
//     the data of a former standalone install, so it must become the first
//     primary – the others then copy from it (initial sync).
//   * on the primary: adds missing members (mongo-0..RS_MEMBERS-1) and
//     removes members whose ordinal is >= RS_MEMBERS, one change per
//     reconfig (MongoDB allows only one voting change at a time).
//   * everywhere: maintains READY_FILE for the readiness probe of this
//     container – ready means PRIMARY or SECONDARY, or not yet part of a set.
//     A member that is still copying data (STARTUP2) or recovering is not
//     ready: the StatefulSet rollout waits for it, and the PodDisruptionBudget
//     keeps a drain from taking a second member meanwhile.
//
// Idempotent: a set that already matches is left alone, so restarts and
// upgrades are safe. It never forces a reconfig – if a majority is gone
// (e.g. replicas lowered from 3 to 1 without removing the members first),
// it only reports it (s. DEPLOY.md §10b).
//
// Environment: POD_NAME, NAMESPACE, RS_NAME, RS_MEMBERS, INTERVAL_SECONDS,
// READY_FILE.

const fs = require('fs');

const env = process.env;
const rsName = env.RS_NAME;
const memberCount = parseInt(env.RS_MEMBERS, 10);
const namespace = env.NAMESPACE;
const self = parseInt(env.POD_NAME.replace(/^.*-/, ''), 10);
const intervalMs = 1000 * parseInt(env.INTERVAL_SECONDS || '5', 10);
const readyFile = env.READY_FILE;

// Must match udp.mongoMembers in templates/_helpers.tpl.
const host = (i) => `mongo-${i}.mongo.${namespace}.svc.cluster.local:27017`;
const ordinalOf = (h) => {
  const m = /^mongo-(\d+)\.mongo\.([^.]+)\.svc\.cluster\.local:27017$/.exec(h);
  return m && m[2] === namespace ? parseInt(m[1], 10) : null;
};
const LOCAL = 'localhost:27017';

let lastNote = '';
function note(msg) {
  // Log changes only – the loop runs every few seconds.
  if (msg !== lastNote) print(`${new Date().toISOString()} replset: ${msg}`);
  lastNote = msg;
}

const connect = (target) => new Mongo(`mongodb://${target}/?directConnection=true&serverSelectionTimeoutMS=2000&connectTimeoutMS=2000`);
// The local connection is kept for the life of the process (the driver
// reconnects by itself); a new connection every few seconds would also add a
// line to mongosh's log file each time.
let localConn = null;

// One admin command against exactly one mongod (directConnection: never
// routed through the set). Never throws.
function command(target, cmd) {
  const local = target === LOCAL;
  let conn = null;
  try {
    if (local) conn = localConn = localConn || connect(LOCAL);
    else conn = connect(target);
    // Assign before returning: mongosh awaits implicitly, and a bare
    // "return <call>" would run the finally block (closing the connection)
    // before the command has finished – and escape the catch.
    const res = conn.getDB('admin').runCommand(cmd);
    return res;
  } catch (e) {
    return { ok: 0, code: e.code, errmsg: String(e.message || e) };
  } finally {
    if (conn && !local) { try { conn.close(); } catch (e) { /* already gone */ } }
  }
}

function setReady(ready) {
  try {
    if (ready) fs.writeFileSync(readyFile, String(Date.now()));
    else if (fs.existsSync(readyFile)) fs.unlinkSync(readyFile);
  } catch (e) {
    note(`cannot update ${readyFile}: ${e.message}`);
  }
}

function initiate() {
  const status = command(LOCAL, { replSetGetStatus: 1 });
  if (status.code === 76) return note('mongod runs without --replSet');
  if (status.code !== 94) return note(`unexpected replSetGetStatus answer: ${status.errmsg || 'ok'}`);  // 94 = NotYetInitialized
  // Guard against a second, independent set: if any other member already
  // belongs to a set, mongo-0 has lost its config (e.g. a new, empty volume)
  // and will be re-added and resynced by that set's primary.
  for (let i = 1; i < memberCount; i++) {
    const h = command(host(i), { hello: 1 });
    if (h.ok && h.setName) return note(`${host(i)} already belongs to set "${h.setName}" – waiting to be added`);
  }
  const res = command(LOCAL, { replSetInitiate: { _id: rsName, members: [{ _id: 0, host: host(0) }] } });
  note(res.ok ? `initiated replica set "${rsName}" with ${host(0)}` : `replSetInitiate failed: ${res.errmsg}`);
}

function reconcile() {
  const r = command(LOCAL, { replSetGetConfig: 1 });
  if (!r.ok) return note(`replSetGetConfig failed: ${r.errmsg}`);
  const cfg = r.config;
  const present = cfg.members.map((m) => m.host);
  const surplus = cfg.members
    .filter((m) => { const o = ordinalOf(m.host); return o !== null && o >= memberCount; })
    .sort((a, b) => ordinalOf(b.host) - ordinalOf(a.host));
  const missing = [];
  for (let i = 0; i < memberCount; i++) if (!present.includes(host(i))) missing.push(host(i));
  if (!surplus.length && !missing.length) return note(`primary, ${present.length} member(s), in sync with the chart`);

  const next = Object.assign({}, cfg, { version: cfg.version + 1, members: cfg.members.slice() });
  delete next.term;  // set by the server
  let change;
  if (surplus.length) {
    const victim = surplus[0];
    if (victim.host === host(self)) return note(`would remove ${victim.host}, which is the primary itself – waiting for a step-down`);
    next.members = next.members.filter((m) => m.host !== victim.host);
    change = `removed ${victim.host}`;
  } else {
    // A new voting member is added as "newlyAdded" by the server and only
    // votes once its initial sync is done – the majority stays reachable.
    const id = Math.max(-1, ...cfg.members.map((m) => m._id)) + 1;
    next.members.push({ _id: id, host: missing[0] });
    change = `added ${missing[0]}`;
  }
  const res = command(LOCAL, { replSetReconfig: next });
  // ConfigurationInProgress & co. resolve themselves – next round.
  note(res.ok ? change : `reconfig (${change}) failed, retrying: ${res.errmsg}`);
}

function tick() {
  const h = command(LOCAL, { hello: 1 });
  if (!h.ok) {
    setReady(false);
    return note(`local mongod not reachable: ${h.errmsg}`);
  }
  setReady(Boolean(h.isWritablePrimary || h.secondary || !h.setName));
  if (!h.setName) {
    if (self === 0) return initiate();
    return note('not part of a replica set yet – waiting for the primary to add this member');
  }
  if (h.setName !== rsName) return note(`member of set "${h.setName}", but the chart expects "${rsName}"`);
  if (self >= memberCount) return note(`ordinal ${self} is beyond mongo.replicas (${memberCount}) – leaving the config to the primary`);
  if (h.isWritablePrimary) return reconcile();
  note(h.secondary ? `secondary, primary: ${h.primary || 'none'}` : `not ready yet (primary: ${h.primary || 'none'})`);
}

note(`started for ${host(self)}, set "${rsName}", ${memberCount} member(s)`);
while (true) {
  try {
    tick();
  } catch (e) {
    note(`error: ${e.message || e}`);
  }
  sleep(intervalMs);
}
