// Shared helpers for the overview page and the TV page.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const patch = (el, html) => { if (el && el._h !== html) { el.innerHTML = html; el._h = html; } };
const cssVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function bytes(b, d = 1) { if (b == null || isNaN(b)) return '–'; const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let i = 0; while (Math.abs(b) >= 1024 && i < u.length - 1) { b /= 1024; i++; } return b.toFixed(i < 2 ? 0 : d) + ' ' + u[i]; }
function bits(Bps) { let b = (Bps || 0) * 8; const u = ['bit/s', 'kbit/s', 'Mbit/s', 'Gbit/s']; let i = 0; while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; } return (b < 10 && i ? b.toFixed(1) : Math.round(b)) + ' ' + u[i]; }
function bps(Bps) { let b = Bps || 0; const u = ['B/s', 'KB/s', 'MB/s', 'GB/s']; let i = 0; while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; } return (b < 10 && i ? b.toFixed(1) : Math.round(b)) + ' ' + u[i]; }
function dur(s) { s = Math.floor(s); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; }
function ago(ts) { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; }
const pct = (u, t) => t ? u / t * 100 : 0;
const hot = p => p >= 90 ? cssVar('--bad') : p >= 75 ? cssVar('--warn') : null;

// Network interfaces are labelled by subnet so pve1/pve2 read the same.
function ifaceLabel(name, addr) {
  if (name === 'tailscale0' || addr?.startsWith('100.')) return 'Tailscale';
  if (addr?.startsWith('10.40.32.')) return 'LAN';
  if (addr?.startsWith('192.168.50.')) return 'Storage';
  return name;
}

function spark(series, { max, colors, h = 50, fill = true }) {
  const n = Math.max(...series.map(s => s.length)); if (n < 2) return `<svg class="spark" viewBox="0 0 300 ${h}"></svg>`;
  const w = 300, top = max || Math.max(1, ...series.flat()) * 1.15;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` + series.map((vals, k) => {
    const pts = vals.map((v, i) => [(i / (n - 1)) * w, h - 2 - (Math.min(v || 0, top) / top) * (h - 4)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
    return (fill && k === 0 ? `<path d="${line}L${w} ${h}L0 ${h}Z" fill="${colors[k]}" opacity=".14"/>` : '') +
      `<path d="${line}" fill="none" stroke="${colors[k]}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
  }).join('') + '</svg>';
}

const ICON_CDN = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/';
function iconHtml(icon, name) {
  return `<span class="icon" data-mono="${esc(name[0])}"><img src="${ICON_CDN}${esc(icon)}.svg" alt="" loading="lazy" onerror="this.parentElement.textContent=this.parentElement.dataset.mono"></span>`;
}

// Single source of truth for "is this service OK?": Uptime Kuma first, then container state, then node agent.
function serviceStatus(sv, s) {
  if (sv.pveNode) {
    const n = s.nodes[sv.pveNode];
    if (n?.online) return 'ok';
    const pn = Object.values(s.nodes).find(x => x.online)?.slow?.nodes?.find(x => x.node === sv.pveNode);
    return pn?.status === 'online' ? 'ok' : 'bad';
  }
  const k = s.kuma[sv.kuma];
  if (k?.status === 1) return 'ok'; if (k?.status === 0) return 'bad'; if (k?.status === 2) return 'warn'; if (k?.status === 3) return 'info';
  const c = s.containers.find(c => c.key === sv.container);
  return c ? (c.state === 'running' ? 'ok' : 'bad') : 'unknown';
}

// Primary node = first online agent; used for cluster-wide info (storage, guests, quorum).
const primary = s => Object.values(s.nodes).find(n => n.online && n.slow) || null;

function poll(render, ms = 2000) {
  let fails = 0;
  const tick = async () => {
    try { const r = await fetch('/api/state', { cache: 'no-store' }); render(await r.json(), null); fails = 0; }
    catch (e) { if (++fails > 2) render(null, 'Dashboard backend unreachable – retrying…'); }
    setTimeout(tick, ms);
  };
  tick();
}
