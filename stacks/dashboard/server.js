// Selfhost dashboard backend
// - discovers Proxmox nodes from the cluster and polls their stats agents
// - aggregates containers from several Docker hosts (local socket + remote docker-agents)
// - builds the service list automatically (labels > overrides.json > published ports)
// - streams container logs (Dozzle-style) over Server-Sent Events
// - hosts the Telegram bot (telegram.js)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = +process.env.PORT || 3000;
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const ACTION_TOKEN = process.env.ACTION_TOKEN;
const AGENT_PORT = 9101;
// Seed node(s); the rest are discovered from /cluster/status. "pve2=http://192.168.1.11:9101"
const SEED_AGENTS = (process.env.AGENTS || '').split(',').filter(Boolean).map(s => { const [name, url] = s.split('='); return { name, url }; });
// "selfhost=local@192.168.1.21,cloud=http://192.168.1.22:9102@192.168.1.22"
const DOCKER_HOSTS = (process.env.DOCKER_HOSTS || 'selfhost=local@127.0.0.1').split(',').filter(Boolean).map(s => {
  const [name, rest] = s.split('='); const [target, ip] = rest.split('@');
  return { name, local: target === 'local', url: target === 'local' ? null : target, ip };
});
const KUMA_URL = process.env.KUMA_URL || 'http://host.docker.internal:3001';
const DOZZLE_URL = process.env.DOZZLE_URL || 'http://dozzle.local';
const readJson = f => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const overrides = readJson('overrides.json');
const bookmarks = readJson('bookmarks.json');

const state = { nodes: {}, containers: [], kuma: {}, uptime: {}, bmc: null, nas: null, events: [], errors: {}, updated: {}, hosts: {}, hostSnapshot: {} };

