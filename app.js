// app.js — WhatsApp Rotator com pesos (%), ON/OFF, contadores e logs
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Auth simples (variáveis de ambiente)
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS || '123';

// Arquivos
const LINKS_FILE = path.join(__dirname, 'links.json');
const STATS_FILE = path.join(__dirname, 'stats.json');        // { perNumber: {url: clicks}, perDay: {'YYYY-MM-DD': total}, total: n }
const CLICKS_LOG = path.join(__dirname, 'clicks.ndjson');      // linhas {"ts":"...","url":"..."} por clique

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ------------------------ Utils de arquivo ------------------------ */
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

/* -------------------- Carregar / migrar links --------------------- */
// Formatos aceitos:
// 1) Antigo: ["https://wa.me/5599...", "..."]
// 2) Novo:   [{ url, percent, enabled, clicks }]
function loadLinksRaw() {
  return readJSON(LINKS_FILE, []);
}
function normalizeLinks(arr) {
  if (!Array.isArray(arr)) return [];
  // Se vier strings, migra
  if (arr.length && typeof arr[0] === 'string') {
    const pct = Math.floor(100 / arr.length) || 100;
    return arr.map(url => ({
      url: ensureWaUrl(url),
      percent: pct,
      enabled: true,
      clicks: 0
    }));
  }
  // Garante campos e normaliza URL
  let list = arr.map(item => ({
    url: ensureWaUrl(item.url || ''),
    percent: Number(item.percent) >= 0 ? Number(item.percent) : 0,
    enabled: item.enabled !== false,
    clicks: Number(item.clicks) || 0
  }));
  // Se soma das % != 100, redistribui igualmente
  const sum = list.reduce((a, b) => a + b.percent, 0);
  if (sum !== 100) {
    const eq = Math.floor(100 / (list.length || 1));
    list = list.map(x => ({ ...x, percent: eq }));
    // Ajusta resto na primeira posição para totalizar 100
    const current = list.reduce((a, b) => a + b.percent, 0);
    if (list.length && current !== 100) {
      list[0].percent += (100 - current);
    }
  }
  return list;
}
function loadLinks() {
  const raw = loadLinksRaw();
  const list = normalizeLinks(raw);
  // salva migração se mudou
  if (JSON.stringify(raw) !== JSON.stringify(list)) {
    writeJSON(LINKS_FILE, list);
  }
  return list;
}
function saveLinks(list) {
  writeJSON(LINKS_FILE, normalizeLinks(list));
}

/* ------------------------ Stats e Logs ----------------------------- */
function loadStats() {
  const def = { perNumber: {}, perDay: {}, total: 0 };
  return readJSON(STATS_FILE, def);
}
function saveStats(stats) { writeJSON(STATS_FILE, stats); }
function todayKey() {
  const d = new Date();
  return d.toISOString().slice(0,10); // YYYY-MM-DD
}
function logClick(url) {
  const line = JSON.stringify({ ts: new Date().toISOString(), url }) + '\n';
  fs.appendFile(CLICKS_LOG, line, () => {});
}

/* ------------------------ Roteamento ------------------------------- */
// Escolha ponderada por % entre enabled
function pickWeighted(list) {
  const enabled = list.filter(x => x.enabled && x.percent > 0);
  if (!enabled.length) return null;
  // Normaliza soma==100 (já garantimos), mas soma pode mudar ao filtrar OFF:
  const sum = enabled.reduce((a,b)=>a+b.percent,0) || 1;
  let r = Math.random() * sum;
  for (const item of enabled) {
    if ((r -= item.percent) <= 0) return item;
  }
  return enabled[enabled.length-1];
}

// Health
app.get('/health', (req, res) => res.send('ok'));

// Página principal -> redireciona para um número/URL
app.get('/', (req, res) => {
  const list = loadLinks();
  if (!list.length) return res.status(500).send('Nenhum número configurado');

  const chosen = pickWeighted(list);
  if (!chosen) return res.status(500).send('Nenhum número ativo');

  // Contadores
  chosen.clicks = (Number(chosen.clicks) || 0) + 1;
  saveLinks(list);

  const stats = loadStats();
  stats.total = (stats.total || 0) + 1;
  stats.perNumber[chosen.url] = (stats.perNumber[chosen.url] || 0) + 1;
  const key = todayKey();
  stats.perDay[key] = (stats.perDay[key] || 0) + 1;
  saveStats(stats);

  logClick(chosen.url);

  return res.redirect(chosen.url);
});

// JSON cru dos links (para debug / import)
app.get('/links', (req, res) => {
  res.json(loadLinks());
});

// Stats públicas
app.get('/stats', (req, res) => {
  const stats = loadStats();
  const list = loadLinks();
  // anexa info enabled/percent na resposta
  const perNumber = {};
  for (const l of list) {
    perNumber[l.url] = {
      clicks: stats.perNumber[l.url] || 0,
      percent: l.percent,
      enabled: !!l.enabled
    };
  }
  res.json({
    total: stats.total || 0,
    perDay: stats.perDay || {},
    perNumber
  });
});

