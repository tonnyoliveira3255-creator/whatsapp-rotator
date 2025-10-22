// app.js - WhatsApp Rotator com login via cookie e health-check automático
// Node 18+ (Render está usando 22.x), sem dependências extras

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Config -------------------------------------------------
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '123';
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // opcional
const HEALTH_INTERVAL_SEC = parseInt(process.env.HEALTH_INTERVAL_SEC || '900', 10); // 15min
const HEALTH_FAILS_TO_DISABLE = parseInt(process.env.HEALTH_FAILS_TO_DISABLE || '3', 10);

// chave p/ assinar cookie (derivada da senha)
const SESSION_SECRET = crypto.createHash('sha256').update(String(ADMIN_PASS)).digest();

// --- Arquivos -----------------------------------------------
const LINKS_FILE = path.join(__dirname, 'links.json');
const CLICKS_NDJSON = path.join(__dirname, 'clicks.ndjson');

// --- Util ----------------------------------------------------
function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function ensureLinksShape(arr) {
  // Cada item: { url, percent, active, clicks, fails }
  return (arr || []).map(x => ({
    url: String(x.url || ''),
    percent: Number.isFinite(x.percent) ? Number(x.percent) : 50,
    active: x.active !== false,
    clicks: Number.isFinite(x.clicks) ? Number(x.clicks) : 0,
    fails: Number.isFinite(x.fails) ? Number(x.fails) : 0,
  }));
}

function loadLinks() {
  return ensureLinksShape(readJSON(LINKS_FILE, []));
}

function saveLinks(arr) {
  writeJSON(LINKS_FILE, ensureLinksShape(arr));
}

function appendClickLog(row) {
  fs.appendFileSync(CLICKS_NDJSON, JSON.stringify(row) + '\n');
}

// Salva com segurança crua (já validada antes)
function saveRawLinks(arr) {
  fs.writeFileSync(LINKS_FILE, JSON.stringify(arr, null, 2));
}

