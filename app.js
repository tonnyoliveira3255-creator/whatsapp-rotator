// app.js – Painel rotativo WhatsApp
// Backend Node.js + Express + PostgreSQL
// Compatível com Render (CommonJS)

const express = require("express");
const cookieParser = require("cookie-parser");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 10000;

// 🔐 Senha de login do painel (definida em Environment da Render)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "troque-isto";

// 🔗 Base do link fixo
const BASE_WA = "https://wa.me/";

// 🌐 Conexão com banco PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// ───────────────  AUTENTICAÇÃO (cookie 30 dias) ───────────────
function requireAuth(req, res, next) {
  if (req.cookies && req.cookies.auth === "ok") return next();
  return res.redirect("/login");
}

app.get("/login", (req, res) => {
  res.send(`
  <html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Login • Painel Rotador</title>
    <style>
      body{background:#0b0b0b;color:#eee;font-family:Arial;margin:0;display:flex;justify-content:center;align-items:center;height:100vh;}
      form{background:#151515;padding:24px;border-radius:8px;box-shadow:0 0 20px rgba(0,0,0,0.3);width:280px;text-align:center;}
      input,button{width:100%;padding:10px;margin-top:10px;border:none;border-radius:4px;}
      button{background:#8257e5;color:#fff;cursor:pointer;font-weight:bold;}
    </style>
  </head>
  <body>
    <form method="POST" action="/login">
      <h3>Entrar no Painel</h3>
      <input type="password" name="password" placeholder="Senha" required>
      <button type="submit">Acessar</button>
    </form>
  </body>
  </html>`);
});

app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.cookie("auth", "ok", { maxAge: 1000 * 60 * 60 * 24 * 30 }); // 30 dias
    return res.redirect("/admin");
  }
  res.send("<script>alert('Senha incorreta!');window.location='/login'</script>");
});

// ───────────────  INICIALIZAÇÃO DO BANCO  ───────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS links (
      id SERIAL PRIMARY KEY,
      number TEXT NOT NULL,
      clicks INTEGER DEFAULT 0
    );
  `);
}
initDB();

// ───────────────  ROTA PRINCIPAL (ROTADOR) ───────────────
app.get("/", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM links ORDER BY id ASC");
  if (rows.length === 0) return res.send("Nenhum número cadastrado.");

  // Busca o próximo número a ser usado
  const current = parseInt(req.query.index || 0);
  const nextIndex = (current + 1) % rows.length;
  const number = rows[current].number;

  await pool.query("UPDATE links SET clicks = clicks + 1 WHERE id = $1", [rows[current].id]);
  res.redirect(`${BASE_WA}${number}?index=${nextIndex}`);
});

// ───────────────  PAINEL ADMIN  ───────────────
app.get("/admin", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM links ORDER BY id ASC");
  const table = rows.map(r => `
    <tr>
      <td>${r.id}</td>
      <td>${r.number}</td>
      <td>${r.clicks}</td>
    </tr>
  `).join("");

  res.send(`
  <html>
  <head><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Painel Rotador</title>
  <style>
    body{background:#0b0b0b;color:#eee;font-family:Arial;text-align:center;}
    table{margin:20px auto;border-collapse:collapse;width:80%;max-width:600px;}
    th,td{padding:10px;border:1px solid #333;}
    a{color:#8257e5;text-decoration:none;}
    input{padding:8px;width:80%;max-width:300px;margin-top:10px;}
    button{padding:8px 16px;background:#8257e5;color:white;border:none;border-radius:4px;cursor:pointer;}
  </style>
  </head>
  <body>
    <h2>📱 Painel Rotativo WhatsApp</h2>
    <form method="POST" action="/add">
      <input name="number" placeholder="Digite o número com DDD (somente dígitos)" required>
      <button type="submit">Adicionar número</button>
    </form>
    <table>
      <tr><th>ID</th><th>Número</th><th>Cliques</th></tr>
      ${table}
    </table>
    <p><a href="/logout">Sair</a></p>
  </body>
  </html>`);
});

// ───────────────  ADICIONAR NÚMERO ───────────────
app.post("/add", requireAuth, async (req, res) => {
  const number = req.body.number.replace(/\D/g, "");
  await pool.query("INSERT INTO links (number) VALUES ($1)", [number]);
  res.redirect("/admin");
});

// ───────────────  LOGOUT ───────────────
app.get("/logout", (req, res) => {
  res.clearCookie("auth");
  res.redirect("/login");
});

// ───────────────  START ───────────────
app.listen(port, () => {
  console.log(`✅ Servidor rodando na porta ${port}`);
});

