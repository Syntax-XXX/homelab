// Release-Center: watches Forgejo Actions runs, reviews each successful build
// (gitleaks secret scan + Groq LLM review) and pushes approved commits to GitHub.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const E = process.env;
const CFG = {
  port: +E.PORT || 3000,
  data: E.DATA_DIR || '/data',
  forgejo: (E.FORGEJO_URL || 'http://forgejo:3000').replace(/\/$/, ''),
  forgejoPublic: (E.FORGEJO_PUBLIC_URL || E.FORGEJO_URL || '').replace(/\/$/, ''),
  forgejoToken: E.FORGEJO_TOKEN || '',
  groqKey: E.GROQ_API_KEY || '',
  groqModel: E.GROQ_MODEL || 'openai/gpt-oss-120b',
  ghUser: E.GITHUB_USER || '',
  ghToken: E.GITHUB_TOKEN || '',
  uiUser: E.UI_USER || '',
  uiPass: E.UI_PASSWORD || '',
  buildsPath: E.BUILDS_HINT || 'NAS: PVE-Volume1/builds',
  telegramToken: E.TELEGRAM_BOT_TOKEN || '',
  telegramChat: E.TELEGRAM_CHAT_ID || '',
};
const STATE_FILE = path.join(CFG.data, 'state.json');
const CACHE = path.join(CFG.data, 'cache');
fs.mkdirSync(CACHE, { recursive: true });
let state = { items: {}, repos: {} };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch {}
const save = () => { fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 1)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); };
const log = (...a) => console.log(new Date().toISOString(), ...a);

const sh = (cmd, args, opts = {}) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 64 << 20, timeout: 300000, ...opts },
  (e, out, err) => e && !opts.allowFail ? rej(new Error((String(err) || e.message).replace(/https:\/\/[^@\s]+@/g, 'https://***@').trim().slice(-600))) : res({ out: String(out), err: String(err), code: e ? e.code : 0 })));