// --- Cookie mini-sessão -------------------------------------
function sign(data) {
  const h = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${h}`;
}
function verify(signed) {
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const data = signed.slice(0, i);
  const h = signed.slice(i + 1);
  const good = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  if (crypto.timingSafeEqual(Buffer.from(h), Buffer.from(good))) return data;
  return null;
}
function setSessionCookie(res, user) {
  const payload = `${user}|${Date.now()}`; // simples
  const value = sign(payload);
  res.setHeader('Set-Cookie', [
    `adm=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`
  ]);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'adm=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
function getCookie(req, name) {
  const h = req.headers.cookie || '';
  const m = h.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}
function isAuthed(req) {
  const c = getCookie(req, 'adm');
  if (!c) return false;
  const data = verify(c);
  if (!data) return false;
  const [user, ts] = data.split('|');
  if (user !== ADMIN_USER) return false;
  // sessão válida por 7 dias
  if (Date.now() - Number(ts) > 7 * 24 * 3600 * 1000) return false;
  return true;
}

// --- HTML: Login (responsivo / mobile friendly) --------------
function renderLogin(res, msg = "") {
  res.type("html").send(`<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>Login admin</title>
<style>
:root{color-scheme:dark light}
*{box-sizing:border-box}
body{
  margin:0; min-height:100svh; display:grid; place-items:center;
  background:#0b0f13; color:#e7eef6;
  font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;
  padding:clamp(16px,2.5vw,24px);
  padding-left:calc(env(safe-area-inset-left) + 16px);
  padding-right:calc(env(safe-area-inset-right) + 16px);
}
.card{
  width:min(440px,100%); background:#10151b; border:1px solid #1d2632;
  border-radius:16px; padding:20px; box-shadow:0 12px 40px rgba(0,0,0,.25);
}
h1{margin:0 0 4px; font-size:22px}
.sub{opacity:.75; font-size:14px; margin-bottom:20px}
.msg{display:${msg ? "block" : "none"}; background:#1b2735; color:#ffd6d6;
  border:1px solid #3b2020; border-radius:12px; padding:10px 12px; font-size:14px; margin-bottom:12px}
label{display:block; font-size:14px; margin:10px 0 6px; color:#a9bccf}
.field{position:relative; background:#0e1319; border:1px solid #223044;
  border-radius:12px; padding:0 12px; display:flex; align-items:center}
input{
  appearance:none; border:0; background:transparent; color:#e7eef6;
  width:100%; height:48px; font-size:16px; outline:none;
}
.toggle{background:none; border:0; color:#9fb2c8; cursor:pointer; font-size:13px; padding:6px 8px; border-radius:8px}
.toggle:active{transform:scale(.98)}
.row{display:grid; gap:12px}
.actions{margin-top:16px; display:flex; gap:12px}
.btn{appearance:none; border:0; border-radius:12px; height:48px; padding:0 16px; font-size:16px; cursor:pointer}
.btn.primary{background:#2b87ff; color:#fff; flex:1}
.btn.secondary{background:#18202b; color:#cfe6ff}
.meta{margin-top:10px; font-size:12px; opacity:.6; text-align:center}
@media (max-width:420px){.actions{flex-direction:column}.btn{width:100%}}
</style>
</head>
<body>
  <main class="card" role="dialog" aria-label="Login administrador">
    <h1>Entrar</h1>
    <div class="sub">Acesse o painel do rotador</div>
    <div class="msg" role="alert">${msg ? String(msg).replace(/</g,"&lt;") : ""}</div>
    <form class="row" method="POST" action="/login" autocomplete="on" novalidate>
      <div>
        <label for="user">Usuário</label>
        <div class="field"><input id="user" name="user" inputmode="text" autocomplete="username" placeholder="admin" required/></div>
      </div>
      <div>
        <label for="pass">Senha</label>
        <div class="field">
          <input id="pass" name="pass" type="password" autocomplete="current-password" placeholder="••••••••" required/>
          <button class="toggle" type="button" aria-label="mostrar senha" onclick="
            const p=document.getElementById('pass');
            p.type = p.type==='password' ? 'text' : 'password';
            this.textContent = p.type==='password' ? 'mostrar' : 'ocultar';
          ">mostrar</button>
        </div>
      </div>
      <div class="actions">
        <button class="btn secondary" type="reset">Limpar</button>
        <button class="btn primary" type="submit">Entrar</button>
      </div>
      <div class="meta">Dica: defina <code>ADMIN_USER</code> e <code>ADMIN_PASSWORD</code> nas variáveis de ambiente.</div>
    </form>
  </main>
  <script>setTimeout(()=>document.getElementById('user')?.focus(),50)</script>
</body>
</html>`);
}

// --- Helpers de URL -----------------------------------------
function ensureWaUrl(v) {
  v = String(v || '').trim();
  if (!v) return '';
  // mantém URLs já completas (http/https)
  const httpRe = /^https?:\/\/.*/i;
  if (httpRe.test(v)) return v;
  // só dígitos => wa.me/NUM
  if (/^\d+$/.test(v)) return 'https://wa.me/' + v;
  // fallback (deixa como está)
  return v;
}

// Escolha ponderada por percent (apenas links ativos)
function pickWeighted(list) {
  const arr = list.filter(x => x.active && x.percent > 0);
  const sum = arr.reduce((s, it) => s + it.percent, 0);
  if (!arr.length || sum <= 0) return null;
  const r = Math.random() * sum;
  let acc = 0;
  for (const it of arr) {
    acc += it.percent;
    if (r <= acc) return it;
  }
  return arr[arr.length - 1];
}

// --- Middleware / Parsers -----------------------------------
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// --- Auth: rotas /login e proteção /admin -------------------
app.post('/login', (req, res) => {
  const { user, pass } = req.body || {};
  if (String(user) === ADMIN_USER && String(pass) === ADMIN_PASS) {
    setSessionCookie(res, ADMIN_USER);
    return res.redirect('/admin');
  }
  return renderLogin(res, 'Usuário ou senha inválidos.');
});

app.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.redirect('/admin');
});

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  return renderLogin(res);
}

// --- Painel Admin -------------------------------------------
app.get('/admin', requireAuth, (req, res) => {
  const links = loadLinks();
  const total = links.reduce((s, x) => s + (x.percent || 0), 0);
  const activeCount = links.filter(x => x.active).length;
  const last = new Date().toLocaleString('pt-BR');

  // painel (o seu visual já melhorado anteriormente)
  res.type('html').send(`<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>Rotador WhatsApp — Admin</title>
<style>
:root{color-scheme:dark light}
*{box-sizing:border-box}
body{margin:0;background:#0b0f13;color:#e7eef6;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif}
.wrap{max-width:980px;margin:auto;padding:16px}
h1{margin:8px 0 16px;font-size:20px}
.card{background:#10151b;border:1px solid #1d2632;border-radius:14px;padding:16px;margin-bottom:16px}
.row{display:grid;grid-template-columns:1fr 100px 80px 100px;gap:10px;align-items:center}
.row input, .row select{height:40px;border-radius:10px;border:1px solid #223044;background:#0e1319;color:#e7eef6;padding:0 10px;font-size:14px}
.btn{height:40px;border-radius:10px;border:0;cursor:pointer;font-size:14px}
.btn.blue{background:#2b87ff;color:#fff}
.btn.red{background:#372127;color:#ffd6d6}
.btn.gray{background:#18202b;color:#cfe6ff}
.small{font-size:12px;opacity:.7}
.flex{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.badge{padding:2px 8px;border-radius:999px;background:#19212c;border:1px solid #263142;font-size:12px}
.table{display:grid;gap:10px}
.header{opacity:.7;font-size:12px;display:grid;grid-template-columns:1fr 100px 80px 100px;padding:0 6px}
footer{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-top:10px}
@media (max-width:720px){
  .row,.header{grid-template-columns:1fr 1fr}
}
</style>
</head>
<body>
<div class="wrap">
  <h1>Rotador WhatsApp — Admin</h1>
  <div class="small">Usuário: <b>admin</b> · Links: ${links.length} (${activeCount} ativos) · Última visualização: ${last}</div>

  <div class="card">
    <div class="flex" style="justify-content:space-between;margin-bottom:10px">
      <div class="flex">
        <button class="btn gray" onclick="addRow()">+ Adicionar linha</button>
        <button class="btn gray" onclick="formatDigits()">Formatar (só dígitos)</button>
        <button class="btn gray" onclick="dedup()">Remover duplicatas</button>
        <button class="btn gray" onclick="rebal()">Redistribuir %</button>
        <button class="btn gray" onclick="testLinks()">Testar links</button>
      </div>
      <div class="flex">
        <a class="badge" href="/links" target="_blank">Ver JSON /links</a>
        <a class="badge" href="/stats" target="_blank">Ver /stats</a>
      </div>
    </div>

    <div class="header"><div>NÚMERO / URL</div><div>%</div><div>ATIVO</div><div>CLICKS</div></div>
    <div id="table" class="table"></div>

    <div class="small" style="margin-top:6px">Soma das %: <b id="sum">${total}</b> (deve dar 100)</div>

    <footer>
      <form method="POST" action="/logout"><button class="btn red">Sair</button></form>
      <button class="btn blue" onclick="save()">Salvar</button>
    </footer>
  </div>

  <div class="card small">
    <div>Logs: <code>clicks.ndjson</code> · Clique gera 1 linha. Falhas consecutivas desativam link após <b>${HEALTH_FAILS_TO_DISABLE}</b> erros.</div>
  </div>
</div>

<script>
const init = ${JSON.stringify(links)};

function rowTpl(i, it){
  return \`
    <div class="row">
      <input data-k="url" value="\${it.url}" placeholder="https://wa.me/5599... ou URL completa"/>
      <input data-k="percent" type="number" min="0" max="100" value="\${it.percent}"/>
      <select data-k="active">
        <option value="true"\${it.active?' selected':''}>on</option>
        <option value="false"\${!it.active?' selected':''}>off</option>
      </select>
      <div class="small">\${it.clicks||0}</div>
    </div>\`;
}

function render(list){ table.innerHTML = list.map(rowTpl).join(''); updateSum(); }
function collect(){
  return Array.from(document.querySelectorAll('#table .row')).map(r=>{
    const o = {};
    r.querySelectorAll('[data-k]').forEach(inp=>{
      const k = inp.getAttribute('data-k');
      let v = inp.value;
      if (k==='percent') v = Number(v||0);
      if (k==='active') v = (v==='true');
      o[k]=v;
    });
    return o;
  });
}
function updateSum(){
  const s = collect().reduce((a,b)=>a + Number(b.percent||0), 0);
  sum.textContent = s;
}
function addRow(){
  table.insertAdjacentHTML('beforeend', rowTpl(0, {url:'',percent:50,active:true,clicks:0}));
}
function formatDigits(){
  document.querySelectorAll('input[data-k="url"]').forEach(inp=>{
    const only = inp.value.replace(/\\D+/g,'');
    if (only) inp.value = 'https://wa.me/' + only;
  });
}
function dedup(){
  const arr = collect();
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = it.url.trim().toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  render(out);
}
function rebal(){
  const arr = collect();
  const n = arr.length || 1;
  const eq = Math.floor(100 / n);
  let sum = eq*n;
  for (let i=0;i<n;i++) arr[i].percent = eq;
  arr[0].percent += (100 - sum);
  render(arr);
}
async function save(){
  const data = collect();
  const r = await fetch('/admin/save', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
  const j = await r.json();
  alert(j.ok ? 'Salvo com sucesso!' : ('ERRO: ' + (j.error||'desconhecido')));
}
async function testLinks(){
  const r = await fetch('/admin/test', {method:'POST'});
  const j = await r.json();
  alert('OK: '+j.ok+' | testados: '+j.tested+' | desativados: '+(j.autoDisabled||0));
}
render(init);

table.addEventListener('input', e=>{ if(e.target.matches('[data-k="percent"]')) updateSum(); });
</script>
</body>
</html>`);
});

// salvar alterações
app.post('/admin/save', requireAuth, (req, res) => {
  try {
    const arr = Array.isArray(req.body) ? req.body : [];
    const cleaned = arr.map(it => ({
      url: ensureWaUrl(it.url),
      percent: Math.max(0, Math.min(100, Number(it.percent||0))),
      active: !!it.active,
      clicks: Number(it.clicks||0),
      fails: Number(it.fails||0),
    })).filter(x => x.url);

    // normaliza soma de % para 100
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

// testar agora (ping) — desativa ao exceder limite de falhas
app.post('/admin/test', requireAuth, async (req, res) => {
  const { tested, autoDisabled } = await healthCheckAll();
  res.json({ ok:true, tested, autoDisabled });
});

// JSON público
app.get('/links', (req, res) => {
  res.json(loadLinks());
});
app.get('/stats', (req, res) => {
  // resumo simples do NDJSON (total de linhas)
  let total = 0, today = 0;
  try {
    const lines = fs.readFileSync(CLICKS_NDJSON, 'utf8').trim().split('\n').filter(Boolean);
    total = lines.length;
    const d = new Date().toISOString().slice(0,10);
    today = lines.filter(l => l.includes(`"day":"${d}"`)).length;
  } catch {}
  res.json({ total, today });
});

// Health simples da app
app.get('/health', (req, res) => res.send('ok'));

// Rotador
app.get('/', async (req, res) => {
  const links = loadLinks();
  const chosen = pickWeighted(links);
  if (!chosen) return res.status(500).send('Nenhum número configurado.');

  // registra clique
  chosen.clicks = (chosen.clicks || 0) + 1;
  saveLinks(links);

  const now = new Date();
  appendClickLog({
    ts: now.toISOString(),
    day: now.toISOString().slice(0,10),
    url: chosen.url, ua: req.headers['user-agent']||'',
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''
  });

  // redireciona
  res.redirect(chosen.url);
});

// --- Health check / auto disable -----------------------------
// Regra: para cada link ativo, faz um fetch HEAD/GET; se erro de rede
// ou status >= 400 por N vezes seguidas, desativa e dispara webhook.

async function checkOneLink(it) {
  try {
    const controller = new AbortController();
    const t = setTimeout(()=>controller.abort(), 8000);
    const resp = await fetch(it.url, { method:'GET', redirect:'follow', signal: controller.signal });
    clearTimeout(t);
    // Considera saudável status 2xx ou 3xx
    return resp.status < 400;
  } catch {
    return false;
  }
}

async function healthCheckAll() {
  let links = loadLinks();
  let tested = 0, autoDisabled = 0;

  for (const it of links) {
    if (!it.active) continue;
    tested++;
    const ok = await checkOneLink(it);
    if (ok) {
      it.fails = 0;
    } else {
      it.fails = (it.fails || 0) + 1;
      if (it.fails >= HEALTH_FAILS_TO_DISABLE) {
        it.active = false;
        autoDisabled++;
        notifyWebhook({
          type: 'link_auto_disabled',
          url: it.url,
          reason: `Falhou ${it.fails}x seguidas`,
          at: new Date().toISOString()
        });
      }
    }
  }
  saveLinks(links);
  return { tested, autoDisabled };
}

function notifyWebhook(payload) {
  if (!WEBHOOK_URL) return;
  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  }).catch(()=>{});
}

// Agenda verificação periódica
setInterval(healthCheckAll, HEALTH_INTERVAL_SEC * 1000);

// --- Start ---------------------------------------------------
app.listen(PORT, () => console.log(`WhatsApp rotator rodando na porta ${PORT}`));

