// app.js
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// File with WhatsApp links
const LINKS_FILE = path.join(__dirname, 'links.json');

function loadLinks() {
  try {
    const raw = fs.readFileSync(LINKS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error('links.json vazio ou inválido');
    }
    return arr;
  } catch (err) {
    console.error('Erro lendo links.json:', err.message);
    return [];
  }
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

app.get('/', (req, res) => {
  const links = loadLinks();
  if (!links.length) return res.status(500).send('Nenhum link configurado.');

  const target = pickRandom(links);

  // Preserve querystring (e.g., UTM) from incoming request
  const incomingQS = req.url.includes('?') ? req.url.split('?')[1] : '';
  const sep = target.includes('?') ? '&' : '?';
  const redirectTo = incomingQS ? `${target}${sep}${incomingQS}` : target;

  res.redirect(302, redirectTo);
});

app.get('/links', (req, res) => {
  res.json({ links: loadLinks() });
});

app.get('/health', (_, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log(`WhatsApp rotator rodando na porta ${PORT}`);
});
