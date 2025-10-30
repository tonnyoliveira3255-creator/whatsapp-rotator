// app.js — Rotador WhatsApp (sequencial + webhook)
// Runtime: Node 18+
// Env: DATABASE_URL, WEBHOOK_URL (opcional mas recomendado)

import express from "express";
import fetch from "node-fetch";           // para enviar ao webhook
import { Pool } from "pg";

const app = express();
const port = process.env.PORT || 10000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS links (
      id SERIAL PRIMARY KEY,
      url TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      clicks INTEGER NOT NULL DEFAULT 0,
      fails INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );

    -- cursor = índice do próximo link (0-based) entre os links ativos ordenados por id
    INSERT INTO meta (k, v)
    VALUES ('cursor', '0')
    ON CONFLICT (k) DO NOTHING;
  `);
}
initDB().catch(err => {
  console.error("Erro ao iniciar BD:", err);
  process.exit(1);
});

app.use(express.json());

// Utilitários
async function getActiveLinks(client) {
  const { rows } = await client.query(`SELECT id, url FROM links WHERE active = true ORDER BY id ASC`);
  return rows;
}

async function getCursor(client) {
  const { rows } = await client.query(`SELECT v FROM meta WHERE k = 'cursor'`);
  return parseInt(rows[0]?.v ?? "0", 10) || 0;
}

async function setCursor(client, n) {
  await client.query(`UPDATE meta SET v = $1 WHERE k = 'cursor'`, [String(n)]);
}

async function incrementClick(client, id) {
  await client.query(`UPDATE links SET clicks = clicks + 1, updated_at = NOW() WHERE id = $1`, [id]);
}

async function incrementFail(client, id) {
  await client.query(`UPDATE links SET fails = fails + 1, updated_at = NOW() WHERE id = $1`, [id]);
}

async function sendWebhook(payload) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // BotConversa recebe bem JSON simple
    });
  } catch (e) {
    console.error("Falha ao enviar webhook:", e.message);
  }
}

// Rota principal: redireciona para o PRÓXIMO link (sequencial)
app.get(["/", "/go"], async (req, res) => {
  const ip =
    req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";

  const userAgent = req.headers["user-agent"] || "";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // travar meta enquanto buscamos/atualizamos (evita concorrência)
    await client.query(`SELECT * FROM meta WHERE k = 'cursor' FOR UPDATE`);

    const links = await getActiveLinks(client);
    if (links.length === 0) {
      await client.query("ROLLBACK");
      return res.status(503).send("Sem links ativos configurados.");
    }

    let cursor = await getCursor(client);
    if (cursor >= links.length) cursor = 0;

    const chosen = links[cursor]; // {id, url}

    // avança o cursor para o próximo da fila (circular)
    const nextCursor = (cursor + 1) % links.length;
    await setCursor(client, nextCursor);

    await incrementClick(client, chosen.id);

    await client.query("COMMIT");

    // dispara webhook de forma assíncrona (não atrasa o redirect)
    sendWebhook({
      type: "click",
      link_id: chosen.id,
      url: chosen.url,
      cursor_used: cursor,
      next_cursor: nextCursor,
      ts: new Date().toISOString(),
      ip,
      user_agent: userAgent
    });

    return res.redirect(chosen.url);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Erro /go:", e);
    return res.status(500).send("Erro ao processar redirecionamento.");
  } finally {
    client.release();
  }
});

// Marcar falha (ex.: se um número estiver banido e você detectar pelo teu fluxo)
// Exemplo: /fail?id=123  (id do link que falhou)
app.post("/fail", async (req, res) => {
  const id = Number(req.query.id || req.body?.id);
  if (!id) return res.status(400).json({ ok: false, error: "id required" });
  try {
    await incrementFail(pool, id);
    sendWebhook({ type: "fail", link_id: id, ts: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// API simples pra gerenciar links (pode integrar com seu painel atual)
// Listar
app.get("/api/links", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, url, active, clicks, fails, created_at, updated_at FROM links ORDER BY id ASC`
  );
  res.json(rows);
});

// Criar
app.post("/api/links", async (req, res) => {
  const { url, active = true } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: "url required" });
  const { rows } = await pool.query(
    `INSERT INTO links (url, active) VALUES ($1, $2) RETURNING *`,
    [url, !!active]
  );
  res.json({ ok: true, link: rows[0] });
});

// Ativar/Desativar
app.patch("/api/links/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { active } = req.body || {};
  await pool.query(`UPDATE links SET active = COALESCE($1, active), updated_at = NOW() WHERE id = $2`, [active, id]);
  res.json({ ok: true });
});

// Remover
app.delete("/api/links/:id", async (req, res) => {
  const id = Number(req.params.id);
  await pool.query(`DELETE FROM links WHERE id = $1`, [id]);
  res.json({ ok: true });
});

// Saúde
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(port, () => {
  console.log(`Rotador WhatsApp sequencial ON na porta ${port}`);
});
