// app.js
import express from "express";
import cookieParser from "cookie-parser";
import { Pool } from "pg";

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "troque-isto";
const BASE_WA = "https://wa.me/"; // link base fixo

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// ---------- auth (cookie 30 dias) ----------
function requireAuth(req, res, next) {
  if (req.cookies && req.cookies.auth === "ok") return next();
  return res.redirect("/login");
}

app.get("/login", (req, res) => {
  res.send(`
    <html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Login • Rotador</title>
      <style>
        body{background:#0b0b0f;color:#eaeaea;font-family:system-ui,Arial;margin:0;display:grid;place-items:center;height:100vh}
        form{background:#15151d;padding:24px;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.4);width:320px}
        h1{margin:0 0 16px;font-size:18px}
        input[type=password]{width:100%;padding:12px;border-radius:10px;border:1px solid #2b2b38;background:#0f0f16;color:#eaeaea}
        button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:10px;background:#7c3aed;color:#fff;font-weight:600}
        small{opacity:.7}
      </style>
    </head><body>
      <form method="POST" action="/login">
        <h1>Entrar no painel</h1>
        <label>Senha</label>
        <input name="password" type="password" required />
        <button type="submit">Entrar</button>
        <small>Manter logado por 30 dias</small>
      </form>
    </body></html>
  `);
});

app.post("/login", (req, res) => {
  const ok = req.body?.password?.trim() === ADMIN_PASSWORD;
  if (!ok) return res.status(401).send("Senha incorreta");
  // Cookie válido por 30 dias
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  res.cookie("auth", "ok", {
    httpOnly: true,
    sameSite: "lax",
    secure: true, // Render é HTTPS
    maxAge: THIRTY_DAYS,
  });
  res.redirect("/admin");
});

app.get("/logout", (req, res) => {
  res.clearCookie("auth");
  res.redirect("/login");
});

// ---------- página admin (somente número) ----------
app.get("/admin", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, phone, active, click_count FROM links ORDER BY id ASC"
  );

  const list = rows
    .map(
      (r) => `
      <tr>
        <td>${r.id}</td>
        <td>${r.phone}</td>
        <td>${r.active ? "✅" : "⛔️"}</td>
        <td>${r.click_count}</td>
        <td style="display:flex;gap:6px">
          <form method="POST" action="/admin/toggle/${r.id}">
            <button>${r.active ? "Pausar" : "Ativar"}</button>
          </form>
          <form method="POST" action="/admin/delete/${r.id}" onsubmit="return confirm('Apagar?')">
            <button style="background:#ef4444;color:#fff">Apagar</button>
          </form>
        </td>
      </tr>`
    )
    .join("");

  res.send(`
  <html><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>Painel • Rotador</title>
    <style>
      :root{--bg:#0b0b0f;--panel:#11121a;--card:#15151d;--text:#eaeaea;--muted:#8b8b99;--prime:#7c3aed}
      body{background:var(--bg);color:var(--text);font-family:system-ui,Arial;margin:0}
      header{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;background:var(--panel);position:sticky;top:0}
      h1{font-size:18px;margin:0}
      a.btn,button{border:0;background:var(--prime);color:#fff;padding:10px 14px;border-radius:12px;font-weight:600}
      main{padding:20px;max-width:920px;margin:0 auto}
      .card{background:var(--card);border-radius:16px;padding:16px}
      table{width:100%;border-collapse:collapse}
      th,td{padding:10px;border-bottom:1px solid #222235}
      input[type=text]{width:100%;padding:12px;border-radius:10px;border:1px solid #2b2b38;background:#0f0f16;color:var(--text)}
      .grid{display:grid;grid-template-columns:1fr;gap:12px}
      @media(min-width:720px){.grid{grid-template-columns:2fr 1fr}}
    </style>
  </head><body>
    <header>
      <h1>Rotador WhatsApp • House Mídia</h1>
      <div style="display:flex;gap:8px">
        <a class="btn" href="/logout">Sair</a>
      </div>
    </header>
    <main class="grid">
      <section class="card">
        <h2 style="margin-top:0">Números</h2>
        <table>
          <thead><tr><th>ID</th><th>Número</th><th>Status</th><th>Cliques</th><th>Ações</th></tr></thead>
          <tbody>${list || "<tr><td colspan='5'>Sem números ainda.</td></tr>"}</tbody>
        </table>
      </section>
      <section class="card">
        <h2 style="margin-top:0">Adicionar número</h2>
        <form method="POST" action="/admin/add">
          <label>Número (somente dígitos, ex.: 5599984546419)</label>
          <input name="phone" type="text" pattern="\\d{8,20}" required />
          <div style="margin-top:10px"><button type="submit">Adicionar</button></div>
        </form>
        <p style="color:var(--muted);margin-top:12px">
          O redirecionamento usa <code>${BASE_WA}&lt;número&gt;</code> automaticamente.
        </p>
      </section>
    </main>
  </body></html>
  `);
});

app.post("/admin/add", requireAuth, async (req, res) => {
  const phone = String(req.body?.phone || "").replace(/\D/g, "");
  if (!phone) return res.status(400).send("Número inválido.");
  await pool.query("INSERT INTO links (phone, active) VALUES ($1, true)", [phone]);
  res.redirect("/admin");
});

app.post("/admin/toggle/:id", requireAuth, async (req, res) => {
  await pool.query("UPDATE links SET active = NOT active WHERE id = $1", [req.params.id]);
  res.redirect("/admin");
});

app.post("/admin/delete/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM links WHERE id = $1", [req.params.id]);
  res.redirect("/admin");
});

// ---------- redirecionamento round-robin ----------
/*
   Estratégia: selecionar o PRÓXIMO id ativo com base em um cursor global.
   Para evitar corrida, usamos uma pequena transação com lock numa “tabela cursor” em memória DB.
   Como é simples, podemos fazer “pegar o menor id ativo maior que X; se não tiver, pega o menor ativo”.
*/

async function getNextActiveLink(client) {
  // Lê o maior id ativo para avançar de forma previsível
  const { rows: nextRows } = await client.query(`
    WITH last AS (
      SELECT COALESCE(MAX(id), 0) AS last_id FROM click_logs
    ),
    candidate AS (
      SELECT l.*
      FROM links l, last
      WHERE l.active = true AND l.id > last.last_id
      ORDER BY l.id ASC
      LIMIT 1
    )
    SELECT * FROM candidate
    UNION
    SELECT l.* FROM links l
    WHERE l.active = true
    ORDER BY id ASC
    LIMIT 1
  `);
  return nextRows[0] || null;
}

// Rota principal: cada clique vai pro próximo número e registra o clique
app.get("/", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const link = await getNextActiveLink(client);
    if (!link) {
      await client.query("ROLLBACK");
      return res.status(503).send("Sem links ativos configurados.");
    }

    await client.query(
      "INSERT INTO click_logs (link_id, client_ip) VALUES ($1, $2)",
      [link.id, req.headers["x-forwarded-for"] || req.socket.remoteAddress || null]
    );
    await client.query(
      "UPDATE links SET click_count = click_count + 1 WHERE id = $1",
      [link.id]
    );
    await client.query("COMMIT");

    // monta o link final
    const finalUrl = `${BASE_WA}${link.phone}`;
    return res.redirect(finalUrl);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Erro ao redirecionar:", e);
    return res.status(500).send("Erro no redirecionamento.");
  } finally {
    client.release();
  }
});

// health
app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Rotador WhatsApp na porta ${PORT}`);
});