// ---------- HTTP helpers
function request(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ timeout: 10000, ...opts }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`${opts.path} -> HTTP ${res.statusCode} ${buf.toString().slice(0, 200)}`), { status: res.statusCode }));
        resolve(buf);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${opts.host || 'docker'}${opts.path} timed out`)));
    req.on('error', reject);
    req.end(body);
  });
}
const urlOpts = (url, extra = {}) => { const u = new URL(url); return { host: u.hostname, port: u.port, path: u.pathname + u.search, ...extra }; };
const getUrl = (url, headers = {}, timeout) => request(urlOpts(url, { headers, timeout }));

// ---------- Docker (local socket or remote docker-agent with the same API paths)
function dockerOpts(host, method, p) {
  if (host.local) return { socketPath: '/var/run/docker.sock', path: p, method };
  const headers = { Authorization: 'Bearer ' + AGENT_TOKEN };
  if (method === 'POST') headers['X-Action-Token'] = ACTION_TOKEN;
  return urlOpts(host.url + p, { method, headers });
}
const docker = (host, p, raw, method = 'GET') => request({ ...dockerOpts(host, method, p), timeout: 30000 }).then(b => raw ? b : (b.length ? JSON.parse(b) : null));
const hostByName = n => DOCKER_HOSTS.find(h => h.name === n);

function every(name, ms, fn, delay = 0) {
  const run = async () => {
    try { await fn(); state.errors[name] = null; state.updated[name] = Date.now(); }
    catch (e) { state.errors[name] = e.message; console.error(name, e.message); }
    setTimeout(run, ms);
  };
  setTimeout(run, delay);
}

// ---------- log parsing
const ERR = /\b(error|err|fatal|exception|crit(ical)?|panic)\b|\[(error|err|ftl|fatal)\]/i;
const WARN = /\b(warn|warning|wrn)\b|\[(warn|wrn)\]/i;
const DEBUG = /\b(debug|dbg|trace|trc)\b|\[(debug|dbg|trace)\]/i;
const NOISE = /No available indexers|0 errors|error_?count=0/i;
const levelOf = msg => ERR.test(msg) ? 'error' : WARN.test(msg) ? 'warn' : DEBUG.test(msg) ? 'debug' : 'info';
const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
function parseLine(line) {
  const sp = line.indexOf(' ');
  const ts = Date.parse(line.slice(0, sp));
  const msg = stripAnsi(line.slice(sp + 1)).replace(/\r$/, '');
  return { ts: isNaN(ts) ? Date.now() : ts, msg, level: levelOf(msg) };
}
function lineSplitter(tty, onLine) {
  let buf = Buffer.alloc(0); const partial = { 1: '', 2: '' };
  const text = (s, stream) => { const parts = (partial[stream] + s).split('\n'); partial[stream] = parts.pop(); for (const l of parts) if (l) onLine(l, stream); };
  return chunk => {
    if (tty) return text(chunk.toString('utf8'), 1);
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 8) {
      const len = buf.readUInt32BE(4);
      if (buf.length < 8 + len) break;
      text(buf.subarray(8, 8 + len).toString('utf8'), buf[0] === 2 ? 2 : 1);
      buf = buf.subarray(8 + len);
    }
  };
}
const ttyCache = {};
async function isTty(host, id) {
  const k = host.name + id;
  if (!(k in ttyCache)) ttyCache[k] = !!(await docker(host, `/containers/${id}/json`)).Config.Tty;
  return ttyCache[k];
}
async function tailLogs(c, lines = 30) {
  const host = hostByName(c.host);
  const raw = await docker(host, `/containers/${c.id}/logs?stdout=1&stderr=1&timestamps=1&tail=${lines}`, true);
  const out = []; lineSplitter(await isTty(host, c.id), l => out.push(parseLine(l)))(raw);
  return out;
}

// ---------- Proxmox nodes: seed + auto-discovery via /cluster/status
function ensureNode(name, url) {
  if (state.nodes[name]) { if (url && state.nodes[name].url !== url) state.nodes[name].url = url; return; }
  const n = state.nodes[name] = { name, url, online: false, live: null, slow: null, history: [], error: null, lastSeen: null };
  let histAt = 0;
  const loop = async () => {
    try {
      const s = JSON.parse(await getUrl(n.url + '/stats', { Authorization: 'Bearer ' + AGENT_TOKEN }, 4000));
      n.live = s.live; n.slow = s.slow; n.online = true; n.error = null; n.lastSeen = Date.now();
      if (Date.now() - histAt > 10000) {
        const h = JSON.parse(await getUrl(n.url + '/history', { Authorization: 'Bearer ' + AGENT_TOKEN }, 4000));
        const step = Math.max(1, Math.ceil(h.length / 180));
        n.history = h.filter((_, i) => i % step === 0 || i === h.length - 1);
        histAt = Date.now();
      }
      // discover other cluster members from this node's view
      for (const m of (s.slow?.quorum || []).filter(x => x.type === 'node' && x.ip)) ensureNode(m.name, `http://${m.ip}:${AGENT_PORT}`);
    } catch (e) { n.online = false; n.error = e.message; }
    setTimeout(loop, n.online ? 2000 : 15000);
  };
  loop();
}
SEED_AGENTS.forEach(a => ensureNode(a.name, a.url));
// last known node data survives dashboard restarts (so an offline node still shows its storage/guests)
const NODE_CACHE = path.join(__dirname, 'data', 'nodes.json');
try {
  for (const c of Object.values(JSON.parse(fs.readFileSync(NODE_CACHE, 'utf8')))) {
    ensureNode(c.name, c.url);
    const n = state.nodes[c.name];
    if (!n.slow) Object.assign(n, { slow: c.slow, live: n.live || c.live, history: n.history.length ? n.history : (c.history || []), lastSeen: n.lastSeen || c.lastSeen });
  }
} catch { /* first start */ }
every('nodeCache', 60000, async () => {
  const out = {};
  for (const n of Object.values(state.nodes)) if (n.slow) out[n.name] = { name: n.name, url: n.url, slow: n.slow, live: n.live, lastSeen: n.lastSeen, history: n.history.slice(-60) };
  fs.mkdirSync(path.dirname(NODE_CACHE), { recursive: true });
  fs.writeFileSync(NODE_CACHE + '.tmp', JSON.stringify(out)); fs.renameSync(NODE_CACHE + '.tmp', NODE_CACHE);
}, 20000);
// nodes removed from the cluster disappear from the dashboard
every('nodePrune', 60000, async () => {
  const p = primaryNode(); const members = (p?.slow?.quorum || []).filter(x => x.type === 'node').map(x => x.name);
  if (members.length) for (const k of Object.keys(state.nodes)) if (!members.includes(k)) delete state.nodes[k];
}, 30000);
const primaryNode = () => Object.values(state.nodes).find(n => n.online && n.slow) || null;
const guests = () => primaryNode()?.slow?.guests || [];

