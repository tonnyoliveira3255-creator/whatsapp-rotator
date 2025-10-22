// app.js — WhatsApp Rotator com painel admin, cookies e health-check
// Node 18+ (Render usa 22.x), sem dependências extras
// ----------------------------------------------------------------

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------------------- Config ----------------------------

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '123';
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // opcional

const HEALTH_INTERVAL_SEC = parseInt(process.env.HEALTH_INTERVAL_SEC || '900', 10); // 15min
const HEALTH_FAILS_TO_DISABLE = parseInt(process.env.HEALTH_FAILS_TO_DISABLE || '3', 10);

// Novo: checagem no clique (ligável por env)
const CLICK_HEALTH_ON = String(process.env.CLICK_HEALTH_ON || 'false').toLowerCase() === 'true';
const CLICK_HEALTH_TIMEOUT_MS = parseInt(process.env.CLICK_HEALTH_TIMEOUT_MS || '1500', 10);
const CLICK_HEALTH_RETRY = parseInt(process.env.CLICK_HEALTH_RETRY || '1', 10);

// Chave p/ assinar cookie (derivada da senha para manter simples)
const SESSION_SECRET = crypto.createHash('sha256').update(String(ADMIN_PASS)).digest();

// ----------------------------- Arquivos --------------------------

const LINKS_FILE = path.join(__dirname, 'links.json');       // [{ url, active, percent, clicks, failCount }]
const CLICKS_NDJSON = path.join(__dirname, 'clicks.ndjson'); // 1 linha por clique
const STATS_FILE = path.join(__dirname, 'stats.json');       // uso interno (opcional)

// ---------------------------- Helpers FS -------------------------

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    return true;
  } catch {
    return false;
  }
}

function appendNdjson(file, item) {
  try {
    fs.appendFileSync(file, JSON.stringify(item) + '\n');
  } catch { /* ignore */ }
}

// ----------------- Modelo/normalização de links ------------------

function ensureLinksShape(arr) {
  const a = Array.isArray(arr) ? arr : [];
  return a.map(x => ({
    url: String(x.url || '').trim(),
    active: !!x.active,
    percent: Number.isFinite(Number(x.percent)) ? Number(x.percent) : 0,
    clicks: Number.isFinite(Number(x.clicks)) ? Number(x.clicks) : 0,
    failCount: Number.isFinite(Number(x.failCount)) ? Number(x.failCount) : 0,
  })).filter(x => x.url);
}

function loadLinks() {
  return ensureLinksShape(readJSON(LINKS_FILE, []));
}

function saveLinks(list) {
  return writeJSON(LINKS_FILE, ensureLinksShape(list));
}

// -------------------------- Rate limit leve ----------------------

const ipHits = new Map(); // { ip: {count, ts} }
function allowIp(ip) {
  const now = Date.now();
  const w = ipHits.get(ip) || { count: 0, ts: now };
  if (now - w.ts > 10_000) { // janela 10s
    w.count = 0; w.ts = now;
  }
  w.count++;
  ipHits.set(ip, w);
  return w.count <= 12; // até 12 cliques/10s
}

// ---------------------- Health check (HTTP) ----------------------

/**
 * Faz uma requisição GET rápida ao URL e considera OK se:
 *  - status >= 200 e < 400 (segue redirects automaticamente)
 *  - responde dentro do timeout
 */
async function headLike(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    clearTimeout(t);
    return r.ok || (r.status >= 200 && r.status < 400);
  } catch {
    clearTimeout(t);
    return false;
  }
}

/**
 * Incrementa failCount e desativa se exceder HEALTH_FAILS_TO_DISABLE
 */
async function checkAndMaybeDisable(entry) {
  const ok = await headLike(entry.url, 2500);
  const list = loadLinks();
  const idx = list.findIndex(x => x.url === entry.url);
  if (idx < 0) return;

  if (ok) {
    list[idx].failCount = 0;
  } else {
    list[idx].failCount = (list[idx].failCount || 0) + 1;
    if (list[idx].failCount >= HEALTH_FAILS_TO_DISABLE) {
      list[idx].active = false;
    }
  }
  saveLinks(list);
}

// Executa check em background (somente ativos)
setInterval(() => {
  const actives = loadLinks().filter(x => x.active);
  actives.forEach(l => checkAndMaybeDisable(l));
}, Math.max(HEALTH_INTERVAL_SEC, 60) * 1000);

// ------------------- Auth (cookie assinado simples) ---------------

