// app.js — WhatsApp Rotator com painel bonito
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Proteção simples por variável de ambiente (defina no Render)
// Render → Environment → ADMIN_USER / ADMIN_PASSWORD
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '123';

// Caminho do arquivo com os links
const LINKS_FILE = path.join(__dirname, 'links.json');

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- util ----------

function loadLinks() {
  try {
    const raw = fs.readFileSync(LINKS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('links.json inválido');
    return arr;
  } catch (e) {
    console.error('Erro lendo links.json:', e.message);
    return [];
  }
}

function saveLinks(arr) {
  fs.writeFileSync(LINKS_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

/** normaliza uma entrada (número ou URL) para URL wa.me */
function normalizeItem(s) {
  if (!s) return null;
  let v = String(s).trim();

  // se já for URL, mantemos
  if (/^https?:\/\//i.test(v)) return v;

  // só dígitos? vira wa.me
  const digits = v.replace(/\D+/g, '');
  if (digits.length >= 10) {
    return `https://wa.me/${digits}`;
  }
  return null;
}

/** recebe texto (linhas ou JSON array) e devolve array normalizado/único */
function parseAnyToLinks(text) {
  let items = [];
  const trimmed = (text || '').trim();

  if (!trimmed) return [];

  // Se vier JSON array válido, usa direto
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        items = arr;
      }
    } catch (_) { /* cai para linhas */ }
  }

  // Caso contrário, trata como "uma por linha"
  if (items.length === 0) {
    items = trimmed
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
  }

  // Normaliza e deduplica
  const norm = [];
  const seen = new Set();
  for (const it of items) {
    const n = normalizeItem(it);
    if (n && !seen.has(n)) {
      seen.add(n);
      norm.push(n);
    }
  }
  return norm;
}

// ---------- auth ----------

function auth(req, res, next) {
  // para ficar simples e sem header Basic, uso prompt no front /admin
  // e comparo aqui pela sessão em memória (bem básico) ou query
  // Para este projeto simples, usaremos um cookie leve.
  const okCookie = req.headers.cookie && req.headers.cookie.includes('rotok=1');
  const u = req.query.user;
  const p = req.query.pass;

  if (okCookie) return next();

  if (u === ADMIN_USER && p === ADMIN_PASS) {
    res.setHeader('Set-Cookie', 'rotok=1; Path=/; HttpOnly; SameSite=Lax');
    return res.redirect('/admin');
  }

  // Se vier só user, mostra prompt
  if (typeof u !== 'undefined' || typeof p !== 'undefined') {
    return res.status(401).send('Credenciais inválidas.');
  }
  next();
}

// ---------- rotas públicas ----------

app.get('/health', (_req, res) => res.send('ok'));

app.get('/links', (_req, res) => {
  res.json(loadLinks());
});

app.get('/', (req, res) => {
  const links = loadLinks();
  if (!links.length) return res.status(500).send('Nenhum número configurado.');
  const link = links[Math.floor(Math.random() * links.length)];
  return res.redirect(link);
});

// ---------- admin UI ----------

app.get('/admin', auth, (req, res) => {
  const links = loadLinks();
  const now = new Date().toLocaleString('pt-BR', { hour12: false });

  res.send(`<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Rotador WhatsApp — Admin</title>
  <style>
    :root{
      --bg:#0b0d10; --card:#131820; --muted:#8aa0b2; --text:#e8eef4;
      --accent:#6ec1ff; --accent-2:#3a7bd5; --ok:#2ecc71; --bad:#ff6b6b;
      --border:#223042;
    }
    *{box-sizing:border-box}
    body{
      margin:0; background:var(--bg); color:var(--text);
      font: 15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Arial;
    }
    .wrap{
      max-width: 980px; padding: 28px 20px; margin: 0 auto;
    }
    .top{
      display:flex; align-items:center; gap:14px; margin-bottom:18px;
    }
    .badge{background:var(--border); color:var(--muted); padding:4px 8px; border-radius:999px; font-size:12px}
    .card{
      background:var(--card); border:1px solid var(--border);
      border-radius:14px; padding:18px;
    }
    h1{font-size:22px; margin:0 0 4px}
    p.sub{color:var(--muted); margin:0 0 14px}
    .row{display:flex; gap:12px; flex-wrap:wrap; align-items:center}
    .spacer{flex:1}
    textarea{
      width:100%; min-height: 320px; resize: vertical;
      background:#0d1218; color:var(--text);
      border:1px solid var(--border); border-radius:12px;
      padding:14px; font: 14px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;
    }
    .hint{color:var(--muted); font-size:12px; margin-top:8px}
    .btn{
      appearance:none; border:1px solid var(--border);
      background:#0d1218; color:var(--text);
      padding:10px 14px; border-radius:10px; cursor:pointer;
    }
    .btn.primary{
      background: linear-gradient(90deg,var(--accent),var(--accent-2));
      border: none; color:#001018; font-weight:600;
    }
    .btn.ghost{background:transparent}
    .btn:hover{filter:brightness(1.05)}
    .btn:active{transform:translateY(1px)}
    .toolbar{display:flex; gap:8px; flex-wrap:wrap; margin:12px 0}
    .count{color:var(--muted); font-size:13px}
    .toast{
      position:fixed; inset:auto 20px 20px auto;
      background:#101820; border:1px solid var(--border);
      padding:10px 12px; border-radius:8px; display:none;
    }
    a.link{color:var(--accent)}
    .tag{background:#0d1218; border:1px solid var(--border); color:var(--muted);
         padding:4px 8px; border-radius:999px; font-size:12px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <h1 style="margin:0">Rotador WhatsApp — Admin</h1>
      <span class="badge">Usuário: ${ADMIN_USER}</span>
      <span class="tag">${links.length} link(s)</span>
      <div class="spacer"></div>
      <a class="link" href="/links" target="_blank">Ver JSON /links</a>
    </div>

    <div class="card">
      <p class="sub">Cole **um por linha**: número (ex: 55999...) ou URL completa (ex: https://wa.me/55999...).<br>
      Se colar um JSON <code>[...]</code>, também funciona. <span class="hint">Última atualização visualizada: ${now}</span></p>

      <div class="toolbar">
        <button class="btn" id="addLine">+ Adicionar linha</button>
        <button class="btn" id="formatBtn">Formatar (só dígitos)</button>
        <button class="btn" id="dedupeBtn">Remover duplicatas</button>
        <button class="btn ghost" id="clearBtn">Limpar</button>
        <div class="spacer"></div>
        <span class="count" id="countInfo">${links.length} link(s)</span>
      </div>

      <textarea id="ta" placeholder="Exemplo:
5599988887777
https://wa.me/559997776666
">
${links.map(l => {
  // mostrar como número quando for wa.me/123...
  const m = String(l).match(/wa\.me\/(\d+)/);
  return m ? m[1] : l;
}).join('\n')}
      </textarea>

      <div class="toolbar" style="justify-content:flex-end">
        <button class="btn primary" id="saveBtn">Salvar</button>
      </div>

      <p class="hint">Dica: Números serão salvos como <code>https://wa.me/NUMERO</code>. URLs completas são mantidas.</p>
    </div>
  </div>

  <div class="toast" id="toast"></div>

<script>
  const ta = document.getElementById('ta');
  const info = document.getElementById('countInfo');
  const toast = document.getElementById('toast');

  function showToast(msg, ok=true){
    toast.style.display='block';
    toast.style.borderColor = ok ? '#1f5130' : '#553030';
    toast.style.color = ok ? '#a9f0c3' : '#ffb3b3';
    toast.textContent = msg;
    setTimeout(() => { toast.style.display='none'; }, 2500);
  }

  function getLines(){
    return ta.value.split('\\n').map(s => s.trim()).filter(Boolean);
  }

  function setLines(lines){
    ta.value = lines.join('\\n');
    updateCount();
  }

  function updateCount(){
    const n = getLines().length;
    info.textContent = n + ' link(s)';
  }

  document.getElementById('addLine').onclick = () => {
    ta.value += (ta.value.endsWith('\\n') || ta.value==='' ? '' : '\\n');
    ta.value += '';
    ta.focus();
    updateCount();
  };

  document.getElementById('clearBtn').onclick = () => {
    ta.value = '';
    updateCount();
  };

  document.getElementById('formatBtn').onclick = () => {
    const out = getLines().map(v => {
      if (/^https?:\\/\\//i.test(v)) return v;      // URL? mantém
      const d = v.replace(/\\D+/g,'');
      return d || '';
    }).filter(Boolean);
    setLines(out);
    showToast('Formatado (apenas dígitos em números).');
  };

  document.getElementById('dedupeBtn').onclick = () => {
    const set = new Set(getLines());
    setLines([...set]);
    showToast('Duplicatas removidas.');
  };

  ta.addEventListener('input', updateCount);

  document.getElementById('saveBtn').onclick = async () => {
    const raw = ta.value;
    const form = new URLSearchParams();
    form.set('data', raw);

    try {
      const r = await fetch('/admin/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form
      });
      const j = await r.json();
      if (j.ok){
        updateCount();
        showToast('Salvo com sucesso ✔');
      } else {
        showToast('Erro: ' + (j.error||'desconhecido'), false);
      }
    } catch (e){
      showToast('Falha ao salvar', false);
    }
  };
</script>
</body>
</html>`);
});

// Salvar (aceita linhas ou JSON array)
app.post('/admin/save', auth, (req, res) => {
  try {
    const text = String(req.body.data || '');
    const links = parseAnyToLinks(text);
    saveLinks(links);
    return res.json({ ok: true, count: links.length });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`WhatsApp rotator rodando na porta ${PORT}`);
});