async function guestAction(vmid, op) {
  const g = guests().find(x => x.vmid === +vmid);
  if (!g) throw new Error(`guest ${vmid} not found`);
  const node = state.nodes[g.node]?.online ? state.nodes[g.node] : primaryNode();
  if (!node) throw new Error('no Proxmox node reachable');
  const body = JSON.stringify({ vmid: g.vmid, type: g.type, op, node: g.node });
  const res = JSON.parse(await request(urlOpts(node.url + '/guest', { method: 'POST', timeout: 70000, headers: {
    Authorization: 'Bearer ' + AGENT_TOKEN, 'X-Action-Token': ACTION_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }), body));
  if (!res.ok) throw new Error(res.error);
  return { guest: g, task: res.task };
}

// ---------- Docker containers across all hosts
const statsCache = {}, statsHist = {}, logCache = {};
every('docker', 5000, async () => {
  const all = [];
  await Promise.all(DOCKER_HOSTS.map(async host => {
    try {
      const list = await docker(host, '/containers/json?all=1');
      state.hosts[host.name] = { online: true, error: null, ip: host.ip, lastSeen: Date.now() };
      // last known container names per host, so the TV can show "no connection" when the host goes away
      state.hostSnapshot[host.name] = list.map(c => ({ name: c.Names[0].replace(/^\//, ''), image: c.Image })).sort((a, b) => a.name.localeCompare(b.name));
      for (const c of list) {
        const name = c.Names[0].replace(/^\//, '');
        const key = `${host.name}/${name}`;
        const health = /\((healthy|unhealthy|health: starting)\)/.exec(c.Status)?.[1] || null;
        const ports = [...new Set((c.Ports || []).filter(p => p.PublicPort && p.Type === 'tcp').map(p => p.PublicPort))].sort((a, b) => a - b);
        const labels = Object.fromEntries(Object.entries(c.Labels || {}).filter(([k]) => k.startsWith('dashboard.') || k === 'com.docker.compose.project'));
        all.push({ key, host: host.name, hostIp: host.ip, id: c.Id.slice(0, 12), name, image: c.Image, state: c.State, status: c.Status, health,
          created: c.Created, ports, labels, stats: statsCache[key] || null, hist: statsHist[key] || [], logs: logCache[key] || null });
      }
    } catch (e) { state.hosts[host.name] = { online: false, error: e.message, ip: host.ip, lastSeen: state.hosts[host.name]?.lastSeen || null }; }
  }));
  state.containers = all.sort((a, b) => a.host.localeCompare(b.host) || a.name.localeCompare(b.name));
  const errs = Object.entries(state.hosts).filter(([, h]) => !h.online).map(([k, h]) => `${k}: ${h.error}`);
  if (errs.length) throw new Error('docker host unreachable – ' + errs.join('; '));
});
every('dockerStats', 10000, async () => {
  await Promise.all(state.containers.filter(c => c.state === 'running').map(async c => {
    try {
      const s = await docker(hostByName(c.host), `/containers/${c.id}/stats?stream=false`);
      const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
      const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
      const cpus = s.cpu_stats.online_cpus || 1;
      const mem = s.memory_stats.usage - (s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0);
      const v = { cpu: sysDelta > 0 ? (cpuDelta / sysDelta) * cpus : 0, mem, memLimit: s.memory_stats.limit };
      statsCache[c.key] = v;
      const h = statsHist[c.key] ??= [];
      h.push({ t: Math.floor(Date.now() / 1000), cpu: +v.cpu.toFixed(4), mem: v.mem }); if (h.length > 90) h.shift();
    } catch { /* stopped meanwhile */ }
  }));
  // forget stats of containers that no longer exist
  const keys = new Set(state.containers.map(c => c.key));
  for (const k of Object.keys(statsCache)) if (!keys.has(k)) { delete statsCache[k]; delete statsHist[k]; delete logCache[k]; }
}, 3000);
every('logs', 60000, async () => {
  const since = Math.floor(Date.now() / 1000) - 3600;
  const events = [];
  for (const c of state.containers) {
    const host = hostByName(c.host);
    try {
      const raw = await docker(host, `/containers/${c.id}/logs?stdout=1&stderr=1&timestamps=1&since=${since}&tail=3000`, true);
      let errors = 0, warnings = 0;
      lineSplitter(await isTty(host, c.id), line => {
        const e = parseLine(line);
        if (e.level !== 'error' && e.level !== 'warn') return;
        e.level === 'error' ? errors++ : warnings++;
        events.push({ ts: e.ts, container: c.name, host: c.host, key: c.key, id: c.id, level: e.level, msg: e.msg.slice(0, 240), noise: NOISE.test(e.msg) });
      })(raw);
      logCache[c.key] = { errors, warnings };
    } catch { logCache[c.key] = null; }
  }
  const seen = new Set();
  state.events = events.sort((a, b) => b.ts - a.ts).filter(e => {
    const k = e.key + e.msg.replace(/\d+/g, '#'); if (seen.has(k)) return false; seen.add(k); return true;
  }).slice(0, 60);
}, 8000);

async function containerAction(key, op) {
  if (!['start', 'stop', 'restart'].includes(op)) throw new Error('invalid op');
  const c = state.containers.find(x => x.key === key);
  if (!c) throw new Error(`container ${key} not found`);
  await docker(hostByName(c.host), `/containers/${c.id}/${op}${op === 'start' ? '' : '?t=20'}`, true, 'POST');
  return c;
}

// ---------- Uptime Kuma
every('kuma', 15000, async () => {
  const text = (await getUrl(KUMA_URL + '/metrics')).toString();
  const kuma = {};
  for (const line of text.split('\n')) {
    const m = /^(monitor_status|monitor_response_time)\{([^}]*)\}\s+([\d.eE+-]+)/.exec(line);
    if (!m) continue;
    const name = /monitor_name="([^"]*)"/.exec(m[2])?.[1]; if (!name) continue;
    kuma[name] ??= {};
    if (m[1] === 'monitor_status') kuma[name].status = +m[3]; else kuma[name].ms = +m[3];
  }
  state.kuma = kuma;
});

// 24h uptime + recent heartbeats from the internal Kuma status page "tv" (kept in sync by tv-statuspage.py)
every('kumaUptime', 60000, async () => {
  const [page, hb] = await Promise.all([getUrl(KUMA_URL + '/api/status-page/tv'), getUrl(KUMA_URL + '/api/status-page/heartbeat/tv')]).then(r => r.map(b => JSON.parse(b)));
  const uptime = {};
  for (const g of page.publicGroupList || []) for (const m of g.monitorList || []) {
    const beats = hb.heartbeatList?.[m.id] || [];
    uptime[m.name] = { u24: hb.uptimeList?.[`${m.id}_24`] ?? null, beats: beats.slice(-48).map(b => b.status), ping: beats.at(-1)?.ping ?? null };
  }
  state.uptime = uptime;
}, 4000);

// ---------- Server management controller (Fujitsu iRMC / any IPMI BMC) – read every 20 s, power only on explicit request
const { execFile } = require('node:child_process');
const BMC = process.env.BMC_HOST ? { host: process.env.BMC_HOST, user: process.env.BMC_USER || 'admin', pass: process.env.BMC_PASS || '', node: process.env.BMC_NODE || 'pve', name: process.env.BMC_NAME || 'iRMC' } : null;
// password goes through the environment (-E), never on the command line
const ipmi = (args, timeout = 40000) => new Promise((resolve, reject) => execFile('ipmitool', ['-I', 'lanplus', '-H', BMC.host, '-U', BMC.user, '-E', ...args],
  { env: { ...process.env, IPMI_PASSWORD: BMC.pass }, timeout, maxBuffer: 1 << 20 },
  (e, out, err) => e ? reject(new Error((String(err || '').split('\n').filter(l => l && !/HPM\.x/.test(l)).pop() || e.message).trim())) : resolve(String(out))));
if (BMC) {
  state.bmc = { node: BMC.node, host: BMC.host, name: BMC.name, online: false, power: null, sensors: [], updated: null, error: null };
  every('bmc', 20000, async () => {
    try {
      const [pw, sdr] = await Promise.all([ipmi(['chassis', 'power', 'status']), ipmi(['sdr', 'elist', 'full'])]);
      const sensors = [];
      for (const line of sdr.split('\n')) {
        const f = line.split('|').map(x => x.trim()); if (f.length < 5) continue;
        const m = /^(-?[\d.]+)\s*(.*)$/.exec(f[4]);
        sensors.push({ name: f[0], status: f[2], value: m ? +m[1] : null, unit: m ? m[2].replace('degrees C', '°C').replace('Volts', 'V').replace('Watts', 'W').replace('percent', '%') : null });
      }
      Object.assign(state.bmc, { online: true, power: /is on/i.test(pw) ? 'on' : /is off/i.test(pw) ? 'off' : 'unknown', sensors, updated: Date.now(), error: null });
    } catch (e) { Object.assign(state.bmc, { online: false, error: e.message }); throw e; }
  }, 2000);
}
// ---------- power meter: reads the PSU watts every 10 s, integrates kWh, keeps history on disk
const POWER_FILE = path.join(__dirname, 'data', 'power.json');
const power = { raw: [], agg: [], kwhTotal: 0, days: {}, since: Date.now(), last: null };
try { Object.assign(power, JSON.parse(fs.readFileSync(POWER_FILE, 'utf8'))); } catch { /* first start */ }
const dayKey = t => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
let aggBucket = null;
if (BMC) {
  every('power', 10000, async () => {
    const out = await ipmi(['sdr', 'get', 'Total Power', 'PSU1 Power', 'PSU2 Power'], 9000);
    const v = {}; let cur = null;
    for (const line of out.split('\n')) {
      let m = /Sensor ID\s*:\s*(.+?)\s*\(/.exec(line); if (m) cur = m[1];
      m = /Sensor Reading\s*:\s*([\d.]+)/.exec(line); if (m && cur) v[cur] = +m[1];
    }
    if (v['Total Power'] == null) throw new Error('kein Total-Power-Wert');
    const t = Date.now(), s = { t, w: v['Total Power'], p1: v['PSU1 Power'] ?? null, p2: v['PSU2 Power'] ?? null, on: state.bmc?.power === 'on' };
    const prev = power.last;
    if (prev && t - prev.t < 120000) {           // integrate only across short gaps (trapezoid)
      const kwh = (prev.w + s.w) / 2 * (t - prev.t) / 3600e6;
      power.kwhTotal += kwh; const d = dayKey(t); power.days[d] = (power.days[d] || 0) + kwh;
    }
    power.last = s; power.raw.push(s);
    const cut = t - 48 * 3600e3; while (power.raw.length && power.raw[0].t < cut) power.raw.shift();
    // 5-minute averages for long ranges (kept 1 year)
    const b = Math.floor(t / 300000) * 300000;
    if (!aggBucket || aggBucket.t !== b) {
      if (aggBucket) power.agg.push({ t: aggBucket.t, w: +(aggBucket.sum / aggBucket.n).toFixed(1), min: aggBucket.min, max: aggBucket.max });
      aggBucket = { t: b, sum: 0, n: 0, min: Infinity, max: -Infinity };
      const c2 = t - 366 * 86400e3; while (power.agg.length && power.agg[0].t < c2) power.agg.shift();
    }
    aggBucket.sum += s.w; aggBucket.n++; aggBucket.min = Math.min(aggBucket.min, s.w); aggBucket.max = Math.max(aggBucket.max, s.w);
    if (state.bmc) state.bmc.watts = s.w;
  }, 3000);
  every('powerSave', 60000, async () => {
    fs.mkdirSync(path.dirname(POWER_FILE), { recursive: true });
    fs.writeFileSync(POWER_FILE + '.tmp', JSON.stringify(power)); fs.renameSync(POWER_FILE + '.tmp', POWER_FILE);
  }, 60000);
}
function powerApi(range) {
  const R = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400, '48h': 172800, '7d': 604800, '30d': 2592000, '1y': 31536000 };
  const sec = R[range] || 3600, from = Date.now() - sec * 1000;
  const pts = sec <= 172800 ? power.raw.filter(p => p.t >= from) : power.agg.filter(p => p.t >= from);
  const ws = pts.map(p => p.w);
  const today = dayKey(Date.now());
  const days = Object.entries(power.days).sort().slice(-31).map(([d, k]) => ({ d, kwh: +k.toFixed(3) }));
  return { range, step: sec <= 172800 ? 10 : 300, points: pts, last: power.last, kwhTotal: power.kwhTotal, kwhToday: power.days[today] || 0, since: power.since, days,
    stats: ws.length ? { min: Math.min(...ws), max: Math.max(...ws), avg: ws.reduce((a, b) => a + b, 0) / ws.length } : null, power: state.bmc?.power, now: Date.now() };
}
// ---------- Synology NAS via DSM Web API (read-only, every 60 s)
const NAS = process.env.NAS_URL ? { url: process.env.NAS_URL.replace(/\/$/, ''), user: process.env.NAS_USER || 'admin', pass: process.env.NAS_PASS || '', name: process.env.NAS_NAME || 'NAS' } : null;
let nasSid = null;
async function dsm(api, version, method, extra = {}, retry = true) {
  const body = new URLSearchParams({ api, version: String(version), method, ...extra, ...(nasSid ? { _sid: nasSid } : {}) }).toString();
  const r = await fetch(NAS.url + '/webapi/' + (api === 'SYNO.API.Auth' ? 'auth.cgi' : 'entry.cgi'), { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(25000) });
  const j = await r.json();
  if (!j.success) {
    const code = j.error?.code;
    if (retry && [105, 106, 107, 119].includes(code) && api !== 'SYNO.API.Auth') { nasSid = null; await nasLogin(); return dsm(api, version, method, extra, false); }
    throw new Error(`DSM ${api} Fehler ${code}`);
  }
  return j.data;
}
async function nasLogin() {
  const d = await dsm('SYNO.API.Auth', 3, 'login', { account: NAS.user, passwd: NAS.pass, session: 'Dashboard', format: 'sid' }, false);
  nasSid = d.sid;
}
if (NAS) {
  let slowAt = 0;
  every('nas', 60000, async () => {
    try {
      if (!nasSid) await nasLogin();
      const u = await dsm('SYNO.Core.System.Utilization', 1, 'get');
      const n = state.nas || {};
      if (!n.slowAt || Date.now() - slowAt > 10 * 60000) {   // hardware/storage info changes rarely
        const [info, st] = await Promise.all([dsm('SYNO.Core.System', 1, 'info'), dsm('SYNO.Storage.CGI.Storage', 1, 'load_info')]);
        let upd = null; try { const x = await dsm('SYNO.Core.Upgrade.Server', 1, 'check'); upd = x.available ? x.version : null; } catch {}
        slowAt = Date.now();
        Object.assign(n, {
          model: info.model, dsm: info.firmware_ver, cpu: `${info.cpu_vendor || ''} ${info.cpu_series || ''}`.trim(), ramMB: +info.ram_size || null,
          temp: +info.sys_temp || null, uptime: info.up_time, update: upd, slowAt,
          volumes: (st.volumes || []).map(v => ({ id: v.id, status: v.status, fs: v.fs_type, raid: v.raidType, used: +v.size.used, total: +v.size.total })),
          disks: (st.disks || []).map(dk => ({ id: dk.id, model: dk.model, vendor: dk.vendor, size: +dk.size_total || 0, status: dk.status, smart: dk.smart_status, temp: +dk.temp > 0 ? +dk.temp : null })),
        });
      }
      const m = u.memory || {};
      Object.assign(n, { name: NAS.name, online: true, error: null, updated: Date.now(),
        cpuPct: (u.cpu?.user_load || 0) + (u.cpu?.system_load || 0) + (u.cpu?.other_load || 0),
        mem: { total: (m.total_real || 0) * 1024, avail: (m.avail_real || 0) * 1024, cached: (m.cached || 0) * 1024, usedPct: m.real_usage },
        net: (u.network || []).filter(x => x.device !== 'total').map(x => ({ dev: x.device, rx: x.rx, tx: x.tx })),
        disk: (u.disk?.total) ? { read: u.disk.total.read_byte, write: u.disk.total.write_byte, util: u.disk.total.utilization } : null });
      state.nas = n;
    } catch (e) { state.nas = { ...(state.nas || {}), name: NAS.name, online: false, error: e.message }; nasSid = null; throw e; }
  }, 5000);
}
const BMC_OPS = { on: 'on', soft: 'soft', off: 'off', reset: 'reset', cycle: 'cycle' };
async function bmcAction(op) {
  if (!BMC) throw new Error('kein iRMC konfiguriert');
  if (!BMC_OPS[op]) throw new Error('ungültige Aktion');
  const out = await ipmi(['chassis', 'power', BMC_OPS[op]], 30000);
  console.log(`bmc: power ${op} -> ${out.trim()}`);
  setTimeout(() => ipmi(['chassis', 'power', 'status']).then(pw => { if (state.bmc) state.bmc.power = /is on/i.test(pw) ? 'on' : 'off'; }).catch(() => {}), 4000);
  return out.trim();
}

// ---------- automatic service list
const title = s => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
function buildServices() {
  const out = [];
  const usedKuma = new Set();
  // Proxmox nodes
  for (const n of Object.values(state.nodes)) {
    const ip = new URL(n.url).hostname;
    out.push({ group: 'Infrastructure', name: `Proxmox ${n.name}`, url: `https://${ip}:8006`, pveNode: n.name, desc: `Hypervisor · ${ip}`, icon: 'proxmox' });
  }
  // containers
  for (const c of state.containers) {
    const o = { ...(overrides.containers?.[c.key] || overrides.containers?.[c.name] || {}) };
    const L = c.labels;
    if (L['dashboard.hide'] === 'true' || (o.hide && L['dashboard.hide'] !== 'false')) continue;
    const url = L['dashboard.url'] || o.url || (c.ports.length && c.hostIp ? `http://${c.hostIp}:${c.ports[0]}` : null);
    if (!url) continue; // internal containers only appear in the container list
    const kuma = L['dashboard.kuma'] || o.kuma || [c.name, c.name + '-web'].find(k => state.kuma[k]);
    if (kuma) usedKuma.add(kuma);
    out.push({ group: L['dashboard.group'] || o.group || title(L['com.docker.compose.project'] || c.host),
      name: L['dashboard.name'] || o.name || title(c.name), url, icon: L['dashboard.icon'] || o.icon || c.name,
      desc: L['dashboard.description'] || o.desc || `${c.host} · ${c.image.split('/').pop().split(':')[0]}`, container: c.key, kuma, auto: !o.name && !L['dashboard.name'] });
  }
  // static links (e.g. TV mode)
  for (const l of overrides.links || []) out.push(l);
  // Kuma monitors that belong to nothing above
  for (const name of Object.keys(state.kuma)) {
    if (usedKuma.has(name) || state.containers.some(c => c.name === name)) continue;
    out.push({ group: 'Monitors', name: title(name), url: null, icon: name, desc: 'Uptime Kuma monitor', kuma: name });
  }
  const order = overrides.groupOrder || [];
  const gi = g => { const i = order.indexOf(g); return i < 0 ? 999 : i; };
  return out.sort((a, b) => gi(a.group) - gi(b.group) || a.group.localeCompare(b.group));
}

// ---------- Live log stream (SSE)
async function streamLogs(req, res, key, tail) {
  const c = state.containers.find(x => x.key === key);
  if (!c) { res.writeHead(404); res.end('unknown container'); return; }
  const host = hostByName(c.host);
  const tty = await isTty(host, c.id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const dreq = http.request({ ...dockerOpts(host, 'GET', `/containers/${c.id}/logs?stdout=1&stderr=1&timestamps=1&follow=1&tail=${tail}`) }, dres => {
    const split = lineSplitter(tty, (line, stream) => {
      const e = parseLine(line);
      res.write(`data: ${JSON.stringify({ ts: e.ts, level: e.level, msg: e.msg.slice(0, 4000), stderr: stream === 2 })}\n\n`);
    });
    dres.on('data', split);
    dres.on('end', () => { res.write('event: end\ndata: {}\n\n'); res.end(); });
  });
  dreq.on('error', e => { res.write(`event: error\ndata: ${JSON.stringify({ msg: e.message })}\n\n`); res.end(); });
  dreq.end();
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); dreq.destroy(); });
}

// ---------- Telegram bot
if (process.env.TELEGRAM_TOKEN) {
  require('./telegram.js')({ state, guests, primaryNode, buildServices, guestAction, containerAction, tailLogs, bmcAction,
    token: process.env.TELEGRAM_TOKEN, chatIds: (process.env.TELEGRAM_CHAT_IDS || '').split(',').filter(Boolean).map(Number),
    protect: { guests: (process.env.PROTECT_GUESTS || '').split(',').filter(Boolean).map(Number), containers: (process.env.PROTECT_CONTAINERS || '').split(',').filter(Boolean) } });
}

// ---------- HTTP
const STATIC = { '/': ['index.html', 'text/html'], '/tv': ['tv.html', 'text/html'], '/strom': ['power.html', 'text/html'], '/common.js': ['common.js', 'text/javascript'] };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/healthz') { res.end('ok'); return; }
  if (u.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ...state, services: buildServices(), bookmarks, dozzleUrl: DOZZLE_URL, now: Date.now() }));
    return;
  }
  if (u.pathname === '/api/power') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(powerApi(u.searchParams.get('range')))); return;
  }
  if (u.pathname === '/api/bmc' && req.method === 'POST') {
    // power control from the homepage; the page asks twice and sends the node name as confirmation
    let body = ''; req.on('data', c => { body += c; if (body.length > 1000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { op, confirm } = JSON.parse(body || '{}');
        if (!BMC || confirm !== BMC.node) throw new Error('Bestätigung fehlt');
        const out = await bmcAction(op);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, out }));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }
  if (u.pathname === '/api/logs') {
    const key = u.searchParams.get('c') || '';
    const tail = Math.min(2000, Math.max(0, parseInt(u.searchParams.get('tail') || '300', 10) || 300));
    if (!/^[\w.-]+\/[\w.-]+$/.test(key)) { res.writeHead(400); res.end('bad container'); return; }
    streamLogs(req, res, key, tail).catch(e => { try { res.writeHead(500); res.end(e.message); } catch {} });
    return;
  }
  const f = STATIC[u.pathname];
  if (!f) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': f[1] + '; charset=utf-8', 'Cache-Control': 'no-cache' });
  fs.createReadStream(path.join(__dirname, 'public', f[0])).pipe(res);
}).listen(PORT, () => console.log(`dashboard on :${PORT} · nodes: ${Object.keys(state.nodes).join(', ')} · docker: ${DOCKER_HOSTS.map(h => h.name).join(', ')}`));
