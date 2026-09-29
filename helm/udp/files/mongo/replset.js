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
//   * on the primary: adds missing members (mongo-0..RS_MEMBERS-1, then –
//     once all of them are PRIMARY/SECONDARY – the arbiter RS_ARBITER if set) and removes members whose ordinal is
//     >= RS_MEMBERS or an arbiter that is no longer wanted – one change per
//     reconfig (MongoDB allows only one voting change at a time). Before the
//     arbiter is added, a cluster-wide default write concern {w: 1} is set
//     unless one exists already: MongoDB 5.0 refuses a reconfig that changes
//     the implicit default ("majority" -> 1 for primary-secondary-arbiter),
//     s. mongo.replicaSet.arbiter in values.yaml.
//   * everywhere: maintains READY_FILE for the readiness probe of this
//     container. Ready means PRIMARY, or SECONDARY no more than MAX_LAG_SECONDS
//     behind the primary, or – only while no replica set exists anywhere yet
//     (fresh install, migration from standalone) – not yet part of a set.
//     A member that is still copying data (STARTUP2), recovering, lagging or
//     waiting for its config is not ready: the StatefulSet rollout waits for
//     it, and the PodDisruptionBudget keeps a drain (e.g. of the next node)
//     from taking another voter meanwhile.
//
// Idempotent: a set that already matches is left alone, so restarts and
// upgrades are safe. It never forces a reconfig – if a majority is gone
// (e.g. replicas lowered from 3 to 1 without removing the members first),
// it only reports it (s. DEPLOY.md §10b).
//
// Environment: POD_NAME, NAMESPACE, CLUSTER_DOMAIN, RS_NAME, RS_MEMBERS, RS_ARBITER ("" =
// none), INTERVAL_SECONDS, MAX_LAG_SECONDS, READY_FILE.

const fs = require('fs');

const env = process.env;
const rsName = env.RS_NAME;
const memberCount = parseInt(env.RS_MEMBERS, 10);
const namespace = env.NAMESPACE;
const self = parseInt(env.POD_NAME.replace(/^.*-/, ''), 10);
const intervalMs = 1000 * parseInt(env.INTERVAL_SECONDS || '5', 10);
const readyFile = env.READY_FILE;
const arbiter = env.RS_ARBITER || '';
const maxLagMs = 1000 * parseInt(env.MAX_LAG_SECONDS || '30', 10);

// Must match udp.mongoMembers in templates/_helpers.tpl.
const domain = env.CLUSTER_DOMAIN || 'cluster.local';
const host = (i) => `mongo-${i}.mongo.${namespace}.svc.${domain}:27017`;
const ordinalOf = (h) => {
  const m = /^mongo-(\d+)\.mongo\.([^.]+)\.svc\.(.+):27017$/.exec(h);
  return m && m[2] === namespace && m[3] === domain ? parseInt(m[1], 10) : null;
};
// Must match udp.mongoArbiterHost.
const isArbiterHost = (h) => /^mongo-arbiter-\d+\.mongo-arbiter\./.test(h);
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
  // Guard against a second, independent set: EVERY other data member must
  // answer and none may belong to a set yet. One that belongs to a set means
  // mongo-0 lost its config (e.g. a new, empty volume) and will be re-added
  // and resynced by that set's primary; one that does not answer might be
  // such a member – so no initiation until all of them are reachable.
  // The arbiter only counts if it answers: it keeps no config across
  // restarts and holds no data, so with every data member reachable and
  // without a set there is no set it could belong to – and an arbiter that
  // cannot be scheduled must not keep the data from being served.
  for (const other of peers()) {
    const h = command(other, { hello: 1 });
    if (!h.ok && other === arbiter) continue;
    if (!h.ok) return note(`${other} not reachable – initiation waits until every data member answers`);
    if (h.setName) return note(`${other} already belongs to set "${h.setName}" – waiting to be added`);
  }
  const res = command(LOCAL, { replSetInitiate: { _id: rsName, members: [{ _id: 0, host: host(0) }] } });
  note(res.ok ? `initiated replica set "${rsName}" with ${host(0)}` : `replSetInitiate failed: ${res.errmsg}`);
}

// A cluster-wide default write concern must exist before an arbiter joins
// (s. header). An explicitly configured one is kept as it is.
function ensureDefaultWriteConcern() {
  const cur = command(LOCAL, { getDefaultRWConcern: 1 });
  if (!cur.ok) { note(`getDefaultRWConcern failed: ${cur.errmsg}`); return false; }
  if (cur.defaultWriteConcernSource === 'global') return true;
  const res = command(LOCAL, { setDefaultRWConcern: 1, defaultWriteConcern: { w: 1 } });
  if (!res.ok) { note(`setDefaultRWConcern failed: ${res.errmsg}`); return false; }
  print(`${new Date().toISOString()} replset: set cluster-wide default write concern {w: 1}`);
  return true;
}

// "" when all data members of the config are settled, else the reason.
function dataMembersSettled(cfg) {
  const pending = cfg.members.find((m) => !m.arbiterOnly && m.newlyAdded);
  if (pending) return `${pending.host} is still in initial sync`;
  const st = command(LOCAL, { replSetGetStatus: 1 });
  if (!st.ok) return `replSetGetStatus failed: ${st.errmsg}`;
  const unsettled = st.members.find((m) => ordinalOf(m.name) !== null && !['PRIMARY', 'SECONDARY'].includes(m.stateStr));
  return unsettled ? `${unsettled.name} is ${unsettled.stateStr}` : '';
}

