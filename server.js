/**
 * Token Viewer — serveur local de visualisation de la consommation de tokens Claude Code.
 *
 * Zéro dépendance : Node >= 18.
 * Sources : transcripts JSONL dans ~/.claude/projects/<slug>/*.jsonl
 *  - chaque message "assistant" porte message.usage (input/output/cache)
 *  - l'usage d'un même message est dupliqué sur plusieurs lignes -> dédup par message.id
 *
 * Lancement :  node server.js   puis  http://localhost:3456
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT || 3456);
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ */
/* Tarifs ($ / MTok). cacheRead = 0.1x input, cacheCreation = 1.25x.   */
/* ------------------------------------------------------------------ */
const PRICING = [
  [/fable-5/i, { in: 10, out: 50 }],
  [/opus-4-1|opus-4-0|opus-3|claude-3-opus/i, { in: 15, out: 75 }],
  [/opus/i, { in: 5, out: 25 }],
  [/sonnet/i, { in: 3, out: 15 }],
  [/haiku-4/i, { in: 1, out: 5 }],
  [/haiku-3-5|3-5-haiku/i, { in: 0.8, out: 4 }],
  [/haiku/i, { in: 0.25, out: 1.25 }],
];
function priceFor(model) {
  if (!model || model.includes('synthetic')) return { in: 0, out: 0 };
  for (const [re, p] of PRICING) if (re.test(model)) return p;
  return { in: 5, out: 25 };
}
function recordCost(r) {
  const p = priceFor(r.model);
  return (r.input * p.in + r.output * p.out + r.cacheRead * p.in * 0.1 + r.cacheCreation * p.in * 1.25) / 1e6;
}

/* ------------------------------------------------------------------ */
/* Ingestion des JSONL                                                 */
/* ------------------------------------------------------------------ */
/** @type {Map<string, object>} message.id -> record (la dernière ligne d'un id gagne : contenu le plus complet) */
const records = new Map();
/** @type {Map<string, {offset:number, remainder:string}>} chemin -> position de lecture */
const fileState = new Map();

function prettyProject(slug) {
  let s = slug;
  const m = s.match(/Documents-DEV-(.+)$/i);
  if (m) s = m[1];
  s = s.replace(/--claude-worktrees-.+$/i, ' ⌥worktree');
  if (/^C--Users-[^-]+$/i.test(s)) s = '~ (home)';
  return s;
}

function ingestObj(o, project, session) {
  if (o.type !== 'assistant' || !o.message || !o.message.usage) return false;
  const u = o.message.usage;
  const ts = Date.parse(o.timestamp || '') || Date.now();
  const tools = Array.isArray(o.message.content)
    ? o.message.content.filter((c) => c && c.type === 'tool_use').map((c) => c.name || '?')
    : [];
  const id = o.message.id || `${session}:${o.uuid || ts}`;
  records.set(id, {
    id,
    ts,
    project,
    session,
    model: o.message.model || '?',
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheCreation: u.cache_creation_input_tokens || 0,
    tools,
    sidechain: o.isSidechain === true,
  });
  return true;
}

/** Lit les octets ajoutés depuis la dernière lecture (idempotent grâce à la dédup par id). */
function ingestFile(fp) {
  let st;
  try { st = fs.statSync(fp); } catch { return false; }
  let state = fileState.get(fp) || { offset: 0, remainder: '' };
  if (st.size < state.offset) state = { offset: 0, remainder: '' };
  if (st.size === state.offset) return false;

  let fd;
  try {
    fd = fs.openSync(fp, 'r');
    const len = st.size - state.offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, state.offset);
    state.offset = st.size;
    const text = state.remainder + buf.toString('utf8');
    const lines = text.split('\n');
    state.remainder = lines.pop() || '';
    fileState.set(fp, state);

    // chemins : <slug>/<session>.jsonl  ou  <slug>/<session>/subagents/agent-x.jsonl
    const rel = path.relative(PROJECTS_DIR, fp).split(path.sep);
    const project = prettyProject(rel[0] || '?');
    const session = rel.length > 2 ? rel[1] : path.basename(fp, '.jsonl');
    let changed = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (ingestObj(o, project, session)) changed = true;
    }
    return changed;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function fullScan(dir = PROJECTS_DIR, depth = 0) {
  if (depth > 4) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) fullScan(fp, depth + 1);
    else if (e.name.endsWith('.jsonl')) ingestFile(fp);
  }
}

