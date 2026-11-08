// Telegram bot: alerts + status commands + guarded VM/LXC/container control.
// Only chats listed in TELEGRAM_CHAT_IDS are served; every state-changing action needs a confirm button.
const https = require('node:https');
const crypto = require('node:crypto');

module.exports = function startBot(ctx) {
  const { state, guests, primaryNode, buildServices, guestAction, containerAction, tailLogs, bmcAction, token, chatIds, protect } = ctx;
  const TZ = 'Europe/Berlin';

  // ---------- Telegram API
  // IPv4 only (the VM has no global IPv6) + up to 3 attempts for transient network errors
  async function api(method, params = {}, timeout = 15000) {
    for (let i = 1; ; i++) {
      try { return await apiOnce(method, params, timeout); }
      catch (e) { if (e.telegram || i >= 3) throw e; await new Promise(r => setTimeout(r, 1500 * i)); }
    }
  }
  function apiOnce(method, params, timeout) {
    const body = JSON.stringify(params);
    return new Promise((resolve, reject) => {
      const req = https.request({ host: 'api.telegram.org', family: 4, path: `/bot${token}/${method}`, method: 'POST', timeout,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { const j = JSON.parse(d); j.ok ? resolve(j.result) : reject(Object.assign(new Error(j.description), { telegram: true })); } catch (e) { reject(e); } });
      });
      req.on('timeout', () => req.destroy(new Error('telegram timeout'))); req.on('error', reject); req.end(body);
    });
  }
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const send = (chat, text, kb) => api('sendMessage', { chat_id: chat, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}) })
    .catch(e => console.error('telegram send failed:', e.code || e.name, e.message || (e.errors || []).map(x => x.message).join('; ')));
  const edit = (chat, msgId, text, kb) => api('editMessageText', { chat_id: chat, message_id: msgId, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: kb || [] } })
    .catch(e => { if (!/not modified/.test(e.message)) console.error('telegram edit', e.message); });
  let muteUntil = 0;
  const alert = text => { if (Date.now() < muteUntil) return; chatIds.forEach(c => send(c, text)); };

  // ---------- formatting helpers
  const pct = (u, t) => t ? Math.round(u / t * 100) : 0;
  const gib = b => (b / 2 ** 30).toFixed(1) + ' GiB';
  const dur = s => { s = Math.floor(s); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
  const ago = ts => { const s = (Date.now() - ts) / 1000; return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };
  const icon = st => ({ ok: '🟢', bad: '🔴', warn: '🟡', info: '🔵' }[st] || '⚪');
  const guestIcon = g => g.status === 'running' ? '🟢' : g.status === 'stopped' ? '⚫' : '⚪';
  const ctrStatus = c => c.state !== 'running' || c.health === 'unhealthy' ? 'bad' : c.health === 'health: starting' ? 'warn' : 'ok';
  function svcStatus(sv) {
    if (sv.pveNode) return state.nodes[sv.pveNode]?.online ? 'ok' : 'bad';
    const k = state.kuma[sv.kuma];
    if (k?.status === 1) return 'ok'; if (k?.status === 0) return 'bad'; if (k?.status === 2) return 'warn'; if (k?.status === 3) return 'info';
    const c = state.containers.find(c => c.key === sv.container);
    return c ? ctrStatus(c) : 'unknown';
  }
  const findContainer = q => { q = q.toLowerCase(); return state.containers.find(c => c.key.toLowerCase() === q) || state.containers.find(c => c.name.toLowerCase() === q) || state.containers.find(c => c.name.toLowerCase().includes(q)); };
  const findGuest = q => guests().find(g => String(g.vmid) === q) || guests().find(g => (g.name || '').toLowerCase() === q.toLowerCase());

  // ---------- views
  function statusText() {
    const p = primaryNode();
    const cluster = p?.slow?.quorum?.find(x => x.type === 'cluster');
    const svcs = buildServices().filter(s => !s.pveNode && s.url !== '/tv');
    const down = svcs.filter(s => svcStatus(s) === 'bad');
    const gs = guests();
    const lines = [`<b>🖥 Selfhost status</b>  <i>${new Date().toLocaleTimeString('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })}</i>`, ''];
    for (const n of Object.values(state.nodes)) {
      if (!n.online || !n.live) { lines.push(`🔴 <b>${esc(n.name)}</b> offline${n.lastSeen ? ` (seit ${ago(n.lastSeen)})` : ''}`); continue; }
      const l = n.live;
      lines.push(`🟢 <b>${esc(n.name)}</b>  CPU ${Math.round(l.cpu * 100)}% · RAM ${pct(l.mem.used, l.mem.total)}% · Disk ${pct(l.rootfs.used, l.rootfs.total)}% · up ${dur(l.uptime)}`);
    }
    if (cluster && !cluster.quorate) lines.push('⚠️ <b>Cluster hat kein Quorum</b>');
    lines.push('', `${down.length ? '🔴' : '🟢'} Services: <b>${svcs.length - down.length}/${svcs.length}</b> up${down.length ? ' – down: ' + down.map(s => esc(s.name)).join(', ') : ''}`);
    lines.push(`📦 Container: <b>${state.containers.filter(c => c.state === 'running').length}/${state.containers.length}</b> laufen`);
    lines.push(`💻 Gäste: <b>${gs.filter(g => g.status === 'running').length}/${gs.length}</b> laufen`);
    const issues = state.events.filter(e => !e.noise).length;
    if (issues) lines.push(`⚠️ ${issues} Warnungen/Fehler in Logs (1h) → /issues`);
    if (Date.now() < muteUntil) lines.push(`🔕 Alarme stumm bis ${new Date(muteUntil).toLocaleTimeString('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })}`);
    return lines.join('\n');
  }
  function nodesText() {
    return Object.values(state.nodes).map(n => {
      if (!n.online || !n.live) return `🔴 <b>${esc(n.name)}</b> – offline`;
      const l = n.live, s = n.slow || {};
      const net = Object.entries(l.net || {}).map(([k, v]) => `${esc(k)} ↓${(v.rx * 8 / 1e6).toFixed(1)} ↑${(v.tx * 8 / 1e6).toFixed(1)} Mbit/s`).join('\n   ');
      const disks = (s.disks || []).map(d => `${d.devpath.replace('/dev/', '')}:${d.health}`).join(' ');
      return `🟢 <b>${esc(n.name)}</b> · ${esc(s.cpuinfo?.model || '')}\n` +
        `   CPU ${Math.round(l.cpu * 100)}% (${l.cores} Threads) · Load ${l.load.map(x => x.toFixed(2)).join(' ')}\n` +
        `   RAM ${gib(l.mem.used)} / ${gib(l.mem.total)} (${pct(l.mem.used, l.mem.total)}%) · Swap ${gib(l.swap.used)}\n` +
        `   Root ${pct(l.rootfs.used, l.rootfs.total)}% · SMART ${esc(disks || '–')}\n   ${net}\n   Uptime ${dur(l.uptime)}`;
    }).join('\n\n');
  }
  function guestsView() {
    const gs = guests().slice().sort((a, b) => a.vmid - b.vmid);
    const text = '<b>💻 VMs & LXCs</b>\n\n' + gs.map(g => `${guestIcon(g)} <code>${g.vmid}</code> ${esc(g.name || '?')} <i>(${g.type === 'lxc' ? 'LXC' : 'VM'} · ${esc(g.node)})</i>${g.status === 'running' ? ` · ${Math.round(g.cpu * 100)}% · ${gib(g.mem)}` : ''}`).join('\n');
    const kb = []; for (let i = 0; i < gs.length; i += 2) kb.push(gs.slice(i, i + 2).map(g => ({ text: `${guestIcon(g)} ${g.vmid} ${g.name || ''}`.slice(0, 30), callback_data: `g:${g.vmid}` })));
    kb.push([{ text: '🔄 Aktualisieren', callback_data: 'vms' }]);
    return [text, kb];
  }
  function guestView(g) {
    const on = g.status === 'running';
    const text = `${guestIcon(g)} <b>${esc(g.name)}</b> (${g.type === 'lxc' ? 'LXC' : 'VM'} ${g.vmid}) auf <b>${esc(g.node)}</b>\nStatus: <b>${esc(g.status)}</b>` +
      (on ? `\nCPU ${Math.round(g.cpu * 100)}% · RAM ${gib(g.mem)} / ${gib(g.maxmem)} · up ${dur(g.uptime)}` : '') +
      (protect.guests.includes(g.vmid) ? '\n🔒 <i>Geschützt – auf diesem Gast läuft der Bot selbst</i>' : '');
    const kb = [];
    if (!protect.guests.includes(g.vmid)) {
      if (on) kb.push([{ text: '⏻ Herunterfahren', callback_data: `ga:shutdown:${g.vmid}` }, { text: '🔁 Neustart', callback_data: `ga:reboot:${g.vmid}` }], [{ text: '⛔ Hart stoppen', callback_data: `ga:stop:${g.vmid}` }]);
      else if (g.status === 'stopped') kb.push([{ text: '▶️ Starten', callback_data: `ga:start:${g.vmid}` }]);
    }
    kb.push([{ text: '🔄', callback_data: `g:${g.vmid}` }, { text: '⬅️ Alle Gäste', callback_data: 'vms' }]);
    return [text, kb];
  }
  function containersView() {
    const byHost = {};
    for (const c of state.containers) (byHost[c.host] ??= []).push(c);
    const text = '<b>📦 Container</b>\n' + Object.entries(byHost).map(([h, cs]) => `\n<b>${esc(h)}</b>\n` + cs.map(c =>
      `${icon(ctrStatus(c))} ${esc(c.name)}${c.stats && c.state === 'running' ? ` · ${(c.stats.cpu * 100).toFixed(1)}% · ${Math.round(c.stats.mem / 2 ** 20)} MiB` : ` · ${esc(c.state)}`}${c.logs?.errors ? ` · ❗${c.logs.errors}` : ''}`).join('\n')).join('\n');
    const kb = []; const cs = state.containers;
    for (let i = 0; i < cs.length; i += 3) kb.push(cs.slice(i, i + 3).map(c => ({ text: `${icon(ctrStatus(c))} ${c.name}`.slice(0, 24), callback_data: `c:${c.key}`.slice(0, 64) })));
    kb.push([{ text: '🔄 Aktualisieren', callback_data: 'ctrs' }]);
    return [text, kb];
  }
  function containerView(c) {
    const isProt = protect.containers.includes(c.key) || protect.containers.includes(c.name);
    const text = `${icon(ctrStatus(c))} <b>${esc(c.name)}</b> auf <b>${esc(c.host)}</b>\n<code>${esc(c.image)}</code>\n${esc(c.status)}` +
      (c.stats && c.state === 'running' ? `\nCPU ${(c.stats.cpu * 100).toFixed(1)}% · RAM ${Math.round(c.stats.mem / 2 ** 20)} MiB` : '') +
      (c.logs ? `\nLogs (1h): ${c.logs.errors} Fehler, ${c.logs.warnings} Warnungen` : '') +
      (isProt ? '\n🔒 <i>Geschützt – das ist der Bot selbst</i>' : '');
    const kb = [];
    if (!isProt) kb.push(c.state === 'running'
      ? [{ text: '🔁 Neustart', callback_data: `ca:restart:${c.key}`.slice(0, 64) }, { text: '⏹ Stoppen', callback_data: `ca:stop:${c.key}`.slice(0, 64) }]
      : [{ text: '▶️ Starten', callback_data: `ca:start:${c.key}`.slice(0, 64) }]);
    kb.push([{ text: '📜 Logs', callback_data: `cl:${c.key}`.slice(0, 64) }, { text: '🔄', callback_data: `c:${c.key}`.slice(0, 64) }, { text: '⬅️ Alle', callback_data: 'ctrs' }]);
    return [text, kb];
  }
  function issuesText() {
    const ev = state.events.filter(e => !e.noise).slice(0, 15);
    return ev.length ? '<b>⚠️ Letzte Warnungen/Fehler (1h)</b>\n\n' + ev.map(e => `${e.level === 'error' ? '🔴' : '🟡'} <b>${esc(e.container)}</b> <i>vor ${ago(e.ts)}</i>\n<code>${esc(e.msg.slice(0, 160))}</code>`).join('\n\n')
      : '✅ Keine Warnungen oder Fehler in der letzten Stunde.';
  }
  function servicesText() {
    const svcs = buildServices();
    const groups = [...new Set(svcs.map(s => s.group))];
    return '<b>🧩 Services</b>\n' + groups.map(g => `\n<b>${esc(g)}</b>\n` + svcs.filter(s => s.group === g).map(s => `${icon(svcStatus(s))} ${s.url && s.url.startsWith('http') ? `<a href="${esc(s.url)}">${esc(s.name)}</a>` : esc(s.name)}`).join('\n')).join('\n');
  }
  // ---------- server hardware (iRMC / IPMI)
  const BMC_DE = { on: 'Einschalten', soft: 'Herunterfahren (sanft)', off: 'Hart ausschalten', reset: 'Reset (Neustart hart)', cycle: 'Strom aus/an' };
  function serverView() {
    const b = state.bmc;
    if (!b) return ['Kein iRMC konfiguriert.', null];
    const S = n => b.sensors.find(x => x.name === n);
    const val = x => x && x.value != null ? `${x.value} ${x.unit}` : '–';
    const node = state.nodes[b.node];
    let t = `🖥 <b>Server ${esc(b.node)}</b> (${esc(b.name)} ${esc(b.host)})\n\n`;
    if (!b.online) t += `⚪ iRMC nicht erreichbar: ${esc(b.error || '')}\n`;
    else {
      t += b.power === 'on' ? '🟢 <b>Eingeschaltet</b>' : b.power === 'off' ? '⚫ <b>Ausgeschaltet</b>' : '❔ Status unbekannt';
      t += node?.online && node.live ? ` · Proxmox läuft seit ${dur(node.live.uptime)}\n` : b.power === 'on' ? ' · Proxmox (noch) nicht erreichbar\n' : '\n';
      t += `\n⚡ Gesamt: <b>${val(S('Total Power'))}</b>\n   PSU1: ${val(S('PSU1 Power'))} · PSU2: ${val(S('PSU2 Power'))}\n`;
      const temps = b.sensors.filter(x => x.unit === '°C' && x.value != null);
      if (temps.length) t += `\n🌡 ${temps.map(x => `${esc(x.name)} ${x.value}°C`).join(' · ')}\n`;
      const fans = b.sensors.filter(x => x.unit === 'RPM' && x.value != null);
      if (fans.length) t += `🌀 ${fans.map(x => `${esc(x.name.replace(/^FAN/, 'Lüfter '))} ${x.value}`).join(' · ')} RPM\n`;
      const bad = b.sensors.filter(x => x.status && !['ok', 'ns'].includes(x.status));
      if (bad.length) t += `\n⚠️ Auffällig: ${bad.map(x => `${esc(x.name)} (${esc(x.status)})`).join(', ')}\n`;
      t += `\n<i>Stand: ${b.updated ? new Date(b.updated).toLocaleTimeString('de-DE', { timeZone: TZ }) : '–'}</i>`;
    }
    const kb = [];
    if (b.online && b.power === 'off') kb.push([{ text: '⚡ Einschalten', callback_data: 'ba:on' }]);
    if (b.online && b.power === 'on') kb.push([{ text: '⏻ Herunterfahren', callback_data: 'ba:soft' }, { text: '🔄 Reset', callback_data: 'ba:reset' }], [{ text: '⛔ Hart ausschalten', callback_data: 'ba:off' }]);
    kb.push([{ text: '🔄 Aktualisieren', callback_data: 'bm' }]);
    return [t, kb];
  }

  const HELP = `<b>🤖 Selfhost-Bot</b>

/status – Überblick
/nodes – Proxmox-Nodes im Detail
/server – Server-Hardware (iRMC): an/aus, Watt, Temperaturen
/vms – VMs & LXCs (starten/stoppen)
/vm <code>&lt;id|name&gt;</code> – einzelner Gast
/containers – alle Container (start/stop/restart)
/c <code>&lt;name&gt;</code> – einzelner Container
/logs <code>&lt;name&gt; [zeilen]</code> – letzte Logzeilen
/issues – Warnungen & Fehler der letzten Stunde
/services – alle Services mit Links
/mute <code>[minuten]</code> · /unmute – Alarme stummschalten

Alarme kommen automatisch: Service down/up, Node offline, Quorum, Container abgestürzt/unhealthy, VM gestoppt/gestartet, CPU/RAM/Disk dauerhaft hoch, SMART, Fehler-Häufung. Jeden Morgen um 8:00 eine Zusammenfassung.`;

  // ---------- confirmations
  const pending = new Map(); // nonce -> {kind, op, target, exp}
  function ask(chat, msgId, kind, op, target, label) {
    const nonce = crypto.randomBytes(6).toString('hex');
    pending.set(nonce, { kind, op, target, exp: Date.now() + 120000 });
    return edit(chat, msgId, `❓ <b>${esc(label)}</b>\n\nWirklich ausführen? (gilt 2 Minuten)`, [[{ text: '✅ Ja, ausführen', callback_data: `ok:${nonce}` }, { text: '✖️ Abbrechen', callback_data: `no:${kind}:${target}`.slice(0, 64) }]]);
  }
  const OPS_DE = { start: 'Starten', shutdown: 'Herunterfahren', stop: 'Hart stoppen', reboot: 'Neustarten', restart: 'Neustarten' };

  // ---------- update handling
  async function onMessage(m) {
    const chat = m.chat.id;
    if (!chatIds.includes(chat)) { console.warn('telegram: ignored chat', chat); return; }
    const [cmd0, ...args] = (m.text || '').trim().split(/\s+/);
    const cmd = cmd0.split('@')[0].toLowerCase();
    switch (cmd) {
      case '/start': case '/help': return send(chat, HELP);
      case '/status': return send(chat, statusText(), [[{ text: '💻 VMs', callback_data: 'vms' }, { text: '📦 Container', callback_data: 'ctrs' }, { text: '⚠️ Issues', callback_data: 'iss' }]]);
      case '/nodes': return send(chat, nodesText() || 'Keine Nodes erreichbar.');
      case '/server': case '/irmc': case '/power': { const [t, kb] = serverView(); return send(chat, t, kb); }
      case '/vms': case '/guests': { const [t, kb] = guestsView(); return send(chat, t, kb); }
      case '/vm': { const g = args[0] && findGuest(args.join(' ')); if (!g) return send(chat, 'Gast nicht gefunden. /vms zeigt alle.'); const [t, kb] = guestView(g); return send(chat, t, kb); }
      case '/containers': case '/ctrs': { const [t, kb] = containersView(); return send(chat, t, kb); }
      case '/c': case '/container': { const c = args[0] && findContainer(args[0]); if (!c) return send(chat, 'Container nicht gefunden. /containers zeigt alle.'); const [t, kb] = containerView(c); return send(chat, t, kb); }
      case '/logs': {
        const c = args[0] && findContainer(args[0]); if (!c) return send(chat, 'Benutzung: /logs &lt;container&gt; [zeilen]');
        const n = Math.min(80, Math.max(5, parseInt(args[1] || '25', 10) || 25));
        const lines = await tailLogs(c, n);
        const body = lines.map(l => `${new Date(l.ts).toLocaleTimeString('de-DE', { timeZone: TZ })} ${l.level === 'error' ? '❗' : l.level === 'warn' ? '⚠' : ' '} ${l.msg}`).join('\n');
        return send(chat, `📜 <b>${esc(c.name)}</b> – letzte ${lines.length} Zeilen\n<pre>${esc(body.slice(-3600)) || '(leer)'}</pre>`);
      }
      case '/issues': return send(chat, issuesText());
      case '/services': return send(chat, servicesText());
      case '/mute': { const min = Math.min(1440, Math.max(5, parseInt(args[0] || '60', 10) || 60)); muteUntil = Date.now() + min * 60000; return send(chat, `🔕 Alarme für ${min} Minuten stumm. /unmute zum Aufheben.`); }
      case '/unmute': muteUntil = 0; return send(chat, '🔔 Alarme wieder aktiv.');
      default: return send(chat, 'Unbekannter Befehl. /help zeigt alles.');
    }
  }
  async function onCallback(q) {
    const chat = q.message?.chat.id, msgId = q.message?.message_id;
    if (!chatIds.includes(chat)) return api('answerCallbackQuery', { callback_query_id: q.id, text: 'Nicht erlaubt' });
    const d = q.data || ''; let toast = '';
    try {
      if (d === 'bm') { const [t, kb] = serverView(); await edit(chat, msgId, t, kb); toast = 'Aktualisiert'; }
      else if (d.startsWith('ba:')) { const op = d.slice(3); if (!BMC_DE[op]) toast = 'Unbekannt'; else await ask(chat, msgId, 'b', op, 'bmc', `Server ${state.bmc?.node || ''}: ${BMC_DE[op]}`); }
      else if (d === 'vms') { const [t, kb] = guestsView(); await edit(chat, msgId, t, kb); }
      else if (d === 'ctrs') { const [t, kb] = containersView(); await edit(chat, msgId, t, kb); }
      else if (d === 'iss') await edit(chat, msgId, issuesText(), [[{ text: '⬅️ Status', callback_data: 'st' }]]);
      else if (d === 'st') await edit(chat, msgId, statusText(), [[{ text: '💻 VMs', callback_data: 'vms' }, { text: '📦 Container', callback_data: 'ctrs' }, { text: '⚠️ Issues', callback_data: 'iss' }]]);
      else if (d.startsWith('g:')) { const g = findGuest(d.slice(2)); if (g) { const [t, kb] = guestView(g); await edit(chat, msgId, t, kb); } else toast = 'Gast existiert nicht mehr'; }
      else if (d.startsWith('c:')) { const c = findContainer(d.slice(2)); if (c) { const [t, kb] = containerView(c); await edit(chat, msgId, t, kb); } else toast = 'Container existiert nicht mehr'; }
      else if (d.startsWith('cl:')) {
        const c = findContainer(d.slice(3));
        if (c) { const lines = await tailLogs(c, 25); await send(chat, `📜 <b>${esc(c.name)}</b>\n<pre>${esc(lines.map(l => `${new Date(l.ts).toLocaleTimeString('de-DE', { timeZone: TZ })} ${l.msg}`).join('\n').slice(-3600)) || '(leer)'}</pre>`); }
      }
      else if (d.startsWith('ga:')) {
        const [, op, vmid] = d.split(':'); const g = findGuest(vmid);
        if (!g) toast = 'Gast nicht gefunden';
        else if (protect.guests.includes(g.vmid)) toast = 'Geschützt';
        else await ask(chat, msgId, 'g', op, String(g.vmid), `${OPS_DE[op]}: ${g.name} (${g.type === 'lxc' ? 'LXC' : 'VM'} ${g.vmid})`);
      }
      else if (d.startsWith('ca:')) {
        const [, op, ...rest] = d.split(':'); const c = findContainer(rest.join(':'));
        if (!c) toast = 'Container nicht gefunden';
        else if (protect.containers.includes(c.key) || protect.containers.includes(c.name)) toast = 'Geschützt';
        else await ask(chat, msgId, 'c', op, c.key, `${OPS_DE[op]}: Container ${c.name} (${c.host})`);
      }
      else if (d.startsWith('no:')) {
        const [, kind, ...rest] = d.split(':'); const target = rest.join(':');
        if (kind === 'b') { const [t, kb] = serverView(); await edit(chat, msgId, t, kb); }
        else if (kind === 'g') { const g = findGuest(target); if (g) { const [t, kb] = guestView(g); await edit(chat, msgId, t, kb); } }
        else { const c = findContainer(target); if (c) { const [t, kb] = containerView(c); await edit(chat, msgId, t, kb); } }
        toast = 'Abgebrochen';
      }
      else if (d.startsWith('ok:')) {
        const p = pending.get(d.slice(3)); pending.delete(d.slice(3));
        if (!p || p.exp < Date.now()) toast = 'Abgelaufen – bitte nochmal';
        else if (p.kind === 'b') {
          await bmcAction(p.op);
          await edit(chat, msgId, `✅ Server ${esc(state.bmc?.node || '')}: <b>${BMC_DE[p.op]}</b> gesendet.\nStatus aktualisiert sich in ein paar Sekunden.`, [[{ text: '🔄 Status', callback_data: 'bm' }]]);
          console.log(`telegram: bmc power ${p.op} by chat ${chat}`);
        }
        else if (p.kind === 'g') {
          const r = await guestAction(p.target, p.op);
          await edit(chat, msgId, `✅ <b>${OPS_DE[p.op]}</b> für ${esc(r.guest.name)} (${p.target}) gestartet.\nStatus aktualisiert sich in ein paar Sekunden.`, [[{ text: '🔄 Status', callback_data: `g:${p.target}` }, { text: '⬅️ Alle Gäste', callback_data: 'vms' }]]);
          console.log(`telegram: guest ${p.op} ${p.target} by chat ${chat}`);
        } else {
          const c = await containerAction(p.target, p.op);
          await edit(chat, msgId, `✅ Container <b>${esc(c.name)}</b>: ${OPS_DE[p.op]} erledigt.`, [[{ text: '🔄 Status', callback_data: `c:${c.key}`.slice(0, 64) }, { text: '⬅️ Alle', callback_data: 'ctrs' }]]);
          console.log(`telegram: container ${p.op} ${p.target} by chat ${chat}`);
        }
      }
    } catch (e) { toast = 'Fehler: ' + e.message.slice(0, 150); await send(chat, '❌ ' + esc(e.message)); }
    api('answerCallbackQuery', { callback_query_id: q.id, text: toast }).catch(() => {});
  }

  let offset = 0;
  async function pollLoop() {
    try {
      const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 65000);
      for (const u of updates) {
        offset = u.update_id + 1;
        try { if (u.message) await onMessage(u.message); else if (u.callback_query) await onCallback(u.callback_query); }
        catch (e) { console.error('telegram handler', e.message); }
      }
      setImmediate(pollLoop);
    } catch (e) { console.error('telegram poll', e.message); setTimeout(pollLoop, 5000); }
  }

  // ---------- alert engine (diffs the dashboard state every 15 s)
  const prev = { nodes: {}, kuma: {}, ctr: {}, guests: {}, quorate: null, smart: {}, hot: {}, errs: {} };
  let primed = false;
  const hotSince = {};
  function sustained(key, cond, minutes, onFire, onClear) {
    if (cond) { hotSince[key] ??= Date.now(); if (!prev.hot[key] && Date.now() - hotSince[key] >= minutes * 60000) { prev.hot[key] = true; onFire(); } }
    else { delete hotSince[key]; if (prev.hot[key]) { prev.hot[key] = false; onClear?.(); } }
  }
  function checkAlerts() {
    const out = [];
    // nodes
    for (const n of Object.values(state.nodes)) {
      const was = prev.nodes[n.name];
      if (primed && was !== undefined && was !== n.online) out.push(n.online ? `🟢 <b>${esc(n.name)}</b> ist wieder online` : `🔴 <b>${esc(n.name)}</b> ist offline!`);
      prev.nodes[n.name] = n.online;
      if (n.online && n.live) {
        const l = n.live;
        sustained(`${n.name}:cpu`, l.cpu > 0.9, 5, () => out.push(`🔥 <b>${esc(n.name)}</b>: CPU seit 5 Min über 90% (${Math.round(l.cpu * 100)}%)`), () => out.push(`✅ ${esc(n.name)}: CPU wieder normal`));
        sustained(`${n.name}:ram`, l.mem.used / l.mem.total > 0.93, 5, () => out.push(`🧠 <b>${esc(n.name)}</b>: RAM seit 5 Min über 93% (${gib(l.mem.used)} / ${gib(l.mem.total)})`), () => out.push(`✅ ${esc(n.name)}: RAM wieder unter 93%`));
        sustained(`${n.name}:root`, l.rootfs.used / l.rootfs.total > 0.9, 0, () => out.push(`💾 <b>${esc(n.name)}</b>: Root-Disk über 90% voll`));
        for (const d of n.slow?.disks || []) {
          const k = `${n.name}:${d.devpath}`; const was2 = prev.smart[k];
          if (primed && was2 && was2 !== d.health && /FAIL/i.test(d.health)) out.push(`💀 <b>SMART-Fehler</b> auf ${esc(n.name)} ${esc(d.devpath)}: ${esc(d.health)} – Backup prüfen!`);
          prev.smart[k] = d.health;
        }
      }
    }
    // quorum + storage (cluster view)
    const p = primaryNode();
    const cluster = p?.slow?.quorum?.find(x => x.type === 'cluster');
    if (cluster) {
      const q = !!cluster.quorate;
      if (primed && prev.quorate !== null && prev.quorate !== q) out.push(q ? '🟢 Cluster-Quorum wiederhergestellt' : '⚠️ <b>Cluster hat kein Quorum mehr</b> – Proxmox-Konfiguration ist schreibgeschützt');
      prev.quorate = q;
    }
    for (const s of (p?.slow?.storage || []).filter(s => s.active && s.total)) sustained(`stor:${s.storage}`, s.used / s.total > 0.9, 0, () => out.push(`💾 Storage <b>${esc(s.storage)}</b> über 90% voll (${pct(s.used, s.total)}%)`));
    // guests
    for (const g of guests()) {
      const k = g.vmid, was = prev.guests[k];
      if (primed && was && was !== g.status && g.status !== 'unknown' && was !== 'unknown')
        out.push(g.status === 'running' ? `▶️ ${g.type === 'lxc' ? 'LXC' : 'VM'} <b>${esc(g.name)}</b> (${k}) läuft jetzt` : `⏹ ${g.type === 'lxc' ? 'LXC' : 'VM'} <b>${esc(g.name)}</b> (${k}) ist jetzt <b>${esc(g.status)}</b>`);
      if (primed && !was && Object.keys(prev.guests).length) out.push(`✨ Neuer Gast: <b>${esc(g.name)}</b> (${k}) auf ${esc(g.node)}`);
      prev.guests[k] = g.status;
    }
    for (const k of Object.keys(prev.guests)) if (!guests().some(g => String(g.vmid) === String(k)) && guests().length) { out.push(`🗑 Gast ${k} wurde entfernt`); delete prev.guests[k]; }
    // kuma monitors
    for (const [name, m] of Object.entries(state.kuma)) {
      const was = prev.kuma[name];
      if (primed && was !== undefined && was !== m.status && (m.status === 0 || (m.status === 1 && was === 0)))
        out.push(m.status === 0 ? `🔴 <b>${esc(name)}</b> ist DOWN (Uptime Kuma)` : `🟢 <b>${esc(name)}</b> ist wieder UP`);
      prev.kuma[name] = m.status;
    }
    // server power (iRMC)
    if (state.bmc?.online && state.bmc.power) {
      const pw = state.bmc.power;
      if (primed && prev.bmc && prev.bmc !== pw) out.push(pw === 'on' ? `⚡ Server <b>${esc(state.bmc.node)}</b> wurde <b>eingeschaltet</b>` : `⏻ Server <b>${esc(state.bmc.node)}</b> ist jetzt <b>aus</b>`);
      prev.bmc = pw;
    }
    // containers
    const hostsOk = Object.values(state.hosts).every(h => h.online);
    for (const c of state.containers) {
      const st = c.state + (c.health === 'unhealthy' ? ':unhealthy' : ''), was = prev.ctr[c.key];
      if (primed && was && was !== st) {
        if (c.health === 'unhealthy') out.push(`🤒 Container <b>${esc(c.name)}</b> (${esc(c.host)}) ist <b>unhealthy</b>`);
        else if (c.state !== 'running' && was.startsWith('running')) out.push(`💥 Container <b>${esc(c.name)}</b> (${esc(c.host)}) ist <b>${esc(c.state)}</b> – ${esc(c.status)}`);
        else if (c.state === 'running' && !was.startsWith('running')) out.push(`▶️ Container <b>${esc(c.name)}</b> (${esc(c.host)}) läuft wieder`);
      }
      if (primed && !was && Object.keys(prev.ctr).length) out.push(`✨ Neuer Container: <b>${esc(c.name)}</b> auf ${esc(c.host)}`);
      prev.ctr[c.key] = st;
      // error burst: 10+ more errors than at last check within the 1h window
      const e = c.logs?.errors ?? null, we = prev.errs[c.key];
      if (primed && e !== null && we !== undefined && e - we >= 10) out.push(`❗ <b>${esc(c.name)}</b>: ${e - we} neue Fehler in den Logs → /logs ${esc(c.name)}`);
      if (e !== null) prev.errs[c.key] = e;
    }
    if (hostsOk) for (const k of Object.keys(prev.ctr)) if (!state.containers.some(c => c.key === k)) { out.push(`🗑 Container <b>${esc(k)}</b> wurde entfernt`); delete prev.ctr[k]; }
    // only prime once real data is in, so restarts don't spam
    if (!primed && primaryNode() && state.containers.length && Object.keys(state.kuma).length) { primed = true; console.log('telegram: alerts armed'); }
    if (out.length) alert(out.join('\n'));
  }
  setInterval(checkAlerts, 15000);

  // daily summary at 08:00 Berlin time
  let lastDaily = '';
  setInterval(() => {
    const now = new Date(), day = now.toLocaleDateString('de-DE', { timeZone: TZ });
    const hm = now.toLocaleTimeString('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
    if (hm === '08:00' && lastDaily !== day) { lastDaily = day; chatIds.forEach(c => send(c, '☀️ <b>Guten Morgen!</b>\n\n' + statusText())); }
  }, 30000);

  api('setMyCommands', { commands: [
    { command: 'status', description: 'Überblick' }, { command: 'vms', description: 'VMs & LXCs steuern' },
    { command: 'containers', description: 'Container steuern' }, { command: 'server', description: 'Server an/aus, Watt, Temperaturen' }, { command: 'nodes', description: 'Proxmox-Nodes' },
    { command: 'issues', description: 'Warnungen & Fehler' }, { command: 'services', description: 'Services & Links' },
    { command: 'logs', description: 'Logs eines Containers' }, { command: 'mute', description: 'Alarme stummschalten' }, { command: 'help', description: 'Hilfe' },
  ] }).catch(e => console.error('setMyCommands', e.code || '', e.message));
  pollLoop();
  // startup notice is silent (no ping/vibration) – restarts happen e.g. during updates at night
  setTimeout(() => chatIds.forEach(c => api('sendMessage', { chat_id: c, text: ('🤖 <b>Selfhost-Bot ist online.</b>\n\n' + statusText() + '\n\n/help zeigt alle Befehle.').slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: true }).catch(e => console.error('telegram startup', e.message))), 25000);
  console.log('telegram bot started for chats', chatIds.join(','));
};
