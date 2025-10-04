import express from "express";
import cors from "cors";
import { Pool } from "pg";

const app = express();
app.use(express.json());

// CORS
const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: corsOrigin }));

// PG pool (Neon)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Neon требует TLS
});

// Простой health
app.get("/ping", (req, res) => res.send("pong"));

// --- Вспомогательные функции ---

function sanitizeUsername(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  // Разрешаем буквы/цифры/подчёркивания/дефисы, длина 3..20
  if (!/^[A-Za-z0-9_\-]{3,20}$/.test(trimmed)) return null;
  return trimmed;
}

async function getOrCreateUser(deviceId, usernameOpt) {
  // 1) если пользователь уже есть по deviceId — вернём его
  {
    const { rows } = await pool.query(
      `SELECT id, device_id, username FROM users WHERE device_id = $1`,
      [deviceId]
    );
    if (rows.length > 0) return rows[0];
  }

  // 2) подготовим ник: из запроса или сгенерируем
  const base = sanitizeUsername(usernameOpt || "") || ("Player" + Math.floor(1000 + Math.random() * 9000));

  // 3) пробуем до 5 вариантов (добавляя суффикс), чтобы избежать уникального конфликта
  for (let i = 0; i < 5; i++) {
    const candidate = i === 0 ? base : `${base}${Math.floor(Math.random() * 1000)}`;

    try {
      const { rows } = await pool.query(
        `INSERT INTO users (device_id, username)
         VALUES ($1, $2)
         ON CONFLICT (device_id) DO UPDATE SET username = EXCLUDED.username
         RETURNING id, device_id, username`,
        [deviceId, candidate]
      );
      return rows[0];
    } catch (e) {
      // 23505 — уникальный конфликт по username: пробуем ещё
      if (e && e.code === '23505') continue;
      throw e;
    }
  }

  // если 5 попыток не хватило
  throw new Error("could_not_assign_username");
}

// --- Маршруты ---

// 1) Регистрация/апсерт пользователя
// POST /v1/user/upsert  { deviceId, username? }
app.post("/v1/user/upsert", async (req, res) => {
  try {
    const { deviceId, username } = req.body;
    if (!deviceId || typeof deviceId !== "string") {
      return res.status(400).json({ error: "deviceId is required" });
    }
    const user = await getOrCreateUser(deviceId, username);
    return res.json({ userId: user.id, username: user.username });
  } catch (e) {
    console.error("upsert error", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// 2) Смена ника
// POST /v1/user/username  { deviceId, newUsername }
app.post("/v1/user/username", async (req, res) => {
  try {
    const { deviceId, newUsername } = req.body;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    const uname = sanitizeUsername(newUsername);
    if (!uname) return res.status(400).json({ error: "bad_username" });

    const { rows: urows } = await pool.query(
      `SELECT id FROM users WHERE device_id = $1`,
      [deviceId]
    );
    if (urows.length === 0) return res.status(404).json({ error: "user_not_found" });
    const userId = urows[0].id;

    await pool.query(
      `UPDATE users SET username = $1 WHERE id = $2`,
      [uname, userId]
    );
    return res.json({ ok: true, username: uname });
  } catch (e) {
    if (String(e).includes("duplicate key value")) {
      return res.status(409).json({ error: "username_taken" });
    }
    console.error("username error", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// 3) Сабмит рейтинга/ачивок
// POST /v1/score/submit  { deviceId, mode: "classic"|"infinity", rating, achievementsTotal }
app.post("/v1/score/submit", async (req, res) => {
  try {
    const { deviceId, mode, rating, achievementsTotal } = req.body;
    if (!deviceId || !mode || typeof rating !== "number") {
      return res.status(400).json({ error: "deviceId, mode, rating required" });
    }
    if (!["classic", "infinity"].includes(mode)) {
      return res.status(400).json({ error: "bad_mode" });
    }

    const user = await getOrCreateUser(deviceId, null);
    const ach = Number.isFinite(achievementsTotal) ? Math.max(0, achievementsTotal) : 0;

    await pool.query(
      `INSERT INTO ratings (user_id, mode, rating, achievements_total)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, mode)
       DO UPDATE SET rating = EXCLUDED.rating, achievements_total = EXCLUDED.achievements_total, updated_at = now()`,
      [user.id, mode, rating, ach]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("submit error", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// 4) Топ-лист
// GET /v1/leaderboard/top?mode=classic&limit=10
app.get("/v1/leaderboard/top", async (req, res) => {
  try {
    const mode = (req.query.mode || "classic").toString();
    const limit = Math.min(parseInt(req.query.limit || "10", 10), 100);
    if (!["classic", "infinity"].includes(mode)) {
      return res.status(400).json({ error: "bad_mode" });
    }

    const { rows } = await pool.query(
      `
      WITH ranks AS (
        SELECT
          u.username,
          r.rating,
          r.achievements_total,
          ROW_NUMBER() OVER (ORDER BY r.rating DESC, u.created_at ASC, u.id ASC) AS rank
        FROM ratings r
        JOIN users u ON u.id = r.user_id
        WHERE r.mode = $1
      )
      SELECT * FROM ranks ORDER BY rank ASC LIMIT $2
      `,
      [mode, limit]
    );
    return res.json({ mode, rows });
  } catch (e) {
    console.error("top error", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// 5) «Рядом с тобой»
// GET /v1/leaderboard/around?mode=classic&deviceId=XXX&radius=3
app.get("/v1/leaderboard/around", async (req, res) => {
  try {
    const mode = (req.query.mode || "classic").toString();
    const deviceId = (req.query.deviceId || "").toString();
    const radius = Math.min(parseInt(req.query.radius || "3", 10), 25);

    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    if (!["classic", "infinity"].includes(mode)) {
      return res.status(400).json({ error: "bad_mode" });
    }

    const { rows: urows } = await pool.query(
      `SELECT id FROM users WHERE device_id = $1`,
      [deviceId]
    );
    if (urows.length === 0) return res.status(404).json({ error: "user_not_found" });
    const userId = urows[0].id;

    const { rows } = await pool.query(
      `
      WITH ranks AS (
        SELECT
          u.id as user_id,
          u.username,
          r.rating,
          r.achievements_total,
          ROW_NUMBER() OVER (ORDER BY r.rating DESC, u.created_at ASC, u.id ASC) AS rank
        FROM ratings r
        JOIN users u ON u.id = r.user_id
        WHERE r.mode = $1
      ),
      me AS (
        SELECT rank FROM ranks WHERE user_id = $2
      )
      SELECT * FROM ranks
      WHERE rank BETWEEN (SELECT rank FROM me) - $3 AND (SELECT rank FROM me) + $3
      ORDER BY rank ASC
      `,
      [mode, userId, radius]
    );

    return res.json({ mode, rows });
  } catch (e) {
    console.error("around error", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// PORT отдает Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Leaderboard API listening on port", PORT);
});