/* ------------------------ Admin (com auth) ------------------------- */
function auth(req, res, next) {
  const u = String(req.headers['x-admin-user'] || req.query.user || req.body.user || '');
  const p = String(req.headers['x-admin-pass'] || req.query.pass || req.body.pass || '');
  if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  res.status(401).send(`
    <html><body style="font-family:ui-sans-serif, system-ui">
    <h3>Login admin</h3>
    <form method="GET">
      <input name="user" placeholder="user" />
      <input name="pass" placeholder="pass" type="password" />
      <button>Entrar</button>
    </form>
    </body></html>
  `);
}

// UI Admin bonitinha
app.get('/admin', auth, (req, res) => {
  const list = loadLinks();
  const stats = loadStats();
  const totalLinks = list.length;
  const totalEnabled = list.filter(x=>x.enabled).length;
  const lastAt = new Date().toLocaleString('pt-BR');

  res.send(`<!doctype html>
<html lang="pt-br"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Rotador WhatsApp — Admin</title>
<style>
  :root {
    color-scheme: dark;
  }
  body{font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial; background:#0b0f15; color:#e6edf3; margin:0; padding:32px;}
  .wrap{max-width:980px; margin:0 auto;}
  h1{font-size:22px; margin:0 0 8px}
  .muted{color:#8b949e; font-size:13px}
  .card{background:#111827; border:1px solid #243041; border-radius:12px; padding:16px; margin-top:16px}
  .row{display:grid; grid-template-columns: 1fr 120px 100px 110px; gap:10px; align-items:center}
  .row.header{font-size:12px; color:#9aa3ad; text-transform:uppercase; letter-spacing:.06em}
  input[type="text"], input[type="number"]{
    width:100%; padding:10px 12px; background:#0f172a; border:1px solid #233049; color:#e6edf3; border-radius:10px;
  }
  input[type="number"]{ text-align:right }
  .toggle{display:flex; align-items:center; gap:8px}
  .btn{padding:10px 14px; background:#2563eb; color:#fff; border:none; border-radius:10px; cursor:pointer}
  .btn.secondary{background:#374151}
  .btn.danger{background:#dc2626}
  .toolbar{display:flex; gap:8px; margin-top:12px}
  .right{justify-content:flex-end}
  .table{display:flex; flex-direction:column; gap:8px; margin-top:10px; max-height:58vh; overflow:auto}
  .pill{font-size:12px; padding:4px 8px; border-radius:999px; border:1px solid #233049; background:#0f172a; color:#c9d1d9}
  .grid{display:grid; grid-template-columns: repeat(3,1fr); gap:10px}
  a{color:#60a5fa}
</style>
</head><body><div class="wrap">
  <h1>Rotador WhatsApp — Admin</h1>
  <div class="muted">Usuário: <b>${ADMIN_USER}</b> · Links: ${totalLinks} (${totalEnabled} ativos) · Última visualização: ${lastAt}</div>

  <div class="card">
    <div class="toolbar">
      <button class="btn" onclick="addRow()">+ Adicionar linha</button>
      <button class="btn secondary" onclick="formatDigits()">Formatar (só dígitos)</button>
      <button class="btn secondary" onclick="removeDups()">Remover duplicatas</button>
      <button class="btn secondary" onclick="redistribute()">Redistribuir %</button>
      <div class="right" style="flex:1"></div>
      <a href="/links" class="pill" target="_blank">Ver JSON /links</a>
      <a href="/stats" class="pill" target="_blank">Ver /stats</a>
    </div>

    <div class="row header" style="margin-top:10px">
      <div>Número / URL</div><div>%</div><div>Ativo</div><div>Cliques</div>
    </div>
    <div id="table" class="table"></div>

    <div class="toolbar" style="margin-top:14px">
      <div class="muted" id="sumPct"></div>
      <div class="right" style="flex:1"></div>
      <button class="btn" onclick="saveAll()">Salvar</button>
    </div>
  </div>

  <div class="card">
    <div class="grid">
      <div><div class="muted">Total de cliques</div><div style="font-size:20px; margin-top:4px">${(stats.total||0).toLocaleString('pt-BR')}</div></div>
      <div><div class="muted">Hoje</div><div style="font-size:20px; margin-top:4px">${(stats.perDay && stats.perDay['${todayKey()}'] || 0).toLocaleString('pt-BR')}</div></div>
      <div><div class="muted">Logs</div><div style="font-size:14px; margin-top:6px"><span class="pill">clicks.ndjson</span> gravando 1 linha por clique</div></div>
    </div>
  </div>

</div>
<script>
  const ADMIN_USER = ${JSON.stringify(ADMIN_USER)};
  const ADMIN_PASS = ${JSON.stringify(ADMIN_PASS)};
  let data = ${JSON.stringify(loadLinks())};

  function ensureWaUrl(v){
    v = (v||'').trim();
    if (!v) return '';
    // se for só dígitos, vira https://wa.me/NUM
    if (/^\\d+$/.test(v)) return 'https://wa.me/' + v;
    // se já é wa.me ou api.whatsapp, mantém
    return v;
  }

  function render() {
    const box = document.getElementById('table');
    box.innerHTML = '';
    let sum = 0;
    data.forEach((row, i) => {
      sum += Number(row.percent)||0;
      const wrap = document.createElement('div');
      wrap.className = 'row';
      wrap.innerHTML = \`
        <input type="text" value="\${row.url||''}" oninput="onUrl(\${i}, this.value)" />
        <input type="number" min="0" max="100" value="\${row.percent||0}" oninput="onPercent(\${i}, this.value)" />
        <div class="toggle">
          <input type="checkbox" \${row.enabled ? 'checked':''} onchange="onEnabled(\${i}, this.checked)" />
          <button class="btn danger" style="padding:6px 10px" onclick="delRow(\${i})">remover</button>
        </div>
        <div>\${row.clicks||0}</div>
      \`;
      box.appendChild(wrap);
    });
    document.getElementById('sumPct').textContent = 'Soma das %: ' + sum + ' (deve dar 100)';
  }

  function onUrl(i, v){ data[i].url = ensureWaUrl(v); }
  function onPercent(i, v){ data[i].percent = Math.max(0, Math.min(100, Number(v)||0)); }
  function onEnabled(i, v){ data[i].enabled = !!v; }

  function addRow(){
    data.push({ url:'https://wa.me/5585XXXXXXXX', percent:0, enabled:true, clicks:0 });
    render();
  }
  function delRow(i){
    data.splice(i,1); render();
  }
  function removeDups(){
    const seen = new Set();
    data = data.filter(x => {
      const k = (x.url||'').trim();
      if (!k || seen.has(k)) return false;
      seen.add(k); return true;
    });
    render();
  }
  function formatDigits(){
    data = data.map(x => ({...x, url: ensureWaUrl((x.url||'').replace(/\\D/g,''))}));
    render();
  }
  function redistribute(){
    const n = data.length || 1;
    const eq = Math.floor(100 / n);
    data = data.map(x => ({...x, percent: eq}));
    const sum = data.reduce((a,b)=>a+b.percent,0);
    if (sum !== 100 && data.length) data[0].percent += (100 - sum);
    render();
  }

  async function saveAll(){
    // limpeza básica
    data = data.filter(x => (x.url||'').trim());
    // soma % deve dar 100 (o backend ainda normaliza)
    try{
      const r = await fetch('/admin/save', {
        method:'POST',
        headers:{'Content-Type':'application/json','x-admin-user':ADMIN_USER,'x-admin-pass':ADMIN_PASS},
        body: JSON.stringify({ items: data })
      });
      const j = await r.json();
      alert(j.ok ? ('Salvo! Itens: '+j.count) : ('Erro: '+(j.error||'desconhecido')));
      if (j.ok) location.reload();
    }catch(e){ alert('Falha ao salvar: '+e.message) }
  }

  render();
</script>
</body></html>`);
});

