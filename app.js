// app.js — Rotador WhatsApp com painel admin simples (apenas números)
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Auth do Admin (Basic Auth) =====
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''; // DEFINA no Render!

// Arquivo de dados
const LINKS_FILE = path.join(__dirname, 'links.json');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---------- Utils de leitura/gravação ----------
function readRaw() {
  try {
    const raw = fs.readFileSync(LINKS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
function saveRaw(arr) {
  fs.writeFileSync(LINKS_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

// Converte lista que pode conter números OU URLs -> URLs wa.me
function toUrlList(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map(item => {
      if (typeof item === 'string') {
        const s = item.trim();
        // já é URL
        if (/^https?:\/\//i.test(s)) return s;
        // apenas dígitos (55DDDNUMERO)
        if (/^\d{10,15}$/.test(s)) return `https://wa.me/${s}`;
      }
      return null;
    })
    .filter(Boolean);
}

// Extrai os números (só dígitos) a partir do que estiver salvo
function listNumbers() {
  const raw = readRaw();
  // se estiver salvo como URLs, extrai o número do path
  if (Array.isArray(raw) && raw[0] && /^https?:\/\//i.test(raw[0])) {
    return raw
      .map(u => {
        try {
          const url = new URL(u);
          return url.pathname.replace(/\//g, '');
        } catch {
          return '';
        }
      })
      .filter(n => /^\d{10,15}$/.test(n));
  }
  // caso já estejam como números
  return (raw || []).filter(n => typeof n === 'string' && /^\d{10,15}$/.test(n));
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------- Middleware de auth ----------
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res
      .status(500)
      .send('Defina a variável ADMIN_PASSWORD no Render para acessar o /admin.');
  }
  const hdr = req.headers.authorization || '';
  if (!hdr.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Auth requerida');
  }
  const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
  const [user, pass] = decoded.split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASSWORD) return next();

  res.set('WWW-Authenticate', 'Basic realm="Admin"');
  return res.status(401).send('Credenciais inválidas');
}

// ---------- Rotas públicas ----------
app.get('/', (req, res) => {
  const urls = toUrlList(readRaw());
  if (!urls.length) return res.status(500).send('Nenhum número configurado.');

  const target = pickRandom(urls);

  // repassar querystring de entrada (ex: utm_source, text, etc.)
  const qs = req.url.includes('?') ? req.url.split('?')[1] : '';
  const sep = target.includes('?') ? '&' : '?';
  const redirectTo = qs ? `${target}${sep}${qs}` : target;

  res.redirect(302, redirectTo);
});

app.get('/links', (req, res) => res.json({ numbers: listNumbers(), urls: toUrlList(readRaw()) }));
app.get('/health', (_, res) => res.send('ok'));

// ---------- Painel Admin (apenas números) ----------
app.get('/admin', requireAdmin, (req, res) => {
  const numbers = listNumbers();
  const value = numbers.join('\n');

  res.send(`<!doctype html>
  <meta charset="utf-8">
  <title>Rotador WhatsApp — Admin</title>
  <div style="max-width:860px;margin:40px auto;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
    <h1 style="margin:0 0 12px">Rotador WhatsApp — Admin</h1>
    <p style="color:#666;margin:0 0 20px">
      Usuário: <b>${ADMIN_USER}</b> • Números no formato <code>55DDDNUMERO</code>, um por linha.
    </p>
    <form method="POST" action="/admin/save">
      <textarea name="numbers" required
        style="width:100%;height:260px;padding:12px;border:1px solid #ddd;border-radius:8px;font-family:ui-monospace,Consolas,monospace">${value}</textarea>
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
        <button style="padding:10px 16px;border:1px solid #111;background:#111;color:#fff;border-radius:8px">Salvar</button>
        <a href="/links" target="_blank" style="color:#06f;text-decoration:none">Ver JSON /links</a>
      </div>
    </form>
  </div>`);
});

app.post('/admin/save', requireAdmin, (req, res) => {
  const text = String(req.body.numbers || '');
  const lines = text.split('\n')
    .map(l => l.replace(/\D/g, ''))        // mantém só dígitos
    .filter(n => /^\d{10,15}$/.test(n));   // valida comprimento típico

  // salva como NÚMEROS (mais simples). O redirect converte para URL.
  saveRaw(lines);

  res.redirect('/admin');
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`WhatsApp rotator rodando na porta ${PORT}`);
});