function sign(payload) {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const h = crypto.createHmac('sha256', SESSION_SECRET).update(p).digest('base64url');
  return `${p}.${h}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [p, h] = token.split('.');
  const h2 = crypto.createHmac('sha256', SESSION_SECRET).update(p).digest('base64url');
  if (h !== h2) return null;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return null; }
}

function setSessionCookie(res, value) {
  res.setHeader('Set-Cookie', `sess=${value}; Path=/; HttpOnly; SameSite=Lax; Secure`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `sess=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax; Secure`);
}

function isAuthed(req) {
  const token = String((req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('sess=')) || '').replace('sess=', '');
  const data = verify(token);
  return data && data.u === ADMIN_USER;
}

// --------------------------- Express -----------------------------

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ------------------------ Página principal -----------------------

/**
 * Redireciona para um link ativo. Se CLICK_HEALTH_ON=true, tenta checar
 * o candidate antes do redirect; se falhar, tenta outro (até CLICK_HEALTH_RETRY).
 * Se nenhum passar, responde 503.
 */
app.get('/', async (req, res) => {
  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
  if (!allowIp(clientIp)) return res.status(429).send('Muitas requisições, tente novamente em instantes.');

  let pool = loadLinks().filter(x => x.active && x.url);
  if (!pool.length) return res.status(500).send('Nenhum número configurado.');

  // normaliza soma % para 100
  let sum = pool.reduce((a, b) => a + (b.percent || 0), 0);
  if (sum !== 100) {
    const eq = Math.floor(100 / pool.length);
    pool.forEach(x => (x.percent = eq));
    pool[0].percent += (100 - eq * pool.length);
    // persiste normalização nos links
    const all = loadLinks();
    for (const p of pool) {
      const i = all.findIndex(a => a.url === p.url);
      if (i >= 0) all[i].percent = p.percent;
    }
    saveLinks(all);
  }

  const pickWeighted = (list) => {
    let r = Math.random() * 100, acc = 0, chosen = list[0];
    for (const l of list) { acc += l.percent; if (r <= acc) { chosen = l; break; } }
    return chosen;
  };

  let attempts = 0;
  let chosen = null;
  let workingUrl = null;

  while (attempts <= CLICK_HEALTH_RETRY && pool.length) {
    attempts++;
    const candidate = pickWeighted(pool);
    if (!candidate) break;

    if (CLICK_HEALTH_ON) {
      const ok = await headLike(candidate.url, CLICK_HEALTH_TIMEOUT_MS);
      if (!ok) {
        // marca falha e tenta outro
        await checkAndMaybeDisable(candidate);
        pool = pool.filter(x => x.url !== candidate.url);
        continue;
      }
    } else {
      // roda checagem em segundo plano para aprender falhas
      checkAndMaybeDisable(candidate).catch(() => {});
    }

    chosen = candidate;
    workingUrl = candidate.url;
    break;
  }

  if (!workingUrl) return res.status(503).send('Todos os números parecem indisponíveis. Tente novamente em instantes.');

  // incrementa clicks + log
  const list = loadLinks();
  const idx = list.findIndex(x => x.url === chosen.url);
  if (idx >= 0) { list[idx].clicks = (list[idx].clicks || 0) + 1; saveLinks(list); }

  appendNdjson(CLICKS_NDJSON, {
    at: new Date().toISOString(),
    ip: clientIp,
    url: workingUrl,
    ua: req.headers['user-agent'] || '',
  });

  res.redirect(workingUrl);
});

// -------------------------- APIs auxiliares ----------------------

app.get('/health', (_, res) => res.json({ ok: true }));

// Lista JSON bruto dos links
app.get('/links', (req, res) => {
  res.json(loadLinks());
});

// Stats simples
app.get('/stats', (req, res) => {
  const links = loadLinks();
  const total = links.reduce((a, b) => a + (b.clicks || 0), 0);
  res.json({ totalClicks: total, items: links.map(x => ({ url: x.url, clicks: x.clicks || 0, active: x.active, percent: x.percent })) });
});

// ------------------------------ Admin ----------------------------

// Login (GET exibe form, POST autentica e seta cookie)
app.get('/admin', (req, res) => {
  if (!isAuthed(req)) return res.send(renderLogin());
  return res.send(renderPanel(loadLinks()));
});

app.post('/admin/login', (req, res) => {
  const u = String(req.body.user || '').trim();
  const p = String(req.body.pass || '').trim();
  if (u === ADMIN_USER && p === ADMIN_PASS) {
    setSessionCookie(res, sign({ u, at: Date.now() }));
    return res.redirect('/admin');
  }
  return res.send(renderLogin('Usuário ou senha inválidos.'));
});

app.post('/admin/logout', (req, res) => {
  clearSessionCookie(res);
  res.redirect('/admin');
});

// Salvar alterações (recebe JSON ou linhas)
app.post('/admin/save', (req, res) => {
  if (!isAuthed(req)) return res.status(401).send('unauthorized');

  const txt = String(req.body.data || '').trim();
  let incoming = [];
  try {
    incoming = JSON.parse(txt);
  } catch {
    // linhas simples: split por \n
    incoming = txt.split('\n').map(s => s.trim()).filter(Boolean).map(v => ({ url: ensureWaUrl(v), active: true, percent: 0 }));
  }

  // mantém shape, normaliza %
  let cleaned = ensureLinksShape(incoming).filter(x => x.url);
  if (!cleaned.length) cleaned = [];

  // garantir soma 100
  let sum = cleaned.reduce((a, b) => a + (b.percent || 0), 0);
  if (sum !== 100 && cleaned.length) {
    const eq = Math.floor(100 / cleaned.length);
    cleaned.forEach(x => (x.percent = eq));
    cleaned[0].percent += (100 - eq * cleaned.length);
  }

  saveLinks(cleaned);
  res.json({ ok: true, count: cleaned.length });
});

// Testar links agora (admin)
app.post('/admin/test', async (req, res) => {
  if (!isAuthed(req)) return res.status(401).send('unauthorized');
  const list = loadLinks();
  const out = [];
  for (const l of list) {
    const ok = await headLike(l.url, 2000);
    if (!ok) {
      l.failCount = (l.failCount || 0) + 1;
      if (l.failCount >= HEALTH_FAILS_TO_DISABLE) l.active = false;
    } else {
      l.failCount = 0;
    }
    out.push({ url: l.url, ok, active: l.active, failCount: l.failCount });
  }
  saveLinks(list);
  res.json({ ok: true, results: out });
});

// ------------------------- Render HTML ---------------------------

function renderLogin(msg) {
  return `<!doctype html>
<html lang="pt-br"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Entrar — Rotador</title>
<style>
  :root{color-scheme:dark light}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial;color:#e5e7eb;background:#0b1220;}
  .wrap{min-height:100dvh;display:grid;place-items:center;padding:24px}
  .card{width:min(560px,100%);background:#0f172a;border:1px solid #1f2937;border-radius:16px;padding:24px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
  .h{font-weight:700;font-size:22px;margin:0 0 6px}
  .muted{color:#9ca3af;font-size:13px;margin:0 0 18px}
  .row{margin:14px 0}
  label{display:block;font-size:13px;color:#cbd5e1;margin:0 0 8px}
  input{width:100%;border:1px solid #334155;background:#0b1220;color:#e5e7eb;border-radius:10px;padding:12px 14px;font-size:15px;outline:none}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 16px;border-radius:12px;border:0;background:#2563eb;color:white;font-weight:600;cursor:pointer}
  .btn:active{transform:translateY(1px)}
  .err{color:#fca5a5;font-size:13px;margin-bottom:8px}
  @media (max-width:420px){.card{padding:18px;border-radius:14px}}
</style>
</head><body>
<div class="wrap"><div class="card">
  <h1 class="h">Entrar</h1>
  <p class="muted">Acesse o painel do rotador</p>
  ${msg ? `<p class="err">${msg}</p>` : ``}
  <form method="POST" action="/admin/login" autocomplete="off">
    <div class="row">
      <label>Usuário</label>
      <input name="user" placeholder="admin" required />
    </div>
    <div class="row">
      <label>Senha</label>
      <input name="pass" placeholder="••••••••" type="password" required />
    </div>
    <div class="row">
      <button class="btn" type="submit">Entrar</button>
    </div>
    <p class="muted">Dica: defina <code>ADMIN_USER</code> e <code>ADMIN_PASSWORD</code> nas variáveis de ambiente.</p>
  </form>
</div></div>
</body></html>`;
}

function renderPanel(links) {
  const items = links.length ? links : [{ url:'', active:false, percent:0, clicks:0, failCount:0 }, { url:'', active:false, percent:0, clicks:0, failCount:0 }];

  const totalClicks = links.reduce((a,b)=>a+(b.clicks||0),0);
  const rows = items.map((l,i)=>`
    <div class="row">
      <input class="url" value="${escapeHtml(l.url||'')}" placeholder="https://wa.me/55999... ou link completo"/>
      <input class="pct" value="${Number(l.percent)||0}" type="number" min="0" max="100" />
      <select class="on">
        <option value="on"${l.active?' selected':''}>on</option>
        <option value="off"${!l.active?' selected':''}>off</option>
      </select>
      <span class="meta">${l.clicks||0} cliques • fails ${l.failCount||0}</span>
    </div>`).join('');

  return `<!doctype html>
<html lang="pt-br"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Admin — Rotador</title>
<style>
  :root{color-scheme:dark light}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial;color:#e5e7eb;background:#0b1220}
  .wrap{max-width:1000px;margin:auto;padding:20px}
  h1{font-size:22px;margin:10px 0 18px}
  .bar{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px}
  .btn{padding:10px 12px;border-radius:10px;border:1px solid #2a3344;background:#0f172a;color:#e5e7eb;cursor:pointer}
  .btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}
  .grid{background:#0f172a;border:1px solid #1f2937;border-radius:16px;padding:14px}
  .row{display:grid;grid-template-columns:1fr 90px 90px auto;gap:8px;margin:8px 0}
  input.url{width:100%;border:1px solid #334155;background:#0b1220;color:#e5e7eb;border-radius:10px;padding:10px 12px}
  input.pct{border:1px solid #334155;background:#0b1220;color:#e5e7eb;border-radius:10px;padding:10px;text-align:center}
  select.on{border:1px solid #334155;background:#0b1220;color:#e5e7eb;border-radius:10px;padding:10px}
  .meta{align-self:center;color:#94a3b8;font-size:13px}
  .foot{display:flex;justify-content:space-between;align-items:center;margin-top:12px;color:#94a3b8;font-size:14px}
  @media (max-width:700px){
    .row{grid-template-columns:1fr 70px 80px;grid-auto-rows:auto}
    .meta{grid-column:1/-1}
  }
</style>
</head><body>
<div class="wrap">
  <h1>Rotador WhatsApp — Admin</h1>

  <div class="bar">
    <button class="btn" id="add">+ Adicionar linha</button>
    <button class="btn" id="fmt">Formatar (só dígitos)</button>
    <button class="btn" id="dedup">Remover duplicatas</button>
    <button class="btn" id="redist">Redistribuir %</button>
    <button class="btn" id="test">Testar links</button>
    <a class="btn" href="/links" target="_blank">Ver JSON /links</a>
    <a class="btn" href="/stats" target="_blank">Ver /stats</a>
    <form method="POST" action="/admin/logout" style="margin-left:auto"><button class="btn">Sair</button></form>
  </div>

  <div class="grid" id="grid">
    ${rows}
  </div>

  <div class="foot">
    <div>Soma das % deve dar 100</div>
    <div>Total de cliques: <b>${totalClicks}</b></div>
    <button class="btn primary" id="save">Salvar</button>
  </div>
</div>

<script>
const grid = document.querySelector('#grid');
document.querySelector('#add').onclick = () => {
  grid.insertAdjacentHTML('beforeend', \`
    <div class="row">
      <input class="url" placeholder="https://wa.me/55999... ou link completo"/>
      <input class="pct" value="0" type="number" min="0" max="100" />
      <select class="on"><option value="on">on</option><option value="off">off</option></select>
      <span class="meta">0 cliques • fails 0</span>
    </div>\`);
};
document.querySelector('#fmt').onclick = () => {
  grid.querySelectorAll('.url').forEach(i => {
    const v = i.value.trim();
    const m = v.match(/\\d{6,}/);
    if (m) i.value = 'https://wa.me/' + m[0];
  });
};
document.querySelector('#dedup').onclick = () => {
  const seen = new Set();
  grid.querySelectorAll('.row').forEach(r => {
    const u = r.querySelector('.url').value.trim();
    if (!u || seen.has(u)) r.remove();
    else seen.add(u);
  });
};
document.querySelector('#redist').onclick = () => {
  const rows = [...grid.querySelectorAll('.row')];
  if (!rows.length) return;
  const eq = Math.floor(100 / rows.length);
  rows.forEach((r,idx) => r.querySelector('.pct').value = eq);
  rows[0].querySelector('.pct').value = eq + (100 - eq*rows.length);
};
document.querySelector('#save').onclick = async () => {
  const rows = [...grid.querySelectorAll('.row')];
  const data = rows.map(r => ({
    url: r.querySelector('.url').value.trim(),
    percent: Number(r.querySelector('.pct').value || 0),
    active: r.querySelector('.on').value === 'on',
  })).filter(x => x.url);
  const resp = await fetch('/admin/save', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({data:JSON.stringify(data)})});
  const j = await resp.json();
  alert(j.ok ? ('Salvo! ' + j.count + ' itens.') : 'Erro ao salvar');
  if (j.ok) location.reload();
};
document.querySelector('#test').onclick = async () => {
  const r = await fetch('/admin/test', {method:'POST'});
  const j = await r.json();
  alert('Teste realizado. Resultados no console.');
  console.log(j);
};
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c] ));
}

// Mantém URL completa ou transforma 6+ dígitos em https://wa.me/NUM
function ensureWaUrl(v) {
  v = String(v||'').trim();
  if (!v) return '';
  const httpRe = /^https?:\/\/.+/i;
  if (httpRe.test(v)) return v;
  if (/^\d+$/.test(v)) return 'https://wa.me/' + v;
  return v;
}

// ------------------------------ Boot -----------------------------

app.listen(PORT, () => {
  console.log(`WhatsApp rotator rodando na porta ${PORT}`);
});