/* ------------------------------------------------------------------ */
/* Watcher temps réel                                                  */
/* ------------------------------------------------------------------ */
const pendingFiles = new Set();
let flushTimer = null;

function scheduleIngest(fp) {
  pendingFiles.add(fp);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    let changed = false;
    for (const f of pendingFiles) if (ingestFile(f)) changed = true;
    pendingFiles.clear();
    if (changed) broadcast('refresh');
  }, 800);
}

function startWatcher() {
  try {
    fs.watch(PROJECTS_DIR, { recursive: true }, (_ev, fname) => {
      if (!fname || !String(fname).endsWith('.jsonl')) return;
      scheduleIngest(path.join(PROJECTS_DIR, String(fname)));
    });
    console.log(`[watch] ${PROJECTS_DIR}`);
  } catch (e) {
    console.error('[watch] indisponible, repli sur un scan périodique :', e.message);
    setInterval(() => { fullScan(); broadcast('refresh'); }, 15000);
  }
}

/* ------------------------------------------------------------------ */
/* Agrégation                                                          */
/* ------------------------------------------------------------------ */
const RANGES = { '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, all: Infinity };

function summarize(rangeKey) {
  const span = RANGES[rangeKey] || RANGES['7d'];
  const now = Date.now();
  const cutoff = span === Infinity ? 0 : now - span;

  const recs = [...records.values()].filter((r) => r.ts >= cutoff).sort((a, b) => a.ts - b.ts);

  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUSD: 0, messages: recs.length };
  const byModel = new Map();
  const byProject = new Map();
  const bySession = new Map();
  const byTool = new Map();
  const bySource = { main: { tokens: 0, cost: 0 }, subagent: { tokens: 0, cost: 0 } };

  const bucketMs = span <= 2 * 86400e3 ? 3600e3 : 86400e3;
  const buckets = new Map();

  const toolEntry = (name) => {
    let t = byTool.get(name);
    if (!t) { t = { tool: name, calls: 0, output: 0, ctxGrowth: 0 }; byTool.set(name, t); }
    return t;
  };

  // ordre par session pour la croissance de contexte
  const perSession = new Map();
  for (const r of recs) {
    const key = r.project + '|' + r.session;
    if (!perSession.has(key)) perSession.set(key, []);
    perSession.get(key).push(r);
  }

  for (const r of recs) {
    const cost = recordCost(r);
    const total = r.input + r.output + r.cacheRead + r.cacheCreation;
    totals.input += r.input; totals.output += r.output;
    totals.cacheRead += r.cacheRead; totals.cacheCreation += r.cacheCreation;
    totals.costUSD += cost;

    const src = r.sidechain ? 'subagent' : 'main';
    bySource[src].tokens += total; bySource[src].cost += cost;

    let m = byModel.get(r.model);
    if (!m) { m = { model: r.model, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 }; byModel.set(r.model, m); }
    m.input += r.input; m.output += r.output; m.cacheRead += r.cacheRead; m.cacheCreation += r.cacheCreation; m.cost += cost;

    let p = byProject.get(r.project);
    if (!p) { p = { project: r.project, tokens: 0, output: 0, cost: 0, sessions: new Set() }; byProject.set(r.project, p); }
    p.tokens += total; p.output += r.output; p.cost += cost; p.sessions.add(r.session);

    const skey = r.project + '|' + r.session;
    let s = bySession.get(skey);
    if (!s) { s = { project: r.project, session: r.session, start: r.ts, end: r.ts, messages: 0, output: 0, tokens: 0, cost: 0 }; bySession.set(skey, s); }
    s.start = Math.min(s.start, r.ts); s.end = Math.max(s.end, r.ts);
    s.messages++; s.output += r.output; s.tokens += total; s.cost += cost;

    const b = Math.floor(r.ts / bucketMs) * bucketMs;
    let bk = buckets.get(b);
    if (!bk) { bk = { t: b, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 }; buckets.set(b, bk); }
    bk.input += r.input; bk.output += r.output; bk.cacheRead += r.cacheRead; bk.cacheCreation += r.cacheCreation; bk.cost += cost;

    // attribution de l'output aux outils du message (réparti à parts égales)
    const names = r.tools.length ? r.tools : ['— réponse texte'];
    const share = r.output / names.length;
    for (const n of names) {
      const t = toolEntry(n);
      if (r.tools.length) t.calls++;
      t.output += share;
    }
  }

  // croissance de contexte (approx.) : delta de taille de prompt entre deux requêtes
  // consécutives d'une même session, attribué aux outils du message précédent.
  for (const list of perSession.values()) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (cur.id === prev.id) continue;
      const delta = (cur.input + cur.cacheRead + cur.cacheCreation) - (prev.input + prev.cacheRead + prev.cacheCreation);
      if (delta <= 0) continue;
      const names = prev.tools.length ? prev.tools : ['— réponse texte'];
      const share = delta / names.length;
      for (const n of names) toolEntry(n).ctxGrowth += share;
    }
  }

  // timeline continue (trous remplis)
  let timeline = [];
  if (buckets.size) {
    const keys = [...buckets.keys()].sort((a, b) => a - b);
    const last = Math.floor(now / bucketMs) * bucketMs;
    for (let t = keys[0]; t <= last; t += bucketMs) {
      timeline.push(buckets.get(t) || { t, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 });
    }
    const MAX_POINTS = 200;
    if (timeline.length > MAX_POINTS) timeline = timeline.slice(-MAX_POINTS);
  }

  const denom = totals.input + totals.cacheRead + totals.cacheCreation;
  return {
    range: rangeKey,
    generatedAt: now,
    totals: { ...totals, total: totals.input + totals.output + totals.cacheRead + totals.cacheCreation, sessions: bySession.size, projects: byProject.size },
    cacheHitRatio: denom ? totals.cacheRead / denom : 0,
    bySource,
    timeline: { bucketMs, points: timeline },
    byTool: [...byTool.values()].sort((a, b) => (b.output + b.ctxGrowth) - (a.output + a.ctxGrowth)).slice(0, 12),
    byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost),
    byProject: [...byProject.values()].map((p) => ({ ...p, sessions: p.sessions.size })).sort((a, b) => b.cost - a.cost).slice(0, 10),
    sessions: [...bySession.values()].sort((a, b) => b.end - a.end).slice(0, 12),
  };
}

/* ------------------------------------------------------------------ */
/* HTTP + SSE                                                          */
/* ------------------------------------------------------------------ */
/** @type {Set<http.ServerResponse>} */
const sseClients = new Set();
function broadcast(event) {
  for (const res of sseClients) {
    try { res.write(`event: ${event}\ndata: ${Date.now()}\n\n`); } catch {}
  }
}
setInterval(() => broadcast('ping'), 25000);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/summary') {
    const body = JSON.stringify(summarize(url.searchParams.get('range') || '7d'));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(body);
  }

  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('event: hello\ndata: ok\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // statique
  let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const fp = path.join(PUBLIC_DIR, file);
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

console.log('[scan] lecture des transcripts…');
const t0 = Date.now();
fullScan();
console.log(`[scan] ${records.size} messages ingérés en ${Date.now() - t0} ms`);
startWatcher();
server.listen(PORT, () => console.log(`Token Viewer ▸ http://localhost:${PORT}`));