async function fj(p, opts = {}) {
  const r = await fetch(CFG.forgejo + '/api/v1' + p, { ...opts, headers: { Authorization: 'token ' + CFG.forgejoToken, 'Content-Type': 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Forgejo ${p}: ${r.status}`);
  return r.json();
}
async function gh(p, opts = {}) {
  const r = await fetch('https://api.github.com' + p, { ...opts, headers: { Authorization: 'Bearer ' + CFG.ghToken, Accept: 'application/vnd.github+json', 'User-Agent': 'homelab-release-center', ...(opts.headers || {}) }, signal: AbortSignal.timeout(30000) });
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
}
async function telegram(text) {
  if (!CFG.telegramToken || !CFG.telegramChat) return;
  try { await fetch(`https://api.telegram.org/bot${CFG.telegramToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: CFG.telegramChat, text, parse_mode: 'HTML', disable_web_page_preview: true }) }); } catch {}
}

// ---------- local mirror of a Forgejo repo (for diffs, scans and pushing)
async function mirror(full) {
  const dir = path.join(CACHE, full.replace('/', '__') + '.git');
  const url = CFG.forgejo + '/' + full + '.git';
  const auth = ['-c', `http.extraHeader=Authorization: token ${CFG.forgejoToken}`];
  if (!fs.existsSync(dir)) await sh('git', [...auth, 'clone', '--mirror', '--quiet', url, dir]);
  else await sh('git', [...auth, '-C', dir, 'remote', 'update', '--prune']);
  return dir;
}
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// ---------- review = gitleaks + LLM
async function review(item) {
  item.status = 'reviewing'; item.error = null; save();
  try {
    const dir = await mirror(item.repo);
    const base = state.repos[item.repo]?.pushedSha;
    const hasBase = base && (await sh('git', ['-C', dir, 'cat-file', '-e', base + '^{commit}'], { allowFail: true })).code === 0;
    const from = hasBase ? base : EMPTY_TREE;
    const stat = (await sh('git', ['-C', dir, 'diff', '--stat', '--stat-width=120', from, item.sha])).out;
    let diff = (await sh('git', ['-C', dir, 'diff', '--no-color', '-U3', from, item.sha, '--', '.', ':(exclude)*.lock', ':(exclude)package-lock.json', ':(exclude)*.min.js', ':(exclude)*.svg'])).out;
    item.diffStat = stat.trim().split('\n').slice(-1)[0] || '';
    item.base = hasBase ? base : null;

    // secret scan on the exact tree that would be pushed
    const wt = path.join(CACHE, 'wt-' + item.id);
    fs.rmSync(wt, { recursive: true, force: true });
    await sh('git', ['-C', dir, 'worktree', 'add', '--detach', '--force', wt, item.sha]);
    const rep = path.join(CACHE, 'gl-' + item.id + '.json');
    await sh('gitleaks', ['dir', wt, '--no-banner', '--redact', '--report-format', 'json', '--report-path', rep, '--exit-code', '0'], { allowFail: true });
    let leaks = []; try { leaks = JSON.parse(fs.readFileSync(rep, 'utf8')); } catch {}
    item.secrets = leaks.map(l => ({ file: (l.File || '').replace(wt + '/', ''), line: l.StartLine, rule: l.RuleID, desc: l.Description }));
    fs.rmSync(rep, { force: true });
    await sh('git', ['-C', dir, 'worktree', 'remove', '--force', wt], { allowFail: true });

    // LLM review – Groq free tier allows ~8k tokens/min, so big diffs are reviewed in chunks
    if (!CFG.groqKey) { item.ai = { verdict: 'warn', summary: 'Keine KI konfiguriert (GROQ_API_KEY fehlt).', findings: [] }; }
    else item.ai = await aiReview(item, diff, stat, hasBase);
    if (item.secrets.length && item.ai.verdict === 'ok') item.ai.verdict = 'warn';
    item.status = 'pending'; item.reviewedAt = Date.now();
    log('reviewed', item.repo, item.sha.slice(0, 7), item.ai.verdict, 'secrets:', item.secrets.length);
    const icon = { ok: '✅', warn: '⚠️', block: '⛔' }[item.ai.verdict];
    telegram(`📦 <b>Build fertig</b>: ${item.repo}\n${esc(item.title)}\nKI: ${icon} ${esc(item.ai.summary).slice(0, 300)}${item.secrets.length ? `\n🔑 ${item.secrets.length} mögliche Secrets!` : ''}\n➡️ Freigabe: ${E.PUBLIC_URL || ''}`);
  } catch (e) { item.status = 'error'; item.error = e.message; log('review failed', item.repo, e.message); }
  save();
}
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));


// ---------- Groq review with chunking + rate-limit handling
const CHUNK = +E.AI_CHUNK_CHARS || 14000, MAX_CHUNKS = +E.AI_MAX_CHUNKS || 8;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function groq(messages, maxTokens = 1500) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + CFG.groqKey, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ model: CFG.groqModel, temperature: 0.1, max_tokens: maxTokens, response_format: { type: 'json_object' }, messages }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return JSON.parse(j.choices[0].message.content);
    const msg = j.error?.message || String(r.status);
    if (r.status === 429 || /rate limit|try again/i.test(msg)) {
      const m = /try again in ([\d.]+)(ms|s|m)/i.exec(msg); const wait = m ? (+m[1]) * ({ ms: 1, s: 1000, m: 60000 }[m[2]]) : 30000;
      log('groq rate limit, warte', Math.round(wait / 1000), 's'); await sleep(Math.min(wait + 1500, 90000)); continue;
    }
    throw new Error('Groq: ' + msg);
  }
  throw new Error('Groq: zu viele Rate-Limit-Versuche');
}
const SYS = `Du bist ein strenger Code-Reviewer für ein privates Homelab-Projekt, das gleich auf GitHub veröffentlicht werden soll.
Prüfe auf: 1) Secrets/Passwörter/Tokens/API-Keys/private Zugangsdaten, 2) Sicherheitslücken (Injection, unsichere Defaults, offene Ports ohne Auth, curl|bash), 3) offensichtliche Bugs, 4) ob es sinnvoll zum Veröffentlichen ist.
Platzhalter wie __RANDOM__, \${VAR}, leere Werte in *.env.example und private LAN-IPs sind KEINE Secrets.
Antworte NUR als JSON: {"verdict":"ok"|"warn"|"block","summary":"2-3 Sätze auf Deutsch","findings":[{"severity":"hoch"|"mittel"|"niedrig","file":"pfad","line":0,"text":"kurz auf Deutsch"}]}.
"block" nur bei echten Secrets oder schweren Sicherheitsproblemen. Maximal 8 Findings.`;
async function aiReview(item, diff, stat, hasBase) {
  // split per file, code/config first, docs last; pack into chunks
  const files = diff.split(/(?=^diff --git )/m).filter(Boolean);
  const isDoc = f => /^diff --git a\/\S+\.(md|txt)\b/.test(f);
  files.sort((a, b) => isDoc(a) - isDoc(b));
  const chunks = []; let cur = '';
  for (let f of files) {
    if (f.length > CHUNK) f = f.slice(0, CHUNK) + '\n[... Datei gekürzt ...]\n';
    if (cur.length + f.length > CHUNK) { chunks.push(cur); cur = ''; }
    cur += f;
  }
  if (cur) chunks.push(cur);
  const skipped = Math.max(0, chunks.length - MAX_CHUNKS);
  const todo = chunks.slice(0, MAX_CHUNKS);
  const head = `Repository: ${item.repo}\nCommit: ${item.title}\nÄnderungen: ${hasBase ? 'seit letztem GitHub-Push' : 'kompletter Stand (noch nie gepusht)'}\nGitleaks-Treffer: ${item.secrets.length ? JSON.stringify(item.secrets.slice(0, 20)) : 'keine'}\n`;
  const parts = [];
  for (let i = 0; i < todo.length; i++) {
    item.progress = `KI prüft Teil ${i + 1}/${todo.length}`; save();
    const res = await groq([{ role: 'system', content: SYS }, { role: 'user', content: `${head}Teil ${i + 1} von ${todo.length}${i === 0 ? `\nDIFF-STAT:\n${stat.slice(-1500)}` : ''}\n\nDIFF:\n${todo[i]}` }]);
    parts.push(res);
  }
  const rank = { ok: 0, warn: 1, block: 2 };
  const verdict = parts.reduce((v, p) => (rank[p.verdict] ?? 1) > rank[v] ? p.verdict : v, 'ok');
  let findings = parts.flatMap(p => Array.isArray(p.findings) ? p.findings : []);
  const sev = { hoch: 0, mittel: 1, niedrig: 2 }; findings.sort((a, b) => (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3)); findings = findings.slice(0, 12);
  let summary = parts[0]?.summary || '';
  if (parts.length > 1) {
    item.progress = 'KI fasst zusammen'; save();
    try {
      const m = await groq([{ role: 'system', content: 'Fasse mehrere Teil-Reviews eines Repositories zu EINEM Urteil zusammen. Antworte NUR als JSON {"summary":"3-4 Sätze auf Deutsch"}.' },
        { role: 'user', content: JSON.stringify(parts.map(p => ({ verdict: p.verdict, summary: p.summary }))) }], 600);
      summary = m.summary || summary;
    } catch { summary = parts.map(p => p.summary).join(' '); }
  }
  item.progress = null;
  return { verdict: ['ok', 'warn', 'block'].includes(verdict) ? verdict : 'warn', summary: String(summary) + (skipped ? ` (Hinweis: ${skipped} weitere Teile wurden aus Zeitgründen nicht von der KI geprüft – gitleaks hat alles geprüft.)` : ''),
    findings, model: CFG.groqModel, chunks: todo.length, skipped };
}