// Salvar (JSON com items[])
app.post('/admin/save', auth, (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const cleaned = items
      .map(x => ({
        url: ensureWaUrl(x.url || ''),
        percent: Number(x.percent) || 0,
        enabled: x.enabled !== false,
        clicks: Number(x.clicks) || 0
      }))
      .filter(x => x.url);

    // Normaliza soma de % para 100
    let sum = cleaned.reduce((a,b)=>a+b.percent,0);
    if (sum !== 100 && cleaned.length) {
      const eq = Math.floor(100 / cleaned.length);
      cleaned.forEach(x => x.percent = eq);
      const now = cleaned.reduce((a,b)=>a+b.percent,0);
      if (now !== 100) cleaned[0].percent += (100 - now);
    }

    saveLinks(cleaned);
    return res.json({ ok:true, count: cleaned.length });
  } catch (err) {
    return res.status(400).json({ ok:false, error: err.message });
  }
});

/* ------------------------ Helpers servidor ------------------------ */
function ensureWaUrl(v) {
  v = String(v||'').trim();
  if (!v) return '';
  if (/^https?:\\/\\//i.test(v)) return v;
  // só dígitos => wa.me/NUM
  if (/^\\d+$/.test(v)) return 'https://wa.me/' + v;
  return v; // fallback
}

/* ----------------------------- START ------------------------------ */
app.listen(PORT, () => {
  console.log(`WhatsApp rotator rodando na porta ${PORT}`);
});