function reconcile() {
  const r = command(LOCAL, { replSetGetConfig: 1 });
  if (!r.ok) return note(`replSetGetConfig failed: ${r.errmsg}`);
  const cfg = r.config;
  const present = cfg.members.map((m) => m.host);
  const surplus = cfg.members
    .filter((m) => { const o = ordinalOf(m.host); return o !== null && o >= memberCount; })
    .sort((a, b) => ordinalOf(b.host) - ordinalOf(a.host))
    .concat(cfg.members.filter((m) => isArbiterHost(m.host) && m.host !== arbiter));
  const missing = [];
  for (let i = 0; i < memberCount; i++) if (!present.includes(host(i))) missing.push(host(i));
  // The arbiter comes last, and only once every data member of the chart is
  // in the set, done with its initial sync (not "newlyAdded") and PRIMARY or
  // SECONDARY. Earlier, the voters would be {mongo-0, arbiter} alone – losing
  // the arbiter would then cost the primary.
  if (arbiter && !present.includes(arbiter) && !missing.length) {
    const blocker = dataMembersSettled(cfg);
    if (blocker) return note(`arbiter waits: ${blocker}`);
    missing.push(arbiter);
  }
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
    // A new voting data member is added as "newlyAdded" by the server and
    // only votes once its initial sync is done – the majority stays reachable.
    const id = Math.max(-1, ...cfg.members.map((m) => m._id)) + 1;
    const member = { _id: id, host: missing[0] };
    if (missing[0] === arbiter) {
      if (!ensureDefaultWriteConcern()) return;
      member.arbiterOnly = true;
    }
    next.members.push(member);
    change = `added ${member.arbiterOnly ? 'arbiter ' : ''}${missing[0]}`;
  }
  const res = command(LOCAL, { replSetReconfig: next });
  // ConfigurationInProgress & co. resolve themselves – next round.
  note(res.ok ? change : `reconfig (${change}) failed, retrying: ${res.errmsg}`);
}

// Other voters of the set as the chart defines it.
function peers() {
  const list = [];
  for (let i = 0; i < memberCount; i++) if (i !== self) list.push(host(i));
  if (arbiter) list.push(arbiter);
  return list;
}

// A member without config is only "ready" while no set exists anywhere –
// otherwise it is a member that still waits for its config from the primary
// (e.g. back with an empty volume) and holds no usable data.
function anyPeerInSet() {
  return peers().some((p) => { const h = command(p, { hello: 1 }); return Boolean(h.ok && h.setName); });
}

// SECONDARY and caught up: optime not more than maxLagMs behind the primary
// (as last reported by its heartbeat).
function caughtUp() {
  const st = command(LOCAL, { replSetGetStatus: 1 });
  if (!st.ok) return false;
  const me = st.members.find((m) => m.self);
  const primary = st.members.find((m) => m.stateStr === 'PRIMARY');
  // Without a visible primary there is nothing to prove this member is
  // current – not ready (the PDB then keeps the other voters in place).
  if (!me || !primary) { note('secondary without a visible primary – not ready'); return false; }
  const lag = new Date(primary.optimeDate).getTime() - new Date(me.optimeDate).getTime();
  if (lag > maxLagMs) note(`secondary lags ${Math.round(lag / 1000)} s behind the primary – not ready`);
  return lag <= maxLagMs;
}

// Defence in depth behind the chart's render-time check (templates/
// persistence.yaml): a member that carries a set config while mongo-0 runs
// as a plain standalone holds a copy from before a way back to standalone.
// Its data misses everything written since, so it must never become primary:
// keep it frozen (no election) and not ready until its volume is replaced.
function staleAgainstStandaloneSeed() {
  const seed = command(host(0), { hello: 1 });
  if (!(seed.ok && !seed.setName && !seed.isreplicaset)) return false;
  command(LOCAL, { replSetFreeze: 120 });
  setReady(false);
  note(`STALE: this member has a replica set config, but ${host(0)} runs standalone – frozen, not ready. Delete this member's volume (DEPLOY.md §10b).`);
  return true;
}

function tick() {
  const h = command(LOCAL, { hello: 1 });
  if (!h.ok) {
    setReady(false);
    return note(`local mongod not reachable: ${h.errmsg}`);
  }
  if (!h.setName) {
    setReady(!anyPeerInSet());
    if (self === 0) return initiate();
    return note('not part of a replica set yet – waiting for the primary to add this member');
  }
  if (self !== 0 && staleAgainstStandaloneSeed()) return;
  setReady(Boolean(h.isWritablePrimary || (h.secondary && caughtUp())));
  if (h.setName !== rsName) return note(`member of set "${h.setName}", but the chart expects "${rsName}"`);
  if (self >= memberCount) return note(`ordinal ${self} is beyond mongo.replicas (${memberCount}) – leaving the config to the primary`);
  if (h.isWritablePrimary) return reconcile();
  note(h.secondary ? `secondary, primary: ${h.primary || 'none'}` : `not ready yet (primary: ${h.primary || 'none'})`);
}

note(`started for ${host(self)}, set "${rsName}", ${memberCount} data member(s)${arbiter ? ` + arbiter ${arbiter}` : ''}`);
while (true) {
  try {
    tick();
  } catch (e) {
    note(`error: ${e.message || e}`);
  }
  sleep(intervalMs);
}