// ---------- push to GitHub
async function push(item, { visibility, ghName, force }) {
  if (!CFG.ghUser || !CFG.ghToken) throw new Error('GitHub ist nicht verbunden (GITHUB_USER / GITHUB_TOKEN fehlen).');
  if (item.secrets?.length && !force) throw new Error('Gitleaks hat mögliche Secrets gefunden – erst bereinigen oder „trotzdem pushen“ bestätigen.');
  const name = (ghName || state.repos[item.repo]?.ghName || item.repo.split('/')[1]).replace(/[^\w.-]/g, '-');
  let r = await gh(`/repos/${CFG.ghUser}/${name}`);
  if (r.status === 404) {
    const forgejoRepo = await fj(`/repos/${item.repo}`).catch(() => ({}));
    r = await gh('/user/repos', { method: 'POST', body: JSON.stringify({ name, private: visibility !== 'public', description: forgejoRepo.description || '', auto_init: false }) });
    if (r.status >= 300) throw new Error('GitHub-Repo anlegen fehlgeschlagen: ' + (r.body?.message || r.status));
    log('created github repo', name, visibility);
  } else if (r.status >= 300) throw new Error('GitHub: ' + (r.body?.message || r.status));
  const dir = await mirror(item.repo);
  const branch = item.branch || 'main';
  const url = `https://x-access-token:${CFG.ghToken}@github.com/${CFG.ghUser}/${name}.git`;
  await sh('git', ['-C', dir, 'push', url, `${item.sha}:refs/heads/${branch}`, ...(force === 'history' ? ['--force'] : [])]);
  await sh('git', ['-C', dir, 'push', url, '--tags'], { allowFail: true });
  state.repos[item.repo] = { ...(state.repos[item.repo] || {}), pushedSha: item.sha, ghName: name, pushedAt: Date.now() };
  item.status = 'pushed'; item.pushedAt = Date.now(); item.ghUrl = `https://github.com/${CFG.ghUser}/${name}`;
  // older pending builds of the same repo are superseded
  for (const o of Object.values(state.items)) if (o.repo === item.repo && o.status === 'pending' && o.created < item.created) o.status = 'superseded';
  save(); log('pushed', item.repo, '->', item.ghUrl);
  telegram(`🚀 <b>${item.repo}</b> auf GitHub gepusht: ${item.ghUrl}`);
}

