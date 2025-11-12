// app.js — Rotador WhatsApp (round-robin por clique) - CommonJS
// Requisitos de ambiente (Render):
// - DATABASE_URL  -> URL do Postgres (com SSL)
// - ADMIN_PASSWORD -> senha do painel (ex.: algo forte)
// Porta: process.env.PORT ou 10000

const express = require("express");
const cookieParser = require("cookie-parser");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 10000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "troque-isto";
const BASE_WA = "https://wa.me/"; // link fixo (sem mensagem)

// --- Postgres ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Cria tabelas e estado do cursor (round-robin) se não existirem
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS links (
      id SERIAL PRIMARY KEY,
      number TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      clicks INTEGER NOT NULL DEFAULT 0,
      fails INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // Tabela de estado para guardar o "cursor" do round-robin
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rotator_state (
      id BOOLEAN PRIMARY KEY DEFAULT TRUE,
      cursor INTEGER NOT NULL DEFAULT 0
    );
  `);

  await pool.query(`
    INSERT INTO rotator_state (id, cursor)
    VALUES (TRUE, 0)
    ON CONFLICT (id) DO NOTHING;
  `);
}

// Pega próximo número ativo em round-robin (e já avança o cursor)
async function getNextActiveNumberAndBump() {
  const client = await pool.connect();
  try {
    const list = await client.query(
      `SELECT id, number FROM links WHERE active = TRUE ORDER BY id`
    );
    if (list.rows.length === 0) return null;

    const st = await client.query(`SELECT cursor FROM rotator_state WHERE id = TRUE`);
    let cursor = st.rows[0]?.cursor ?? 0;

    const index = cursor % list.rows.length;
    const chosen = list.rows[index];

    // Avança o cursor (com wrap)
    const nextCursor = (cursor + 1) % list.rows.length;

    await client.query(`UPDATE rotator_state SET cursor = $1 WHERE id = TRUE`, [nextCursor]);
    await client.query(`UPDATE links SET clicks = clicks + 1 WHERE id = $1`, [chosen.id]);

    return chosen.number;
  } finally {
    client.release();
  }
}

// --------- middlewares ----------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// Auth simples por cookie (30 dias)
function requireAuth(req, res, next) {
  if (req.cookies && req.cookies.ok === "1") return next();
  return res.redirect("/login");
}

// --------- rotas públicas ---------

// Redireciona para o próximo número (round-robin)
app.get("/", async (req, res) => {
  try {
    const number = await getNextActiveNumberAndBump();
    if (!number) {
      return res
        .status(200)
        .send(
          "<h3 style='font-family:system-ui'>Sem links ativos configurados.</h3>"
        );
    }
    return res.redirect(BASE_WA + number);
  } catch (err) {
    console.error("Erro no redirecionamento:", err);
    return res.status(500).send("Erro interno.");
  }
});

app.get("/health", (_req, res) => res.status(200).send("ok"));

// --------- login/logout ----------
app.get("/login", (_req, res) => {
  res.send(`<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Login • Rotador</title>
  <style>
    body{background:#0b0b0f;color:#eaeaea;font-family:system-ui,Arial;margin:0;display:grid;place-items:center;height:100dvh}
    form{background:#15151d;padding:24px;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.35);width:100%;max-width:360px}
    h1{margin:0 0 16px;font-size:20px}
    input[type=password]{width:100%;padding:12px;border:1px solid #2a2a3b;border-radius:10px;background:#0f0f15;color:#eaeaea}
    button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:10px;background:#8257e6;color:#fff;font-weight:600;cursor:pointer}
    small{color:#9aa0aa;display:block;margin-top:8px}
  </style>
</head>
<body>
  <form method="post" action="/login">
    <h1>Entrar</h1>
    <label>Senha do painel</label>
    <input type="password" name="password" placeholder="••••••••" autocomplete="current-password" required />
    <button type="submit">Acessar</button>
    <small>O acesso fica ativo por 30 dias neste dispositivo.</small>
  </form>
</body>
</html>`);
});

app.post("/login", (req, res) => {
  const pass = `${req.body?.password || ""}`;
  if (pass && pass === ADMIN_PASSWORD) {
    // cookie de 30 dias
    const maxAge = 30 * 24 * 60 * 60 * 1000;
    res.cookie("ok", "1", { httpOnly: true, sameSite: "lax", maxAge });
    return res.redirect("/admin");
  }
  return res.status(401).send("Senha incorreta.");
});

app.get("/logout", (_req, res) => {
  res.clearCookie("ok");
  res.redirect("/login");
});

// --------- painel (CRUD de números) ----------
app.get("/admin", requireAuth, async (_req, res) => {
  try {
    const list = await pool.query(
      `SELECT id, number, active, clicks, fails, created_at
       FROM links ORDER BY id`
    );

    const rows = list.rows
      .map(
        (r) => `
      <tr>
        <td>#${r.id}</td>
        <td><form method="post" action="/admin/edit/${r.id}" style="display:flex;gap:8px">
              <input name="number" value="${r.number}" pattern="\\d+" title="Somente números" required />
              <button>Salvar</button>
            </form>
        </td>
        <td>${r.active ? "🟢 ativo" : "⚪️ inativo"}</td>
        <td>${r.clicks}</td>
        <td style="min-width:200px">
          <form method="post" action="/admin/toggle/${r.id}" style="display:inline">
            <button>${r.active ? "Desativar" : "Ativar"}</button>
          </form>
          <form method="post" action="/admin/delete/${r.id}" style="display:inline;margin-left:6px" onsubmit="return confirm('Remover este número?');">
            <button style="background:#3b0d0d">Excluir</button>
          </form>
        </td>
      </tr>`
      )
      .join("");

    res.send(`<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Painel • Rotador</title>
  <style>
    :root{color-scheme:dark}
    body{background:#0b0b0f;color:#eaeaea;font-family:system-ui,Arial;margin:0;padding:24px}
    .card{background:#15151d;padding:20px;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.35);max-width:980px;margin:0 auto}
    h1{margin:0 0 16px;font-size:22px}
    table{width:100%;border-collapse:collapse;margin-top:16px}
    th,td{border-bottom:1px solid #232334;padding:10px;text-align:left}
    input{background:#0f0f15;border:1px solid #2a2a3b;border-radius:10px;color:#eaeaea;padding:10px}
    button{border:0;background:#8257e6;color:#fff;border-radius:10px;padding:10px 14px;cursor:pointer}
    .row{display:flex;gap:10px;flex-wrap:wrap}
    a{color:#9ecbff;text-decoration:none}
  </style>
</head>
<body>
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:center">
      <h1>Rotador • Números</h1>
      <div>
        <a href="/" target="_blank">Abrir link público ↗</a>
        &nbsp;•&nbsp;<a href="/logout">Sair</a>
      </div>
    </div>

    <form method="post" action="/admin/add" class="row" style="margin-top:8px">
      <input name="number" placeholder="Ex.: 5599987654321" pattern="\\d+" title="Somente números (com DDI/DD)" required />
      <button>Adicionar</button>
    </form>

    <table>
      <thead>
        <tr>
          <th>ID</th><th>Número</th><th>Status</th><th>Cliques</th><th>Ações</th>
        </tr>
      </thead>
      <tbody>
        ${rows || "<tr><td colspan='5'>Nenhum número cadastrado.</td></tr>"}
      </tbody>
    </table>

    <p style="margin-top:16px;color:#9aa0aa">Dica: o link público sempre redireciona para <code>wa.me/&lt;número&gt;</code>. No cadastro você informa apenas o número.</p>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error("Erro no admin:", err);
    res.status(500).send("Erro ao carregar painel.");
  }
});

// adiciona número (somente dígitos)
app.post("/admin/add", requireAuth, async (req, res) => {
  const raw = `${req.body?.number || ""}`;
  const number = raw.replace(/[^\d]/g, "");
  if (!number) return res.status(400).send("Número inválido.");
  await pool.query(`INSERT INTO links (number) VALUES ($1)`, [number]);
  res.redirect("/admin");
});

// editar número
app.post("/admin/edit/:id", requireAuth, async (req, res) => {
  const id = +req.params.id;
  const raw = `${req.body?.number || ""}`;
  const number = raw.replace(/[^\d]/g, "");
  if (!id || !number) return res.status(400).send("Dados inválidos.");
  await pool.query(`UPDATE links SET number = $1 WHERE id = $2`, [number, id]);
  res.redirect("/admin");
});

// alternar ativo/inativo
app.post("/admin/toggle/:id", requireAuth, async (req, res) => {
  const id = +req.params.id;
  if (!id) return res.status(400).send("ID inválido.");
  await pool.query(`UPDATE links SET active = NOT active WHERE id = $1`, [id]);
  res.redirect("/admin");
});

// remover número
app.post("/admin/delete/:id", requireAuth, async (req, res) => {
  const id = +req.params.id;
  if (!id) return res.status(400).send("ID inválido.");
  await pool.query(`DELETE FROM links WHERE id = $1`, [id]);
  res.redirect("/admin");
});

// ----- inicialização -----
initDB()
  .then(() => {
    app.listen(port, () => {
      console.log("Rotador WhatsApp rodando na porta", port);
    });
  })
  .catch((err) => {
    console.error("Falha ao iniciar DB:", err);
    process.exit(1);
  });