// ---------- poll Forgejo for finished runs
async function poll() {
  try {
    const repos = await fj('/user/repos?limit=100');
    for (const repo of repos) {
      const runs = (await fj(`/repos/${repo.full_name}/actions/runs?limit=5`)).workflow_runs || [];
      for (const run of runs) {
        const id = `${repo.full_name}#${run.id}`;
        if (state.items[id] || !['success', 'failure'].includes(run.status)) continue;
        state.items[id] = { id, repo: repo.full_name, runId: run.id, title: run.title, sha: run.commit_sha, branch: run.prettyref || 'main',
          runUrl: run.html_url, build: run.status, created: Date.parse(run.stopped || run.updated) || Date.now(), status: run.status === 'success' ? 'queued' : 'failed' };
        save();
        if (run.status === 'success') await review(state.items[id]);
      }
    }
  } catch (e) { log('poll', e.message); }
  setTimeout(poll, 60000);
}

// ---------- HTTP
const PUBLIC = path.join(__dirname, 'public');
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
http.createServer(async (req, res) => {
  if (req.url === '/healthz') return res.end('ok');
  if (CFG.uiPass) {
    const [u, p] = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString().split(':');
    if (u !== CFG.uiUser || p !== CFG.uiPass) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Release-Center"' }); return res.end('Login nötig'); }
  }
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/state') {
    const items = Object.values(state.items).sort((a, b) => b.created - a.created).slice(0, 100);
    return json(res, 200, { items, repos: state.repos, github: { user: CFG.ghUser, connected: !!(CFG.ghUser && CFG.ghToken) }, ai: { model: CFG.groqKey ? CFG.groqModel : null }, buildsPath: CFG.buildsPath, forgejo: CFG.forgejoPublic, links: { code: E.CODE_URL || '', dashboard: E.DASHBOARD_URL || '' } });
  }
  if (req.method === 'POST' && u.pathname.startsWith('/api/item/')) {
    let body = ''; for await (const c of req) { body += c; if (body.length > 10000) return json(res, 413, {}); }
    const [, , , rawId, action] = u.pathname.split('/');
    const item = state.items[decodeURIComponent(rawId)];
    if (!item) return json(res, 404, { error: 'unbekannt' });
    const opts = body ? JSON.parse(body) : {};
    try {
      if (action === 'push') await push(item, opts);
      else if (action === 'reject') { item.status = 'rejected'; save(); }
      else if (action === 'review') { review(item); }
      else return json(res, 400, { error: 'unbekannte Aktion' });
      return json(res, 200, { ok: true, item });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  const f = u.pathname === '/' ? 'index.html' : null;
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  fs.createReadStream(path.join(PUBLIC, f)).pipe(res);
}).listen(CFG.port, () => { log(`release-center on :${CFG.port} · github ${CFG.ghUser ? CFG.ghUser : 'nicht verbunden'} · ki ${CFG.groqKey ? CFG.groqModel : 'aus'}`); poll(); });
